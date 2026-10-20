import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  PythonTokenizerClient,
  TokenizationQueue,
  type TokenizationResult,
} from "./usage-tokenizer.js";

test("tokenization queue reports request and response counts without blocking enqueue", async () => {
  const results: TokenizationResult[] = [];
  const queue = new TokenizationQueue({
    encode: async (text) => Array.from(text).length,
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: (result) => results.push(result),
  });

  assert.equal(queue.enqueue({
    eventId: "evt-1",
    requestText: "请求",
    responseText: "response",
    partial: false,
  }), "ACCEPTED");
  await queue.whenIdle();

  assert.deepEqual(results, [{
    eventId: "evt-1",
    requestTokens: 2,
    responseTokens: 8,
    status: "AVAILABLE",
  }]);
});

test("tokenization admission returns before it invokes the tokenizer", async () => {
  let tokenizerInvoked = false;
  const queue = new TokenizationQueue({
    encode: async () => {
      tokenizerInvoked = true;
      return 1;
    },
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: () => {},
  });

  assert.equal(queue.enqueueSide({
    eventId: "evt-admission", side: "request", text: "payload", partial: false,
  }), "ACCEPTED");
  assert.equal(tokenizerInvoked, false);
  await queue.whenIdle();
  assert.equal(tokenizerInvoked, true);
});

test("tokenization admission does not run tokenizer work in the caller microtask turn", async () => {
  let tokenizerInvoked = false;
  const queue = new TokenizationQueue({
    encode: async () => {
      tokenizerInvoked = true;
      return 1;
    },
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: () => {},
  });

  assert.equal(queue.enqueueSide({
    eventId: "evt-macrotask", side: "request", text: "payload", partial: false,
  }), "ACCEPTED");
  await Promise.resolve();
  assert.equal(tokenizerInvoked, false);
  await queue.whenIdle();
  assert.equal(tokenizerInvoked, true);
});

test("tokenization queue keeps a successful count visibly partial for unsupported media", async () => {
  const results: TokenizationResult[] = [];
  const queue = new TokenizationQueue({
    encode: async () => 3,
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: (result) => results.push(result),
  });

  queue.enqueue({
    eventId: "evt-media",
    requestText: "request",
    responseText: "text-only-subset",
    partial: true,
  });
  await queue.whenIdle();

  assert.equal(results[0]?.status, "PARTIAL_UNSUPPORTED_MEDIA");
  assert.equal(results[0]?.requestTokens, 3);
  assert.equal(results[0]?.responseTokens, 3);
});

test("tokenization queue rejects oversized and backpressured work without invoking the tokenizer", async () => {
  const results: TokenizationResult[] = [];
  let resolveFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
  let calls = 0;
  const queue = new TokenizationQueue({
    encode: async (text) => {
      calls += 1;
      if (text === "hold") await firstGate;
      return 1;
    },
    maxEventBytes: 20,
    maxQueueBytes: 10,
    onResult: (result) => results.push(result),
  });

  assert.equal(queue.enqueue({
    eventId: "too-large",
    requestText: "x".repeat(21),
    responseText: "",
    partial: false,
  }), "PAYLOAD_TOO_LARGE");
  assert.equal(queue.enqueue({
    eventId: "first",
    requestText: "hold",
    responseText: "",
    partial: false,
  }), "ACCEPTED");
  assert.equal(queue.enqueue({
    eventId: "backpressure",
    requestText: "1234567",
    responseText: "",
    partial: false,
  }), "TOKENIZER_BACKPRESSURE");

  resolveFirst?.();
  await queue.whenIdle();
  assert.equal(calls, 2);
  assert.deepEqual(results.map((result) => [result.eventId, result.status]), [
    ["too-large", "PAYLOAD_TOO_LARGE"],
    ["backpressure", "TOKENIZER_BACKPRESSURE"],
    ["first", "AVAILABLE"],
  ]);
});

test("tokenizer errors become TOKENIZER_UNAVAILABLE with null counts", async () => {
  const results: TokenizationResult[] = [];
  const queue = new TokenizationQueue({
    encode: async () => { throw new Error("worker offline"); },
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: (result) => results.push(result),
  });

  queue.enqueue({ eventId: "evt-error", requestText: "x", responseText: "y", partial: false });
  await queue.whenIdle();

  assert.deepEqual(results, [{
    eventId: "evt-error",
    requestTokens: null,
    responseTokens: null,
    status: "TOKENIZER_UNAVAILABLE",
  }]);
});

