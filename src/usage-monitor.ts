import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UsageConfig } from "./config.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { loadOrCreateUsageHealthToken } from "./usage-identity.js";
import { measurementFailureStatus, measureRequestPayload, measureResponsePayload } from "./usage-metrics.js";
import { openUsageStore } from "./usage-store.js";
import { safeTraceContext, type UsageTelemetrySink } from "./usage-telemetry.js";
import {
  PythonTokenizerClient,
  TokenizationQueue,
  type TokenizationResult,
} from "./usage-tokenizer.js";

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type ToolHandler<Arguments extends unknown[], Result> = (...args: Arguments) => Result | Promise<Result>;

export function instrumentMcpServer(
  server: McpServer,
  monitor: ReturnType<typeof createUsageMonitor> | undefined,
): void {
  if (!monitor) return;
  const mutableServer = server as McpServer & { registerTool: McpServer["registerTool"] };
  const registerTool = server.registerTool.bind(server);
  mutableServer.registerTool = ((name: string, config: unknown, handler: ToolHandler<unknown[], unknown>) =>
    (registerTool as unknown as (
      name: string,
      config: unknown,
      handler: ToolHandler<unknown[], unknown>,
    ) => unknown)(name, config, monitor.wrapHandler(name, handler))) as McpServer["registerTool"];
}

