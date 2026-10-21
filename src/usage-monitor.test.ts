import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { measureRequestPayload, measureResponsePayload } from "./usage-metrics.js";
import {
  createUsageMonitor,
  instrumentMcpServer,
} from "./usage-monitor.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { IncomingArtifactAdapter } from "./incoming-artifacts.js";

const execFileAsync = promisify(execFile);

test("tool wrapper preserves the result while recording only numeric payload metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-monitor-test-"));
  const monitor = createUsageMonitor({
    enabled: true,
    stateDir: directory,
    pythonExecutable: "unused",
    workerPath: join(directory, "unused-worker.py"),
    workerSha256: "0".repeat(64),
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
    retentionDays: 90,
    maxEventBytes: 1024 * 1024,
    maxQueueBytes: 4 * 1024 * 1024,
  }, {
    encode: async (text) => Array.from(text).length,
    identityKey: Buffer.from("test-key"),
    now: () => Date.UTC(2026, 9, 18, 1),
  });

  try {
    const expected = {
      content: [{ type: "text", text: "RESPONSE-SECRET" }],
      structuredContent: { result: "RESPONSE-SECRET" },
      _meta: { hidden: "META-SECRET" },
    };
    const wrapped = monitor.wrapHandler("read", async (_input: unknown, _extra: unknown) => expected);
    const actual = await wrapped(
      { path: "REQUEST-SECRET" },
      { _meta: { "openai/session": "RAW-SESSION-SECRET" } },
    );
    assert.equal(actual, expected);
    await monitor.whenIdle();

    const calls = monitor.store.listCalls({ limit: 10 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tool, "read");
    assert.equal(calls[0]?.outcome, "SUCCESS");
    assert.equal(calls[0]?.token_status, "AVAILABLE");
    assert.ok((calls[0]?.request_tokens ?? 0) > 0);
    assert.ok((calls[0]?.response_tokens ?? 0) > 0);
    assert.match(calls[0]?.session_ref ?? "", /^w_[0-9a-f]{32}$/);

    const database = await readFile(join(directory, "usage.sqlite"));
    assert.doesNotMatch(
      database.toString("utf8"),
      /REQUEST-SECRET|RESPONSE-SECRET|META-SECRET|RAW-SESSION-SECRET/,
    );
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("tool wrapper records thrown handlers as incomplete without replacing the original error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-monitor-error-test-"));
  const monitor = createUsageMonitor({
    enabled: true,
    stateDir: directory,
    pythonExecutable: "unused",
    workerPath: join(directory, "unused-worker.py"),
    workerSha256: "0".repeat(64),
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
    retentionDays: 90,
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
  }, {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
    now: () => Date.UTC(2026, 9, 18, 1),
  });

  try {
    const original = new Error("original handler failure");
    const wrapped = monitor.wrapHandler("bash", async (_input: unknown, _extra: unknown) => { throw original; });
    await assert.rejects(
      () => wrapped({ command: "PRIVATE-COMMAND" }, { _meta: {} }),
      (error) => error === original,
    );
    await monitor.whenIdle();

    const call = monitor.store.listCalls({ limit: 1 })[0];
    assert.equal(call?.outcome, "ERROR");
    assert.equal(call?.response_bytes, null);
    assert.equal(call?.response_tokens, null);
    assert.ok((call?.request_tokens ?? 0) > 0);
    assert.equal(call?.request_token_status, "AVAILABLE");
    assert.equal(call?.response_token_status, "UNKNOWN_RESPONSE");
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP server instrumentation measures every registered tool without changing metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-registrar-test-"));
  const monitor = createUsageMonitor({
    enabled: true,
    stateDir: directory,
    pythonExecutable: "unused",
    workerPath: join(directory, "unused-worker.py"),
    workerSha256: "0".repeat(64),
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
    retentionDays: 90,
    maxEventBytes: 1024,
    maxQueueBytes: 4096,
  }, {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
  });
  let capturedName = "";
  let capturedConfig: unknown;
  let capturedHandler: ((input: unknown, extra: unknown) => Promise<unknown>) | undefined;
  const server = {
    registerTool(name: string, config: unknown, handler: typeof capturedHandler) {
      capturedName = name;
      capturedConfig = config;
      capturedHandler = handler;
      return { remove() {} };
    },
  };

  try {
    instrumentMcpServer(server as never, monitor);
    const config = { title: "Measured tool" };
    server.registerTool("measured_tool", config, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));

    assert.equal(capturedName, "measured_tool");
    assert.equal(capturedConfig, config);
    assert.ok(capturedHandler);
    await capturedHandler({}, { _meta: {} });
    await monitor.whenIdle();
    assert.equal(monitor.store.listCalls({ limit: 10 })[0]?.tool, "measured_tool");
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool wrapper treats an MCP isError result as an error without changing the result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-is-error-test-"));
  const monitor = createUsageMonitor(testConfig(directory), {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
  });
  try {
    const expected = { isError: true, content: [{ type: "text", text: "safe failure" }] };
    const wrapped = monitor.wrapHandler("bash", async (_input: unknown, _extra: unknown) => expected);
    assert.equal(await wrapped({}, { _meta: {} }), expected);
    await monitor.whenIdle();
    const call = monitor.store.listCalls({ limit: 1 })[0];
    assert.equal(call?.outcome, "ERROR");
    assert.equal(call?.request_token_status, "AVAILABLE");
    assert.equal(call?.response_token_status, "AVAILABLE");
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an isError result remains ERROR when response measurement itself fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-is-error-measurement-test-"));
  const monitor = createUsageMonitor(testConfig(directory), {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
  });
  try {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const expected = { isError: true, structuredContent: circular };
    const wrapped = monitor.wrapHandler("bash", async (_input: unknown, _extra: unknown) => expected);
    assert.equal(await wrapped({}, { _meta: {} }), expected);
    await monitor.whenIdle();
    const call = monitor.store.listCalls({ limit: 1 })[0];
    assert.equal(call?.outcome, "ERROR");
    assert.equal(call?.response_measurement_status, "MEASUREMENT_ERROR");
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime health exposes only bounded numeric writer state and queue facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-runtime-health-test-"));
  const monitor = createUsageMonitor(testConfig(directory), {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
    now: () => 1234,
  });
  try {
    const health = monitor.runtimeHealth();
    assert.equal(health.writer_state, "ACTIVE");
    assert.match(health.boot_id, /^[0-9a-f-]{36}$/);
    assert.equal(health.last_successful_write_at_ms, 1234);
    assert.deepEqual(health.queue, {
      queued_bytes: 0,
      queued_items: 0,
      active: false,
      oldest_queued_age_ms: null,
    });
    assert.deepEqual(health.failure_counts, {
      storage: 0,
      tokenizer: 0,
      dropped: 0,
      incomplete: 0,
      by_reason: {},
    });
    assert.equal(health.last_tokenizer_success_at_ms, null);
    assert.doesNotMatch(JSON.stringify(health), /test-key|session|payload/i);
    await monitor.close();
    assert.equal(monitor.runtimeHealth().writer_state, "STOPPED");
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("telemetry sink receives only low-cardinality MCP metadata and excludes baggage and payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-telemetry-test-"));
  const observations: unknown[] = [];
  const monitor = createUsageMonitor(testConfig(directory), {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
    now: () => 1234,
    telemetrySink: { emit: (observation) => observations.push(observation) },
  });
  try {
    const wrapped = monitor.wrapHandler("read", async (_input: unknown, _extra: unknown) => ({
      content: [{ type: "text", text: "PRIVATE-RESPONSE" }],
    }));
    await wrapped(
      { path: "PRIVATE-PATH" },
      { _meta: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
        baggage: "PRIVATE-BAGGAGE",
        "openai/session": "PRIVATE-SESSION",
      } },
    );
    await monitor.whenIdle();
    const duration = (observations[0] as {
      attributes?: Record<string, unknown>;
    })?.attributes?.["mcp.server.operation.duration"];
    assert.equal(Number.isInteger(duration), true);
    assert.equal(typeof duration === "number" && duration >= 0, true);
    assert.deepEqual(observations, [{
      attributes: {
        "mcp.method.name": "tools/call",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "read",
        "mcp.server.operation.duration": duration,
        "devspace.usage.token_coverage": "AVAILABLE",
      },
      traceContext: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
      },
    }]);
    assert.doesNotMatch(JSON.stringify(observations), /PRIVATE-(PATH|RESPONSE|BAGGAGE|SESSION)/);
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("telemetry keeps a thrown handler response UNKNOWN instead of overstating token coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-telemetry-error-test-"));
  const observations: Array<{ attributes: Record<string, unknown> }> = [];
  const monitor = createUsageMonitor(testConfig(directory), {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
    telemetrySink: { emit: (observation) => observations.push(observation) },
  });
  try {
    const wrapped = monitor.wrapHandler("read", async (_input: unknown, _extra: unknown) => {
      throw new Error("PRIVATE-HANDLER-ERROR");
    });
    await assert.rejects(wrapped({ path: "PRIVATE-PATH" }, { _meta: {} }), /PRIVATE-HANDLER-ERROR/);
    await monitor.whenIdle();
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.attributes["devspace.usage.token_coverage"], "UNKNOWN_RESPONSE");
    assert.equal(observations[0]?.attributes["error.type"], "tool_error");
    assert.doesNotMatch(JSON.stringify(observations), /PRIVATE-(PATH|HANDLER-ERROR)/);
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("monitor close remains bounded when a tokenizer side never settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-bounded-close-test-"));
  let releaseTokenizer!: () => void;
  let encodeCalls = 0;
  const monitor = createUsageMonitor({ ...testConfig(directory), shutdownTimeoutMs: 25 }, {
    encode: async () => {
      encodeCalls += 1;
      if (encodeCalls > 1) return 1;
      return new Promise<number>((resolve) => { releaseTokenizer = () => resolve(1); });
    },
    identityKey: Buffer.from("test-key"),
  });
  let closePromise: Promise<void> | undefined;
  try {
    const wrapped = monitor.wrapHandler("read", async (_input: unknown, _extra: unknown) => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await wrapped({ path: "fixture.txt" }, { _meta: {} });
    closePromise = monitor.close();
    const closed = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(closed, true);
  } finally {
    releaseTokenizer?.();
    await closePromise;
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool wrapper leaves a minimal row when request measurement fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-measurement-error-test-"));
  const monitor = createUsageMonitor(testConfig(directory), {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
  });
  try {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const wrapped = monitor.wrapHandler("read", async (_input: unknown, _extra: unknown) => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await wrapped(circular, { _meta: {} });
    await monitor.whenIdle();
    const call = monitor.store.listCalls({ limit: 1 })[0];
    assert.equal(call?.outcome, "SUCCESS");
    assert.equal(call?.request_measurement_status, "MEASUREMENT_ERROR");
    assert.equal(call?.request_token_status, "MEASUREMENT_ERROR");
    assert.equal(call?.response_token_status, "AVAILABLE");
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool wrapper marks non-JSON request instances as measurement unsupported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-measurement-unsupported-test-"));
  const monitor = createUsageMonitor(testConfig(directory), {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
  });
  try {
    const wrapped = monitor.wrapHandler("read", async (_input: unknown, _extra: unknown) => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await wrapped({ createdAt: new Date("2026-10-18T00:00:00Z") }, { _meta: {} });
    await monitor.whenIdle();
    const call = monitor.store.listCalls({ limit: 1 })[0];
    assert.equal(call?.request_measurement_status, "MEASUREMENT_UNSUPPORTED");
    assert.equal(call?.request_token_status, "MEASUREMENT_UNSUPPORTED");
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage storage initialization failure does not prevent server creation or tool calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-usage-init-failure-"));
  const invalidUsagePath = join(root, "usage.db");
  await writeFile(invalidUsagePath, "not a directory", "utf8");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_AGENT_DIR: join(root, "agent"),
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_WIDGETS: "off",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_USAGE_DIR: invalidUsagePath,
    DEVSPACE_USAGE_WORKER: join(root, "worker.py"),
    DEVSPACE_USAGE_WORKER_SHA256: "0".repeat(64),
    PORT: "1",
  });
  const registry = {
    openWorkspace: async () => ({
      workspace: { id: "ws_fixture", root, mode: "checkout", skills: [], skillDiagnostics: [], agentProfiles: [], activatedSkillDirs: new Set() },
      agentsFiles: [],
      availableAgentsFiles: [],
      workspaceReused: false,
      includeBootstrapContext: false,
    }),
  };
  const server = createMcpServer(
    config,
    registry as never,
    {
      initializeWorkspace: async () => {},
      reviewChanges: async () => ({
        result: "fixture",
        summary: { files: 0, additions: 0, removals: 0 },
        files: [],
        patch: "",
      }),
    },
    new ProcessSessionManager(),
    () => [],
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-init-failure-client", version: "1.0.0" });
  try {
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const result = await callTool(client, "open_workspace", { path: join(root, "project") });
    assert.notEqual(result.isError, true);
    assert.equal(asRecord(result.structuredContent)?.workspaceId, "ws_fixture");
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage storage write failure remains fail-open and visible in runtime health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-write-failure-"));
  const monitor = createUsageMonitor(testConfig(directory), {
    encode: async () => 1,
    identityKey: Buffer.from("test-key"),
  });
  try {
    monitor.store.startCallMinimal = () => {
      throw new Error("forced storage failure");
    };
    const wrapped = monitor.wrapHandler("read", async (_input: unknown, _extra: unknown) => ({
      content: [{ type: "text", text: "tool result remains available" }],
    }));
    const result = await wrapped({ path: "fixture.txt" }, { _meta: {} });
    assert.equal(result.content?.[0]?.text, "tool result remains available");
    const health = monitor.runtimeHealth();
    assert.equal(health.writer_state, "DEGRADED");
    assert.ok((health.failure_counts.storage ?? 0) > 0);
  } finally {
    await monitor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the central wrapper precedes all 13 enabled registerAppTool surfaces", async () => {
  const [serverSource, artifactSource] = await Promise.all([
    readFile(new URL("./server.ts", import.meta.url), "utf8"),
    readFile(new URL("./artifact-tools.ts", import.meta.url), "utf8"),
  ]);
  const registrations = (serverSource.match(/\bregisterAppTool\s*\(/g) ?? []).length
    + (artifactSource.match(/\bregisterAppTool\s*\(/g) ?? []).length;
  const createMcpServerSource = serverSource.slice(serverSource.indexOf("export function createMcpServer"));

  assert.equal(registrations, 13);
  assert.ok(
    createMcpServerSource.indexOf("instrumentMcpServer(server, usageMonitor)")
      < createMcpServerSource.indexOf("registerAppTool("),
  );
});

test("a real MCP client exercises every enabled full-mode tool through the usage recorder", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-usage-mcp-integration-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  const usageDir = join(root, ".usage");
  const configDir = join(root, ".config");
  const agentDir = join(root, "agent");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
  ]);
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n", "utf8");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n", "utf8");
  await writeFile(join(project, "fixture.txt"), "MCP fixture\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "devspace@example.com"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "DevSpace Test"], { cwd: project });
  await execFileAsync("git", ["add", "."], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "Initial fixture"], { cwd: project });

  const loaded = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "changes",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_ARTIFACTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const config = { ...loaded, usage: testConfig(usageDir) };
  const monitor = createUsageMonitor(config.usage, {
    encode: async (text) => Array.from(text).length,
    identityKey: Buffer.from("mcp-integration-key"),
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config, store),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
    monitor,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-usage-integration-client", version: "1.0.0" });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    await monitor.close();
    store.close();
  };

  try {
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["bash", "edit", "glob", "grep", "ls", "open_workspace", "read", "show_changes", "write"],
    );

    const observedResults = new Map<string, Awaited<ReturnType<typeof callTool>>>();
    const recordTool = async (tool: string, args: Record<string, unknown>) => {
      const result = await callTool(client, tool, args);
      observedResults.set(tool, result);
      return result;
    };

    const opened = await recordTool("open_workspace", { path: project });
    const workspaceId = String(asRecord(opened.structuredContent)?.workspaceId);
    assert.ok(workspaceId);

    const readArguments = { workspaceId, path: "fixture.txt" };
    const readResult = await recordTool("read", readArguments);
    await recordTool("write", {
      workspaceId,
      path: "created.txt",
      content: "created by fixture\n",
    });
    await recordTool("edit", {
      workspaceId,
      path: "created.txt",
      edits: [{ oldText: "fixture", newText: "edited" }],
    });
    await recordTool("grep", { workspaceId, pattern: "edited", path: "." });
    await recordTool("glob", { workspaceId, pattern: "*.txt", path: "." });
    await recordTool("ls", { workspaceId, path: "." });
    await recordTool("bash", { workspaceId, command: "node --version" });
    await recordTool("show_changes", { workspaceId });
    await monitor.whenIdle();

    const recordedCalls = monitor.store.listCalls({ limit: 100 });
    assert.equal(recordedCalls.length, 9);
    assert.deepEqual(
      recordedCalls.map((call) => call.tool).sort(),
      ["bash", "edit", "glob", "grep", "ls", "open_workspace", "read", "show_changes", "write"],
    );
    for (const call of recordedCalls) {
      assert.equal(call.outcome, observedResults.get(call.tool)?.isError ? "ERROR" : "SUCCESS");
      assert.equal(call.request_token_status, "AVAILABLE");
      assert.equal(call.response_token_status, "AVAILABLE");
    }

    const readRow = recordedCalls.find((call) => call.tool === "read");
    assert.ok(readRow);
    const expectedRequest = measureRequestPayload(readArguments);
    const expectedResponse = measureResponsePayload(readResult);
    assert.equal(readRow.request_bytes, expectedRequest.bytes);
    assert.equal(readRow.request_characters, expectedRequest.characters);
    assert.equal(readRow.response_bytes, expectedResponse.bytes);
    assert.equal(readRow.response_characters, expectedResponse.characters);

    const beforeError = recordedCalls.length;
    const toolError = await callTool(client, "read", { workspaceId, path: "missing.txt" });
    assert.equal(toolError.isError, true);
    await monitor.whenIdle();
    const isErrorRow = monitor.store.listCalls({ limit: 1 })[0];
    assert.equal(isErrorRow?.outcome, "ERROR");
    assert.equal(isErrorRow?.response_token_status, "AVAILABLE");

    const thrownResult = await callTool(client, "read", {
      workspaceId: "missing-workspace",
      path: "fixture.txt",
    });
    assert.equal(thrownResult.isError, true);
    const retryResult = await callTool(client, "read", {
      workspaceId: "missing-workspace",
      path: "fixture.txt",
    });
    assert.equal(retryResult.isError, true);
    await monitor.whenIdle();
    const thrownRows = monitor.store.listCalls({ limit: 2 }).filter((call) => (
      call.tool === "read" && call.outcome === "ERROR"
    ));
    assert.equal(thrownRows.length, 2);
    assert.notEqual(thrownRows[0]?.event_id, thrownRows[1]?.event_id);
    assert.ok(thrownRows.every((call) => call.response_token_status === "UNKNOWN_RESPONSE"));

    const beforeProtocolError = monitor.store.listCalls({ limit: 100 }).length;
    const protocolError = await client.callTool({
      name: "read",
      arguments: { workspaceId },
    } as Parameters<Client["callTool"]>[0]);
    const protocolContent = Array.isArray(protocolError.content) ? protocolError.content : [];
    assert.equal(protocolContent[0]?.type === "text"
      ? protocolContent[0].text.includes("path")
      : false, true);
    await monitor.whenIdle();
    assert.equal(monitor.store.listCalls({ limit: 100 }).length, beforeProtocolError);
    assert.equal(beforeProtocolError, beforeError + 3);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a real MCP client exercises every Codex-mode process and patch tool through the usage recorder", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-usage-codex-mcp-integration-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  const usageDir = join(root, ".usage");
  const configDir = join(root, ".config");
  const agentDir = join(root, "agent");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
  ]);
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n", "utf8");
  await writeFile(join(project, "fixture.txt"), "MCP fixture\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "devspace@example.com"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "DevSpace Test"], { cwd: project });
  await execFileAsync("git", ["add", "."], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "Initial fixture"], { cwd: project });

  const loaded = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "changes",
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_ARTIFACTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const config = { ...loaded, usage: testConfig(usageDir) };
  const monitor = createUsageMonitor(config.usage, {
    encode: async (text) => Array.from(text).length,
    identityKey: Buffer.from("codex-mcp-integration-key"),
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config, store),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
    monitor,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-usage-codex-client", version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["apply_patch", "exec_command", "open_workspace", "read", "show_changes", "write_stdin"],
    );

    const opened = await callTool(client, "open_workspace", { path: project });
    const workspaceId = String(asRecord(opened.structuredContent)?.workspaceId);
    assert.ok(workspaceId);
    await callTool(client, "read", { workspaceId, path: "fixture.txt" });
    await callTool(client, "apply_patch", {
      workspaceId,
      patch: "*** Begin Patch\n*** Add File: created.txt\n+created by MCP fixture\n*** End Patch",
    });
    const command = await callTool(client, "exec_command", {
      workspaceId,
      cmd: "node -e \"setTimeout(() => process.stdout.write('ready'), 50)\"",
      yieldTimeMs: 0,
    });
    const sessionId = Number(asRecord(command.structuredContent)?.sessionId);
    assert.ok(Number.isFinite(sessionId));
    await callTool(client, "write_stdin", { workspaceId, sessionId, yieldTimeMs: 200 });
    await callTool(client, "show_changes", { workspaceId });
    await monitor.whenIdle();

    const calls = monitor.store.listCalls({ limit: 20 });
    assert.deepEqual(
      calls.map((call) => call.tool).sort(),
      ["apply_patch", "exec_command", "open_workspace", "read", "show_changes", "write_stdin"],
    );
    assert.ok(calls.every((call) => call.outcome === "SUCCESS"));
    assert.ok(calls.every((call) => call.request_token_status === "AVAILABLE"));
    assert.ok(calls.every((call) => call.response_token_status === "AVAILABLE"));
  } finally {
    await client.close();
    await server.close();
    await monitor.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Linux MCP client records the native artifact handler exactly once", {
  skip: process.platform !== "linux",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-usage-artifact-mcp-integration-"));
  const project = join(root, "project");
  const stateDir = join(root, ".state");
  const usageDir = join(root, ".usage");
  const configDir = join(root, ".config");
  const agentDir = join(root, "agent");
  const artifactBytes = Buffer.from("synthetic artifact payload", "utf8");
  const artifactAdapter: IncomingArtifactAdapter = {
    id: "usage-test-file",
    canHandle: (value) => asRecord(value)?.file_id === "file_usage_test",
    async open() {
      return {
        name: "usage-fixture.txt",
        mimeType: "text/plain",
        size: artifactBytes.length,
        stream: Readable.from([artifactBytes]),
      };
    },
  };
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
  ]);
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n", "utf8");
  await writeFile(join(project, "fixture.txt"), "MCP fixture\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "devspace@example.com"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "DevSpace Test"], { cwd: project });
  await execFileAsync("git", ["add", "."], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "Initial fixture"], { cwd: project });

  const loaded = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_ARTIFACTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const config = { ...loaded, usage: testConfig(usageDir) };
  const monitor = createUsageMonitor(config.usage, {
    encode: async (text) => Array.from(text).length,
    identityKey: Buffer.from("artifact-mcp-integration-key"),
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const server = createMcpServer(
    config,
    new WorkspaceRegistry(config, store),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [artifactAdapter],
    monitor,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-usage-artifact-client", version: "1.0.0" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "download_artifact"));
    const opened = await callTool(client, "open_workspace", { path: project });
    const workspaceId = String(asRecord(opened.structuredContent)?.workspaceId);
    assert.ok(workspaceId);

    const downloadArguments = {
      workspaceId,
      path: "downloads/usage-fixture.txt",
      file: {
        download_url: "https://files.oaiusercontent.com/file_usage_test/download",
        file_id: "file_usage_test",
        mime_type: "text/plain",
        file_name: "usage-fixture.txt",
        size: artifactBytes.length,
      },
    };
    const result = await callTool(client, "download_artifact", downloadArguments);
    assert.deepEqual(asRecord(result.structuredContent), { path: "downloads/usage-fixture.txt" });
    assert.deepEqual(await readFile(join(project, "downloads", "usage-fixture.txt")), artifactBytes);
    await monitor.whenIdle();

    const calls = monitor.store.listCalls({ limit: 10 });
    const call = calls.find((entry) => entry.tool === "download_artifact");
    assert.ok(call);
    assert.equal(call.outcome, "SUCCESS");
    assert.equal(call.request_token_status, "AVAILABLE");
    assert.equal(call.response_token_status, "AVAILABLE");
    assert.equal(call.request_bytes, measureRequestPayload(downloadArguments).bytes);
    assert.equal(call.response_bytes, measureResponsePayload(result).bytes);
  } finally {
    await client.close();
    await server.close();
    await monitor.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function callTool(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name,
    arguments: argumentsValue,
    _meta: { "openai/session": "mcp-integration-session" },
  } as Parameters<Client["callTool"]>[0]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function testConfig(directory: string) {
  return {
    enabled: true,
    stateDir: directory,
    pythonExecutable: "unused",
    workerPath: join(directory, "unused-worker.py"),
    workerSha256: "0".repeat(64),
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
    retentionDays: 90,
    maxEventBytes: 1024 * 1024,
    maxQueueBytes: 4 * 1024 * 1024,
  };
}