test("tokenization queue records request and response sides independently", async () => {
  const results: TokenizationResult[] = [];
  const queue = new TokenizationQueue({
    encode: async (text) => text === "request" ? 3 : 5,
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: (result) => results.push(result),
  });

  assert.equal(queue.enqueueSide({
    eventId: "evt-sides",
    side: "request",
    text: "request",
    partial: false,
  }), "ACCEPTED");
  assert.equal(queue.enqueueSide({
    eventId: "evt-sides",
    side: "response",
    text: "response",
    partial: true,
  }), "ACCEPTED");
  await queue.whenIdle();

  assert.deepEqual(results, [
    { eventId: "evt-sides", side: "request", tokens: 3, status: "AVAILABLE" },
    { eventId: "evt-sides", side: "response", tokens: 5, status: "PARTIAL_UNSUPPORTED_MEDIA" },
  ]);
});

test("bounded queue shutdown terminalizes in-flight and queued sides exactly once", async () => {
  const results: TokenizationResult[] = [];
  const never = new Promise<number>(() => {});
  const queue = new TokenizationQueue({
    encode: async () => never,
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: (result) => results.push(result),
  });
  queue.enqueueSide({ eventId: "evt-one", side: "request", text: "one", partial: false });
  queue.enqueueSide({ eventId: "evt-two", side: "response", text: "two", partial: false });

  const started = Date.now();
  await queue.close(25);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(results, [
    { eventId: "evt-one", side: "request", tokens: null, status: "SHUTDOWN_INCOMPLETE" },
    { eventId: "evt-two", side: "response", tokens: null, status: "SHUTDOWN_INCOMPLETE" },
  ]);
  assert.equal(queue.enqueueSide({
    eventId: "evt-after-close", side: "request", text: "x", partial: false,
  }), "SHUTDOWN_INCOMPLETE");
  assert.deepEqual(queue.stats(), {
    queuedBytes: 0,
    queuedItems: 0,
    active: false,
    closed: true,
    dropped: 0,
    incomplete: 3,
    failures: 3,
    failureReasons: { SHUTDOWN_INCOMPLETE: 3 },
    lastSuccessAtMs: null,
    oldestQueuedAgeMs: null,
  });
});