export function createUsageMonitor(
  config: UsageConfig,
  dependencies: {
    encode?: (text: string) => Promise<number>;
    identityKey?: Buffer;
    now?: () => number;
    telemetrySink?: UsageTelemetrySink;
  } = {},
) {
  const now = dependencies.now ?? Date.now;
  const store = openUsageStore(config.stateDir, {
    identityKey: dependencies.identityKey,
    workerSha256: config.workerSha256,
  });
  const healthToken = loadOrCreateUsageHealthToken(config.stateDir);
  const bootId = store.runtimeFacts().current_boot_id;
  const tokenizer = dependencies.encode
    ? undefined
    : new PythonTokenizerClient({
        pythonExecutable: config.pythonExecutable,
        workerPath: config.workerPath,
        workerSha256: config.workerSha256,
        cacheDirectory: join(config.stateDir, "tiktoken-cache"),
        requestTimeoutMs: config.requestTimeoutMs,
      });
  const encode = dependencies.encode ?? ((text: string) => tokenizer!.encode(text));
  let writerState: "ACTIVE" | "DEGRADED" | "STOPPED" = "ACTIVE";
  let closed = false;
  let lastSuccessfulWriteAtMs: number | null = now();
  let storageFailures = 0;
  const pendingTelemetry = new Map<string, {
    tool: string;
    outcome: "SUCCESS" | "ERROR";
    durationMs: number;
    remaining: number;
    statuses: string[];
    traceContext?: ReturnType<typeof safeTraceContext>;
  }>();
  const noteWrite = () => { lastSuccessfulWriteAtMs = now(); };
  const noteStorageFailure = () => {
    storageFailures += 1;
    writerState = "DEGRADED";
  };
  const emitTelemetry = (input: {
    tool: string;
    outcome: "SUCCESS" | "ERROR";
    durationMs: number;
    tokenCoverage: string;
    traceContext?: ReturnType<typeof safeTraceContext>;
  }) => {
    if (!dependencies.telemetrySink) return;
    try {
      dependencies.telemetrySink.emit({
        attributes: {
          "mcp.method.name": "tools/call",
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": input.tool,
          "mcp.server.operation.duration": input.durationMs,
          "devspace.usage.token_coverage": input.tokenCoverage,
          ...(input.outcome === "ERROR" ? { "error.type": "tool_error" as const } : {}),
        },
        ...(input.traceContext ? { traceContext: input.traceContext } : {}),
      });
    } catch {
      // Telemetry is optional and must never affect MCP or usage accounting.
    }
  };
  const completeTelemetry = (result: TokenizationResult) => {
    const pending = pendingTelemetry.get(result.eventId);
    if (!pending) return;
    pending.statuses.push(result.status);
    pending.remaining -= 1;
    if (pending.remaining > 0) return;
    pendingTelemetry.delete(result.eventId);
    const tokenCoverage = pending.statuses.every((status) => status === "AVAILABLE")
      ? "AVAILABLE"
      : pending.statuses.includes("PARTIAL_UNSUPPORTED_MEDIA")
        ? "PARTIAL_UNSUPPORTED_MEDIA"
        : pending.statuses.find((status) => status !== "AVAILABLE") ?? "UNKNOWN";
    emitTelemetry({ ...pending, tokenCoverage });
  };
  const onResult = (result: TokenizationResult) => {
    try {
      if (result.side) {
        store.setSideTokenCount({
          eventId: result.eventId,
          side: result.side,
          tokens: result.tokens ?? null,
          status: result.status,
        });
      } else {
        store.setTokenCounts({
          eventId: result.eventId,
          requestTokens: result.requestTokens ?? null,
          responseTokens: result.responseTokens ?? null,
          status: result.status,
        });
      }
      noteWrite();
    } catch {
      noteStorageFailure();
      // Measurement must never replace or delay the MCP tool result.
    } finally {
      completeTelemetry(result);
    }
  };
  const queue = new TokenizationQueue({
    encode,
    maxEventBytes: config.maxEventBytes,
    maxQueueBytes: config.maxQueueBytes,
    onResult,
  });
  const terminalWrites = new Set<Promise<void>>();
  const scheduleTerminalWrite = (write: () => void): void => {
    let scheduled!: Promise<void>;
    scheduled = new Promise((resolve) => {
      setImmediate(() => {
        try {
          write();
        } catch {
          noteStorageFailure();
        } finally {
          resolve();
        }
      });
    });
    terminalWrites.add(scheduled);
    void scheduled.finally(() => terminalWrites.delete(scheduled));
  };
  const waitForTerminalWrites = async (): Promise<void> => {
    while (terminalWrites.size > 0) {
      await Promise.all(Array.from(terminalWrites));
    }
  };
  const waitForRecordedWork = async (): Promise<void> => {
    while (true) {
      await waitForTerminalWrites();
      await queue.whenIdle();
      if (terminalWrites.size === 0) return;
    }
  };

  store.runRetention(now(), config.retentionDays);
  const retentionTimer = setInterval(() => {
    try {
      store.runRetention(now(), config.retentionDays);
      noteWrite();
    } catch {
      noteStorageFailure();
      // Health reporting will expose incomplete records; tool calls remain available.
    }
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref();
  const heartbeatTimer = setInterval(() => {
    try {
      store.heartbeat(now(), writerState === "ACTIVE" ? "ACTIVE" : "DEGRADED");
      noteWrite();
    } catch {
      noteStorageFailure();
      // Runtime health is exposed independently by the server.
    }
  }, 5_000);
  heartbeatTimer.unref();

  return {
    store,
    healthToken,
    wrapHandler<Arguments extends unknown[], Result>(
      tool: string,
      handler: ToolHandler<Arguments, Result>,
    ): ToolHandler<Arguments, Result> {
      return async (...args: Arguments) => {
        const eventId = randomUUID();
        const startedAtMs = now();
        const startedAtPerformance = performance.now();
        let recorded = false;
        let sessionRef = "UNATTRIBUTED";
        let traceContext: ReturnType<typeof safeTraceContext>;
        try {
          const extra = asRecord(args[1]);
          const meta = asRecord(extra?._meta);
          sessionRef = store.sessionRef(openAiConversationScopeId(meta));
          traceContext = safeTraceContext(meta);
        } catch {
          sessionRef = "UNATTRIBUTED";
        }
        try {
          recorded = store.startCallMinimal({
            eventId,
            tool,
            sessionRef,
            startedAtMs,
          });
          if (recorded) noteWrite();
        } catch {
          noteStorageFailure();
          recorded = false;
        }
        let request: ReturnType<typeof measureRequestPayload> | undefined;
        let requestMeasurementStatus: "MEASUREMENT_ERROR" | "MEASUREMENT_UNSUPPORTED" | undefined;
        if (recorded) {
          try {
            request = measureRequestPayload(args[0]);
          } catch (error) {
            requestMeasurementStatus = measurementFailureStatus(error);
          }
        }
        const persistTerminal = (input: {
          outcome: "SUCCESS" | "ERROR";
          durationMs: number;
          response?: ReturnType<typeof measureResponsePayload>;
          responseMeasurementStatus?: "MEASUREMENT_ERROR" | "MEASUREMENT_UNSUPPORTED";
        }): void => {
          scheduleTerminalWrite(() => {
            store.finishCall({
              eventId,
              request,
              requestMeasurementStatus,
              ...input,
            });
            noteWrite();
            const remaining = Number(Boolean(request)) + Number(Boolean(input.response));
            if (remaining > 0 && dependencies.telemetrySink) {
              const statuses = [
                ...(!request ? [requestMeasurementStatus ?? "UNKNOWN"] : []),
                ...(!input.response ? [input.responseMeasurementStatus ?? "UNKNOWN_RESPONSE"] : []),
              ];
              pendingTelemetry.set(eventId, {
                tool,
                outcome: input.outcome,
                durationMs: input.durationMs,
                remaining,
                statuses,
                ...(traceContext ? { traceContext } : {}),
              });
            } else if (dependencies.telemetrySink) {
              emitTelemetry({
                tool,
                outcome: input.outcome,
                durationMs: input.durationMs,
                tokenCoverage: input.responseMeasurementStatus ?? requestMeasurementStatus ?? "UNKNOWN",
                ...(traceContext ? { traceContext } : {}),
              });
            }
            if (request) {
              queue.enqueueSide({
                eventId,
                side: "request",
                text: request.tokenText,
                partial: request.tokenStatus === "PARTIAL_UNSUPPORTED_MEDIA",
              });
            }
            if (input.response) {
              queue.enqueueSide({
                eventId,
                side: "response",
                text: input.response.tokenText,
                partial: input.response.tokenStatus === "PARTIAL_UNSUPPORTED_MEDIA",
              });
            }
          });
        };

        try {
          const result = await handler(...args);
          if (!recorded) return result;
          const outcome = asRecord(result)?.isError === true ? "ERROR" : "SUCCESS";
          try {
            const response = measureResponsePayload(result);
            const durationMs = Math.max(0, Math.round(performance.now() - startedAtPerformance));
            persistTerminal({ outcome, durationMs, response });
          } catch (error) {
            const durationMs = Math.max(0, Math.round(performance.now() - startedAtPerformance));
            persistTerminal({
              outcome,
              durationMs,
              responseMeasurementStatus: measurementFailureStatus(error),
            });
          }
          return result;
        } catch (error) {
          if (recorded) {
            const durationMs = Math.max(0, Math.round(performance.now() - startedAtPerformance));
            persistTerminal({ outcome: "ERROR", durationMs });
          }
          throw error;
        }
      };
    },
    whenIdle: () => waitForRecordedWork(),
    runtimeHealth() {
      const queueStats = queue.stats();
      return {
        writer_state: writerState,
        boot_id: bootId,
        last_successful_write_at_ms: lastSuccessfulWriteAtMs,
        queue: {
          queued_bytes: queueStats.queuedBytes,
          queued_items: queueStats.queuedItems,
          active: queueStats.active,
          oldest_queued_age_ms: queueStats.oldestQueuedAgeMs,
        },
        last_tokenizer_success_at_ms: queueStats.lastSuccessAtMs,
        failure_counts: {
          storage: storageFailures,
          tokenizer: queueStats.failures - queueStats.dropped - queueStats.incomplete,
          dropped: queueStats.dropped,
          incomplete: queueStats.incomplete,
          by_reason: queueStats.failureReasons,
        },
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(retentionTimer);
      clearInterval(heartbeatTimer);
      await waitForTerminalWrites();
      await queue.close(config.shutdownTimeoutMs);
      tokenizer?.close();
      store.terminalizePending("SHUTDOWN_INCOMPLETE");
      store.close({ clean: true, nowMs: now() });
      writerState = "STOPPED";
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
