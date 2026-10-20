import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_CACHE_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";

export type TokenizationStatus =
  | "AVAILABLE"
  | "PARTIAL_UNSUPPORTED_MEDIA"
  | "PAYLOAD_TOO_LARGE"
  | "TOKENIZER_BACKPRESSURE"
  | "TOKENIZER_UNAVAILABLE"
  | "TOKENIZER_WORKER_STARTUP_ERROR"
  | "TOKENIZER_WORKER_EXIT"
  | "TOKENIZER_PROTOCOL_ERROR"
  | "TOKENIZER_ENCODE_ERROR"
  | "TOKENIZER_TIMEOUT"
  | "TOKENIZER_CIRCUIT_OPEN"
  | "SHUTDOWN_INCOMPLETE";

export interface TokenizationResult {
  eventId: string;
  status: TokenizationStatus;
  side?: "request" | "response";
  tokens?: number | null;
  requestTokens?: number | null;
  responseTokens?: number | null;
}

type AdmissionStatus = "ACCEPTED" | Exclude<TokenizationStatus, "AVAILABLE" | "PARTIAL_UNSUPPORTED_MEDIA">;

interface QueueBase { eventId: string; bytes: number; partial: boolean; enqueuedAtMs: number }
interface CombinedQueueItem extends QueueBase {
  kind: "combined";
  requestText: string;
  responseText: string;
}
interface SideQueueItem extends QueueBase {
  kind: "side";
  side: "request" | "response";
  text: string;
}
type QueueItem = CombinedQueueItem | SideQueueItem;

export class TokenizationQueue {
  private readonly encode: (text: string) => Promise<number>;
  private readonly maxEventBytes: number;
  private readonly maxQueueBytes: number;
  private readonly onResult: (result: TokenizationResult) => void;
  private readonly queue: QueueItem[] = [];
  private readonly emitted = new WeakSet<QueueItem>();
  private readonly released = new WeakSet<QueueItem>();
  private queuedBytes = 0;
  private running = false;
  private pumpScheduled = false;
  private closed = false;
  private active: QueueItem | undefined;
  private idleWaiters: Array<() => void> = [];
  private dropped = 0;
  private incomplete = 0;
  private failures = 0;
  private readonly failureReasons: Record<string, number> = {};
  private lastSuccessAtMs: number | null = null;

  constructor(options: {
    encode(text: string): Promise<number>;
    maxEventBytes: number;
    maxQueueBytes: number;
    onResult(result: TokenizationResult): void;
  }) {
    this.encode = options.encode;
    this.maxEventBytes = options.maxEventBytes;
    this.maxQueueBytes = options.maxQueueBytes;
    this.onResult = options.onResult;
  }

  enqueue(input: Omit<CombinedQueueItem, "kind" | "bytes" | "enqueuedAtMs">): AdmissionStatus {
    const bytes = Buffer.byteLength(input.requestText, "utf8")
      + Buffer.byteLength(input.responseText, "utf8");
    return this.admit({ ...input, kind: "combined", bytes, enqueuedAtMs: Date.now() });
  }

  enqueueSide(input: Omit<SideQueueItem, "kind" | "bytes" | "enqueuedAtMs">): AdmissionStatus {
    return this.admit({
      ...input,
      kind: "side",
      bytes: Buffer.byteLength(input.text, "utf8"),
      enqueuedAtMs: Date.now(),
    });
  }

  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stats() {
    const queuedAt = [this.active, ...this.queue]
      .filter((item): item is QueueItem => item !== undefined)
      .map((item) => item.enqueuedAtMs);
    return {
      queuedBytes: this.queuedBytes,
      queuedItems: this.queue.length,
      active: Boolean(this.active),
      closed: this.closed,
      dropped: this.dropped,
      incomplete: this.incomplete,
      failures: this.failures,
      failureReasons: { ...this.failureReasons },
      lastSuccessAtMs: this.lastSuccessAtMs,
      oldestQueuedAgeMs: queuedAt.length === 0
        ? null
        : Math.max(0, Date.now() - Math.min(...queuedAt)),
    };
  }