test("Python tokenizer enforces an absolute worker path and verified worker hash", async () => {
  assert.throws(() => new PythonTokenizerClient({
    pythonExecutable: process.execPath,
    workerPath: "relative-worker.js",
    workerSha256: "0".repeat(64),
    cacheDirectory: resolve("cache"),
    requestTimeoutMs: 100,
  }), /absolute/);

  const directory = await mkdtemp(join(tmpdir(), "devspace-worker-hash-test-"));
  const workerPath = join(directory, "worker.js");
  try {
    await writeFile(workerPath, "process.stdin.resume();\n", "utf8");
    const client = new PythonTokenizerClient({
      pythonExecutable: process.execPath,
      workerPath,
      workerSha256: "0".repeat(64),
      cacheDirectory: directory,
      requestTimeoutMs: 100,
    });
    await assert.rejects(() => client.encode("PRIVATE"), (error) => (
      (error as { code?: string }).code === "TOKENIZER_WORKER_STARTUP_ERROR"
    ));
    client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Python tokenizer times out, restarts once, then opens its circuit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-worker-timeout-test-"));
  const workerPath = join(directory, "worker.js");
  try {
    await writeFile(workerPath, [
      "process.stdout.write('{\"ready\":true}\\n');",
      "process.stdin.resume();",
      "",
    ].join("\n"), "utf8");
    const workerSha256 = createHash("sha256").update(await readFile(workerPath)).digest("hex");
    const client = new PythonTokenizerClient({
      pythonExecutable: process.execPath,
      workerPath,
      workerSha256,
      cacheDirectory: directory,
      requestTimeoutMs: 25,
      startupTimeoutMs: 1_000,
      maxFailuresBeforeCircuit: 2,
      circuitResetMs: 60_000,
    });
    await assert.rejects(() => client.encode("one"), (error) => (
      (error as { code?: string }).code === "TOKENIZER_TIMEOUT"
    ));
    await assert.rejects(() => client.encode("two"), (error) => (
      (error as { code?: string }).code === "TOKENIZER_TIMEOUT"
    ));
    await assert.rejects(() => client.encode("three"), (error) => (
      (error as { code?: string }).code === "TOKENIZER_CIRCUIT_OPEN"
    ));
    assert.equal(client.spawnCount, 2);
    client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Python tokenizer classifies a worker encode rejection without exposing its message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-worker-encode-error-test-"));
  const workerPath = join(directory, "worker.js");
  try {
    await writeFile(workerPath, [
      "process.stdout.write('{\"ready\":true}\\n');",
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {});",
      "process.stdin.once('data', () => process.stdout.write('{\"id\":1,\"error\":\"PRIVATE-WORKER-MESSAGE\"}\\n'));",
      "",
    ].join("\n"), "utf8");
    const workerSha256 = createHash("sha256").update(await readFile(workerPath)).digest("hex");
    const client = new PythonTokenizerClient({
      pythonExecutable: process.execPath,
      workerPath,
      workerSha256,
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
    });
    await assert.rejects(() => client.encode("PRIVATE-PAYLOAD"), (error) => (
      (error as { code?: string; message?: string }).code === "TOKENIZER_ENCODE_ERROR"
      && !String((error as Error).message).includes("PRIVATE")
    ));
    client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Python tokenizer distinguishes startup exit, runtime exit and invalid protocol", async () => {
  const cases = [
    {
      name: "startup exit",
      source: "process.exit(2);\n",
      expected: "TOKENIZER_WORKER_STARTUP_ERROR",
    },
    {
      name: "runtime exit",
      source: [
        "process.stdout.write('{\"ready\":true}\\n');",
        "process.stdin.once('data', () => process.exit(2));",
        "",
      ].join("\n"),
      expected: "TOKENIZER_WORKER_EXIT",
    },
    {
      name: "invalid protocol",
      source: [
        "process.stdout.write('{\"ready\":true}\\n');",
        "process.stdin.once('data', () => process.stdout.write('not-json\\n'));",
        "",
      ].join("\n"),
      expected: "TOKENIZER_PROTOCOL_ERROR",
    },
  ];
  for (const fixture of cases) {
    const directory = await mkdtemp(join(tmpdir(), "devspace-worker-classification-test-"));
    const workerPath = join(directory, "worker.js");
    try {
      await writeFile(workerPath, fixture.source, "utf8");
      const workerSha256 = createHash("sha256").update(await readFile(workerPath)).digest("hex");
      const client = new PythonTokenizerClient({
        pythonExecutable: process.execPath,
        workerPath,
        workerSha256,
        cacheDirectory: directory,
        requestTimeoutMs: 1_000,
        startupTimeoutMs: 1_000,
      });
      await assert.rejects(() => client.encode("PRIVATE-PAYLOAD"), (error) => (
        (error as { code?: string }).code === fixture.expected
      ), fixture.name);
      client.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Python tokenizer circuit recovers only after the reset window and a real success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-worker-recovery-test-"));
  const workerPath = join(directory, "worker.js");
  try {
    await writeFile(workerPath, [
      "process.stdout.write('{\"ready\":true}\\n');",
      "let count = 0;",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  input += chunk;",
      "  const boundary = input.indexOf(String.fromCharCode(10));",
      "  if (boundary < 0) return;",
      "  const request = JSON.parse(input.slice(0, boundary));",
      "  input = input.slice(boundary + 1);",
      "  count += 1;",
      "  process.stdout.write(JSON.stringify(count === 1 ? { id: request.id, error: 'PRIVATE' } : { id: request.id, tokens: 2 }) + String.fromCharCode(10));",
      "});",
      "",
    ].join("\n"), "utf8");
    const workerSha256 = createHash("sha256").update(await readFile(workerPath)).digest("hex");
    const client = new PythonTokenizerClient({
      pythonExecutable: process.execPath,
      workerPath,
      workerSha256,
      cacheDirectory: directory,
      requestTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      maxFailuresBeforeCircuit: 1,
      circuitResetMs: 100,
    });
    await assert.rejects(() => client.encode("first"), (error) => (
      (error as { code?: string }).code === "TOKENIZER_ENCODE_ERROR"
    ));
    await assert.rejects(() => client.encode("blocked"), (error) => (
      (error as { code?: string }).code === "TOKENIZER_CIRCUIT_OPEN"
    ));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(await client.encode("recovered"), 2);
    assert.equal(client.spawnCount, 1);
    client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tokenization queue reports the oldest queued item age while work is blocked", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queue = new TokenizationQueue({
    encode: async () => { await gate; return 1; },
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: () => {},
  });
  queue.enqueueSide({ eventId: "age-one", side: "request", text: "one", partial: false });
  queue.enqueueSide({ eventId: "age-two", side: "response", text: "two", partial: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof queue.stats().oldestQueuedAgeMs, "number");
  assert.ok((queue.stats().oldestQueuedAgeMs ?? -1) >= 0);
  release();
  await queue.whenIdle();
});

test("an open tokenizer circuit drains queued items without waiting for each timeout", async () => {
  const results: TokenizationResult[] = [];
  let calls = 0;
  const queue = new TokenizationQueue({
    encode: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("circuit"), { code: "TOKENIZER_CIRCUIT_OPEN" });
      return 1;
    },
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
    onResult: (result) => results.push(result),
  });
  for (let index = 0; index < 5; index += 1) {
    queue.enqueueSide({ eventId: `event-${index}`, side: "request", text: "x", partial: false });
  }
  await queue.whenIdle();
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.status), Array(5).fill("TOKENIZER_CIRCUIT_OPEN"));
  assert.deepEqual(queue.stats(), {
    queuedBytes: 0,
    queuedItems: 0,
    active: false,
    closed: false,
    dropped: 0,
    incomplete: 0,
    failures: 5,
    failureReasons: { TOKENIZER_CIRCUIT_OPEN: 5 },
    lastSuccessAtMs: null,
    oldestQueuedAgeMs: null,
  });
});

test("Python tokenizer rejects a worker when the expected cache hash is malformed", async () => {
  assert.throws(() => new PythonTokenizerClient({
    pythonExecutable: process.execPath,
    workerPath: resolve("worker.js"),
    workerSha256: "a".repeat(64),
    cacheDirectory: resolve("cache"),
    cacheSha256: "not-a-sha256",
    requestTimeoutMs: 100,
  }), /must be SHA-256/);
});

test("Python tokenizer gives a worker a bounded startup and readiness handshake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-worker-startup-test-"));
  const workerPath = join(directory, "worker.js");
  try {
    await writeFile(workerPath, "process.stdin.resume();\n", "utf8");
    const workerSha256 = createHash("sha256").update(await readFile(workerPath)).digest("hex");
    const client = new PythonTokenizerClient({
      pythonExecutable: process.execPath,
      workerPath,
      workerSha256,
      cacheDirectory: directory,
      requestTimeoutMs: 25,
      startupTimeoutMs: 25,
      maxFailuresBeforeCircuit: 1,
    });
    await assert.rejects(() => client.encode("PRIVATE"), (error) => (
      (error as { code?: string }).code === "TOKENIZER_WORKER_STARTUP_ERROR"
    ));
    assert.equal(client.spawnCount, 1);
    client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Python worker counts text and reports malformed JSON without echoing payload", async () => {
  const fakeModuleDirectory = await mkdtemp(join(tmpdir(), "devspace-fake-tiktoken-"));
  try {
    await writeFile(join(fakeModuleDirectory, "tiktoken.py"), [
      "__version__ = '0.14.0'",
      "class Encoding:",
      "    def encode(self, text, *, disallowed_special):",
      "        assert disallowed_special == ()",
      "        return list(text)",
      "def get_encoding(name):",
      "    assert name == 'o200k_base'",
      "    return Encoding()",
      "",
    ].join("\n"), "utf8");

    const cache = await fakeCache(fakeModuleDirectory);
    const output = await runWorker(
      resolve("scripts/tiktoken-worker.py"),
      fakeModuleDirectory,
      '{"id":1,"text":"secret-正文"}\nnot-json\n',
      cache,
    );
    assert.equal(output.code, 0);
    const lines = output.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      { ready: true },
      { id: 1, tokens: 9 },
      { id: null, error: "JSONDecodeError" },
    ]);
    assert.doesNotMatch(output.stdout + output.stderr, /secret-正文/);
  } finally {
    await rm(fakeModuleDirectory, { recursive: true, force: true });
  }
});

test("Python worker refuses to start when its prewarmed encoding cache is missing", async () => {
  const fakeModuleDirectory = await mkdtemp(join(tmpdir(), "devspace-fake-tiktoken-missing-cache-"));
  try {
    await writeFile(join(fakeModuleDirectory, "tiktoken.py"), [
      "__version__ = '0.14.0'",
      "class Encoding:",
      "    def encode(self, text):",
      "        return list(text)",
      "def get_encoding(name):",
      "    return Encoding()",
      "",
    ].join("\n"), "utf8");
    const missingCache = join(fakeModuleDirectory, "missing-cache");
    await mkdir(missingCache);
    const output = await runWorker(
      resolve("scripts/tiktoken-worker.py"),
      fakeModuleDirectory,
      '{"id":1,"text":"TOP-SECRET"}\n',
      { directory: missingCache, expectedHash: "0".repeat(64) },
    );
    assert.notEqual(output.code, 0);
    assert.doesNotMatch(output.stdout + output.stderr, /TOP-SECRET/);
  } finally {
    await rm(fakeModuleDirectory, { recursive: true, force: true });
  }
});