  async close(timeoutMs = 5_000): Promise<void> {
    this.closed = true;
    if (!this.running && this.queue.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      this.whenIdle().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (completed) return;
    if (this.active) {
      const active = this.active;
      this.emitFailure(active, "SHUTDOWN_INCOMPLETE");
      this.release(active);
      this.active = undefined;
    }
    for (const item of this.queue.splice(0)) {
      this.emitFailure(item, "SHUTDOWN_INCOMPLETE");
      this.release(item);
    }
  }

  private admit(item: QueueItem): AdmissionStatus {
    if (this.closed) {
      this.emitFailure(item, "SHUTDOWN_INCOMPLETE");
      return "SHUTDOWN_INCOMPLETE";
    }
    if (item.bytes > this.maxEventBytes) {
      this.emitFailure(item, "PAYLOAD_TOO_LARGE");
      return "PAYLOAD_TOO_LARGE";
    }
    if (this.queuedBytes + item.bytes > this.maxQueueBytes) {
      this.emitFailure(item, "TOKENIZER_BACKPRESSURE");
      return "TOKENIZER_BACKPRESSURE";
    }
    this.queue.push(item);
    this.queuedBytes += item.bytes;
    // Let the handler's promise settle before a worker can verify files or
    // stringify tokenizer input. A coalesced macrotask also avoids adding one
    // scheduler callback per request while a worker is already draining.
    this.schedulePump();
    return "ACCEPTED";
  }

  private schedulePump(): void {
    if (this.running || this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;
        this.active = item;
        try {
          if (item.kind === "side") {
            const tokens = await this.encode(item.text);
            this.lastSuccessAtMs = Date.now();
            this.emitOnce(item, {
              eventId: item.eventId,
              side: item.side,
              tokens,
              status: item.partial ? "PARTIAL_UNSUPPORTED_MEDIA" : "AVAILABLE",
            });
          } else {
            const requestTokens = await this.encode(item.requestText);
            const responseTokens = await this.encode(item.responseText);
            this.lastSuccessAtMs = Date.now();
            this.emitOnce(item, {
              eventId: item.eventId,
              requestTokens,
              responseTokens,
              status: item.partial ? "PARTIAL_UNSUPPORTED_MEDIA" : "AVAILABLE",
            });
          }
        } catch (error) {
          this.emitFailure(item, tokenizationErrorCode(error));
          if (tokenizationErrorCode(error) === "TOKENIZER_CIRCUIT_OPEN" && this.queue.length > 0) {
            const remaining = this.queue.splice(0);
            for (const pending of remaining) {
              this.emitFailure(pending, "TOKENIZER_CIRCUIT_OPEN");
              this.release(pending);
            }
          }
        } finally {
          this.release(item);
          if (this.active === item) this.active = undefined;
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private release(item: QueueItem): void {
    if (this.released.has(item)) return;
    this.released.add(item);
    this.queuedBytes = Math.max(0, this.queuedBytes - item.bytes);
  }

  private emitFailure(
    item: QueueItem,
    status: Exclude<TokenizationStatus, "AVAILABLE" | "PARTIAL_UNSUPPORTED_MEDIA">,
  ): void {
    this.failures += 1;
    this.failureReasons[status] = (this.failureReasons[status] ?? 0) + 1;
    if (status === "PAYLOAD_TOO_LARGE" || status === "TOKENIZER_BACKPRESSURE") this.dropped += 1;
    if (status === "SHUTDOWN_INCOMPLETE") this.incomplete += 1;
    this.emitOnce(item, item.kind === "side"
      ? { eventId: item.eventId, side: item.side, tokens: null, status }
      : { eventId: item.eventId, requestTokens: null, responseTokens: null, status });
  }

  private emitOnce(item: QueueItem, result: TokenizationResult): void {
    if (this.emitted.has(item)) return;
    this.emitted.add(item);
    this.onResult(result);
  }
}

interface PendingRequest {
  resolve(value: number): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class PythonTokenizerClient {
  private readonly pythonExecutable: string;
  private readonly workerPath: string;
  private readonly workerSha256: string;
  private readonly cacheDirectory: string;
  private readonly cacheSha256: string;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly maxFailuresBeforeCircuit: number;
  private readonly circuitResetMs: number;
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 0;
  private failures = 0;
  private circuitOpenedAt = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly readyProcesses = new WeakSet<ChildProcessWithoutNullStreams>();
  private ready: {
    process: ChildProcessWithoutNullStreams;
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
  } | undefined;
  spawnCount = 0;

  constructor(options: {
    pythonExecutable: string;
    workerPath: string;
    workerSha256: string;
    cacheDirectory: string;
    cacheSha256?: string;
    requestTimeoutMs: number;
    startupTimeoutMs?: number;
    maxFailuresBeforeCircuit?: number;
    circuitResetMs?: number;
  }) {
    if (!isAbsolute(options.workerPath)) throw new Error("Tokenizer worker path must be absolute");
    if (!isAbsolute(options.cacheDirectory)) throw new Error("Tokenizer cache path must be absolute");
    this.pythonExecutable = options.pythonExecutable;
    this.workerPath = options.workerPath;
    this.workerSha256 = options.workerSha256.toLowerCase();
    this.cacheDirectory = options.cacheDirectory;
    this.cacheSha256 = (options.cacheSha256 ?? DEFAULT_CACHE_SHA256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(this.workerSha256) || !/^[0-9a-f]{64}$/.test(this.cacheSha256)) {
      throw new Error("Tokenizer worker and cache hashes must be SHA-256 hex digests");
    }
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.startupTimeoutMs = options.startupTimeoutMs ?? options.requestTimeoutMs;
    this.maxFailuresBeforeCircuit = options.maxFailuresBeforeCircuit ?? 3;
    this.circuitResetMs = options.circuitResetMs ?? 60_000;
  }

  encode(text: string): Promise<number> {
    try {
      this.assertCircuitClosed();
      const child = this.ensureProcess();
      const id = ++this.nextId;
      return new Promise<number>((resolve, reject) => {
        this.whenReady(child).then(() => {
          const timer = setTimeout(() => {
            if (!this.pending.delete(id)) return;
            this.noteFailure();
            this.stopProcess(child);
            reject(tokenizerError("TOKENIZER_TIMEOUT"));
          }, this.requestTimeoutMs);
          timer.unref?.();
          this.pending.set(id, { resolve, reject, timer });
          child.stdin.write(`${JSON.stringify({ id, text })}\n`, "utf8", (error) => {
            if (!error) return;
            const pending = this.pending.get(id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(id);
            this.noteFailure();
            pending.reject(tokenizerError("TOKENIZER_WORKER_EXIT"));
          });
        }, (error) => {
          reject(error);
        });
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  close(): void {
    const child = this.process;
    this.process = undefined;
    if (child && !child.killed) child.kill();
    this.rejectAll(tokenizerError("TOKENIZER_WORKER_EXIT"));
  }

  private assertCircuitClosed(): void {
    if (this.failures < this.maxFailuresBeforeCircuit) return;
    if (Date.now() - this.circuitOpenedAt >= this.circuitResetMs) {
      this.failures = 0;
      this.circuitOpenedAt = 0;
      return;
    }
    throw tokenizerError("TOKENIZER_CIRCUIT_OPEN");
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) return this.process;
    this.verifyWorker();
    const child = spawn(this.pythonExecutable, [
      this.workerPath,
      `--expected-cache-sha256=${this.cacheSha256}`,
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TIKTOKEN_CACHE_DIR: this.cacheDirectory,
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
      },
    });
    this.spawnCount += 1;
    this.process = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.resume();
    const fail = () => {
      if (this.process !== child) return;
      this.process = undefined;
      const code = this.readyProcesses.has(child)
        ? "TOKENIZER_WORKER_EXIT" as const
        : "TOKENIZER_WORKER_STARTUP_ERROR" as const;
      this.ready?.reject(tokenizerError(code));
      this.ready = undefined;
      this.noteFailure();
      this.rejectAll(tokenizerError(code));
    };
    child.on("error", fail);
    child.on("exit", fail);
    return child;
  }

  private whenReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.readyProcesses.has(child)) return Promise.resolve();
    if (!this.ready || this.ready.process !== child) {
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolveReady = resolvePromise;
        rejectReady = rejectPromise;
      });
      promise.catch(() => {
        // Callers observe failure; this guard prevents idle rejection from being unhandled.
      });
      const timer = setTimeout(() => {
        if (this.ready?.process !== child) return;
        this.ready = undefined;
        this.noteFailure();
        rejectReady(tokenizerError("TOKENIZER_WORKER_STARTUP_ERROR"));
        this.stopProcess(child);
      }, this.startupTimeoutMs);
      timer.unref?.();
      this.ready = {
        process: child,
        promise,
        resolve: () => {
          clearTimeout(timer);
          resolveReady();
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectReady(error);
        },
      };
    }
    return this.ready?.process === child
      ? this.ready.promise
      : Promise.reject(tokenizerError("TOKENIZER_WORKER_STARTUP_ERROR"));
  }

  private verifyWorker(): void {
    try {
      const actual = createHash("sha256").update(readFileSync(this.workerPath)).digest("hex");
      if (actual !== this.workerSha256) throw new Error("hash mismatch");
    } catch {
      this.noteFailure();
      throw tokenizerError("TOKENIZER_WORKER_STARTUP_ERROR");
    }
  }

  private handleLine(line: string): void {
    let response: { ready?: unknown; id?: unknown; tokens?: unknown; error?: unknown };
    try {
      response = JSON.parse(line) as typeof response;
    } catch {
      this.noteFailure();
      this.rejectAll(tokenizerError("TOKENIZER_PROTOCOL_ERROR"));
      if (this.process) this.stopProcess(this.process);
      return;
    }
    const child = this.process;
    const ready = this.ready;
    if (response.ready === true && child) {
      this.readyProcesses.add(child);
      if (ready && ready.process === child) {
        this.ready = undefined;
        ready.resolve();
      }
      return;
    }
    if (!Number.isInteger(response.id)) return;
    const id = response.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (Number.isInteger(response.tokens) && (response.tokens as number) >= 0) {
      this.failures = 0;
      this.circuitOpenedAt = 0;
      pending.resolve(response.tokens as number);
      return;
    }
    this.noteFailure();
    pending.reject(tokenizerError("TOKENIZER_ENCODE_ERROR"));
  }

  private stopProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.process === child) this.process = undefined;
    if (this.ready?.process === child) {
      this.ready.reject(tokenizerError("TOKENIZER_WORKER_EXIT"));
      this.ready = undefined;
    }
    if (!child.killed) child.kill();
  }

  private noteFailure(): void {
    this.failures += 1;
    if (this.failures >= this.maxFailuresBeforeCircuit) this.circuitOpenedAt = Date.now();
  }

  private rejectAll(error: Error): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }
}

function tokenizerError(code: Exclude<TokenizationStatus, "AVAILABLE" | "PARTIAL_UNSUPPORTED_MEDIA">): Error {
  return Object.assign(new Error(code), { code });
}

function tokenizationErrorCode(
  error: unknown,
): Exclude<TokenizationStatus, "AVAILABLE" | "PARTIAL_UNSUPPORTED_MEDIA"> {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "TOKENIZER_TIMEOUT"
    || code === "TOKENIZER_CIRCUIT_OPEN"
    || code === "TOKENIZER_WORKER_STARTUP_ERROR"
    || code === "TOKENIZER_WORKER_EXIT"
    || code === "TOKENIZER_PROTOCOL_ERROR"
    || code === "TOKENIZER_ENCODE_ERROR"
    ? code
    : "TOKENIZER_UNAVAILABLE";
}