test("Python worker refuses a corrupted prewarmed cache before touching the tokenizer", async () => {
  const fakeModuleDirectory = await mkdtemp(join(tmpdir(), "devspace-fake-tiktoken-corrupt-cache-"));
  try {
    const fetchMarker = join(fakeModuleDirectory, "get-encoding-was-called");
    await writeFile(join(fakeModuleDirectory, "tiktoken.py"), [
      "__version__ = '0.14.0'",
      "import pathlib",
      "def get_encoding(name):",
      `    pathlib.Path(${JSON.stringify(fetchMarker)}).write_text('called', encoding='utf-8')`,
      "    return object()",
      "",
    ].join("\n"), "utf8");
    const directory = join(fakeModuleDirectory, "cache");
    await mkdir(directory);
    const url = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken";
    const cacheKey = createHash("sha1").update(url).digest("hex");
    await writeFile(join(directory, cacheKey), "corrupted-cache", "utf8");

    const output = await runWorker(
      resolve("scripts/tiktoken-worker.py"),
      fakeModuleDirectory,
      '{"id":1,"text":"TOP-SECRET"}\n',
      { directory, expectedHash: "0".repeat(64) },
    );
    assert.notEqual(output.code, 0);
    assert.doesNotMatch(output.stdout + output.stderr, /TOP-SECRET/);
    await assert.rejects(() => readFile(fetchMarker));
  } finally {
    await rm(fakeModuleDirectory, { recursive: true, force: true });
  }
});

test("Python worker rejects a non-hex expected cache hash before touching the tokenizer", async () => {
  const fakeModuleDirectory = await mkdtemp(join(tmpdir(), "devspace-fake-tiktoken-nonhex-cache-"));
  try {
    const fetchMarker = join(fakeModuleDirectory, "get-encoding-was-called");
    await writeFile(join(fakeModuleDirectory, "tiktoken.py"), [
      "__version__ = '0.14.0'",
      "import pathlib",
      "def get_encoding(name):",
      `    pathlib.Path(${JSON.stringify(fetchMarker)}).write_text('called', encoding='utf-8')`,
      "    return object()",
      "",
    ].join("\n"), "utf8");
    const output = await runWorker(
      resolve("scripts/tiktoken-worker.py"),
      fakeModuleDirectory,
      '{"id":1,"text":"TOP-SECRET"}\n',
      { directory: fakeModuleDirectory, expectedHash: "g".repeat(64) },
    );
    assert.notEqual(output.code, 0);
    assert.doesNotMatch(output.stdout + output.stderr, /TOP-SECRET/);
    await assert.rejects(() => readFile(fetchMarker));
  } finally {
    await rm(fakeModuleDirectory, { recursive: true, force: true });
  }
});

test("Python worker refuses a tokenizer package version other than the pinned release", async () => {
  const fakeModuleDirectory = await mkdtemp(join(tmpdir(), "devspace-fake-tiktoken-version-"));
  try {
    await writeFile(join(fakeModuleDirectory, "tiktoken.py"), [
      "__version__ = '0.13.0'",
      "class Encoding:",
      "    def encode(self, text):",
      "        return list(text)",
      "def get_encoding(name):",
      "    return Encoding()",
      "",
    ].join("\n"), "utf8");
    const cache = await fakeCache(fakeModuleDirectory);
    const output = await runWorker(
      resolve("scripts/tiktoken-worker.py"),
      fakeModuleDirectory,
      '{"id":1,"text":"TOP-SECRET"}\n',
      cache,
    );
    assert.notEqual(output.code, 0);
    assert.doesNotMatch(output.stdout + output.stderr, /TOP-SECRET/);
  } finally {
    await rm(fakeModuleDirectory, { recursive: true, force: true });
  }
});

function runWorker(
  workerPath: string,
  pythonPath: string,
  input: string,
  cache: { directory: string; expectedHash: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const pythonExecutable = process.platform === "win32" ? "py" : "python3";
    const pythonArguments = process.platform === "win32" ? ["-3.11"] : [];
    const child = spawn(pythonExecutable, [
      ...pythonArguments,
      workerPath,
      `--expected-cache-sha256=${cache.expectedHash}`,
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        PYTHONUTF8: "1",
        TIKTOKEN_CACHE_DIR: cache.directory,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
async function fakeCache(parent: string): Promise<{ directory: string; expectedHash: string }> {
  const directory = join(parent, "cache");
  await mkdir(directory);
  const contents = Buffer.from("fake-prewarmed-o200k-cache", "utf8");
  const url = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken";
  const cacheKey = createHash("sha1").update(url).digest("hex");
  await writeFile(join(directory, cacheKey), contents);
  return {
    directory,
    expectedHash: createHash("sha256").update(contents).digest("hex"),
  };
}
