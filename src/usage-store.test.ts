import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";
import { measureRequestPayload, measureResponsePayload } from "./usage-metrics.js";
import {
  loadOrCreateUsageHealthToken,
  pseudonymizeSession,
  readUsageHealthToken,
} from "./usage-identity.js";
import { estimatorEpochFor, openUsageStore } from "./usage-store.js";

test("session attribution is deterministic and never returns the raw OpenAI session", () => {
  assert.equal(
    pseudonymizeSession("secret-session", Buffer.from("test-key")),
    "w_40ed34c864aede0d86e45cc0d6582b61",
  );
  assert.equal(pseudonymizeSession(undefined, Buffer.from("test-key")), "UNATTRIBUTED");
});

test("health capability token is local-only, stable and never the raw session key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-health-token-test-"));
  try {
    assert.equal(readUsageHealthToken(directory), null);
    const first = loadOrCreateUsageHealthToken(directory);
    const second = loadOrCreateUsageHealthToken(directory);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first, second);
    assert.equal(readUsageHealthToken(directory), first);
    assert.doesNotMatch(first, /raw-session|TOP-SECRET/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage store records one idempotent call without persisting payload or raw session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-store-test-"));
  const store = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"),
    bootId: "boot-record",
    nowMs: Date.UTC(2026, 9, 18, 0),
    workerSha256: "a".repeat(64),
  });
  try {
    const request = measureRequestPayload({ command: "TOP-SECRET-COMMAND" });
    const response = measureResponsePayload({
      content: [{ type: "text", text: "TOP-SECRET-RESULT" }],
      structuredContent: { result: "TOP-SECRET-RESULT" },
    });
    const sessionRef = store.sessionRef("raw-session-must-not-persist");

    assert.equal(store.startCall({
      eventId: "evt-1",
      tool: "bash",
      sessionRef,
      startedAtMs: Date.UTC(2026, 9, 18, 1),
      request,
    }), true);
    assert.equal(store.startCall({
      eventId: "evt-1",
      tool: "bash",
      sessionRef,
      startedAtMs: Date.UTC(2026, 9, 18, 1),
      request,
    }), false);

    store.finishCall({
      eventId: "evt-1",
      success: true,
      durationMs: 25,
      response,
    });
    store.setTokenCounts({
      eventId: "evt-1",
      requestTokens: 7,
      responseTokens: 11,
      status: "AVAILABLE",
    });

    const calls = store.listCalls({ limit: 10 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      sequence: 1,
      event_id: "evt-1",
      boot_id: "boot-record",
      started_at_ms: Date.UTC(2026, 9, 18, 1),
      finished_at_ms: Date.UTC(2026, 9, 18, 1) + 25,
      local_date: "2026-10-18",
      session_ref: "w_a4cf37cd8ed3f0d1c6531fabdbe351bb",
      attribution_status: "ATTRIBUTED",
      tool: "bash",
      outcome: "SUCCESS",
      duration_ms: 25,
      request_bytes: request.bytes,
      request_characters: request.characters,
      response_bytes: response.bytes,
      response_characters: response.characters,
      request_measurement_status: "AVAILABLE",
      response_measurement_status: "AVAILABLE",
      request_tokens: 7,
      response_tokens: 11,
      request_token_status: "AVAILABLE",
      response_token_status: "AVAILABLE",
      estimator_epoch: estimatorEpochFor("a".repeat(64)),
      token_status: "AVAILABLE",
    });

    const databaseBytes = await readFile(join(directory, "usage.sqlite"));
    const databaseText = databaseBytes.toString("utf8");
    assert.doesNotMatch(databaseText, /TOP-SECRET|raw-session-must-not-persist/);
    const reader = new Database(join(directory, "usage.sqlite"), { readonly: true });
    try {
      assert.deepEqual(
        Object.fromEntries(reader.prepare(`
          select key, value from usage_meta
          where key in ('estimator_cache_sha256', 'schema_version', 'algorithm_version')
        `).all().map((row) => Object.values(row as Record<string, string>))),
        {
          estimator_cache_sha256: "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d",
          schema_version: "3",
          algorithm_version: "mcp-visible-v3",
        },
      );
      assert.deepEqual(
        reader.prepare("select cache_status from usage_estimator_epochs where epoch_id = ?")
          .get(estimatorEpochFor("a".repeat(64))),
        { cache_status: "VERIFIED" },
      );
    } finally {
      reader.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention rolls old calls into daily summaries without changing all-time totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-retention-test-"));
  const store = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"),
    workerSha256: "a".repeat(64),
  });
  try {
    recordCompletedCall(store, "old", Date.UTC(2026, 5, 1), 3, 5);
    recordCompletedCall(store, "new", Date.UTC(2026, 9, 17), 7, 11);

    const before = store.summarizeAll();
    assert.deepEqual(before, {
      calls: 2,
      requestTokens: 10,
      responseTokens: 16,
      requestBytes: 2,
      responseBytes: 46,
    });

    assert.deepEqual(store.runRetention(Date.UTC(2026, 9, 18), 90), {
      rolledCalls: 1,
      deletedCalls: 1,
    });
    assert.equal(
      (readerCount(join(directory, "usage.sqlite"), "select value from usage_meta where key = 'retention_generation'")),
      "1",
    );
    assert.equal(store.listCalls({ limit: 10 }).length, 1);
    assert.deepEqual(store.summarizeAll(), before);
    const reader = new Database(join(directory, "usage.sqlite"), { readonly: true });
    try {
      assert.deepEqual(
        reader.prepare(`
          select request_token_known_calls, response_token_known_calls
          from usage_daily where local_date = '2026-06-01' and tool = 'read'
        `).get(),
        { request_token_known_calls: 1, response_token_known_calls: 1 },
      );
      assert.deepEqual(reader.prepare(`
        select key, value from usage_meta where key = 'last_maintenance_at_ms'
      `).get(), { key: "last_maintenance_at_ms", value: String(Date.UTC(2026, 9, 18)) });
    } finally {
      reader.close();
    }
    assert.deepEqual(store.runRetention(Date.UTC(2026, 9, 18), 90), {
      rolledCalls: 0,
      deletedCalls: 0,
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("minimal call rows survive request measurement failure with independent side statuses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-minimal-row-test-"));
  const store = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"),
    bootId: "boot-minimal",
    nowMs: Date.UTC(2026, 9, 18, 1),
  });
  try {
    assert.equal(store.startCallMinimal({
      eventId: "evt-measurement-error",
      tool: "read",
      sessionRef: "UNATTRIBUTED",
      startedAtMs: Date.UTC(2026, 9, 18, 1),
    }), true);
    store.failRequestMeasurement("evt-measurement-error");
    store.finishCall({
      eventId: "evt-measurement-error",
      outcome: "SUCCESS",
      durationMs: 2,
    });

    const call = store.listCalls({ limit: 1 })[0];
    assert.equal(call?.outcome, "SUCCESS");
    assert.equal(call?.request_bytes, null);
    assert.equal(call?.request_measurement_status, "MEASUREMENT_ERROR");
    assert.equal(call?.request_token_status, "MEASUREMENT_ERROR");
    assert.equal(call?.response_measurement_status, "UNKNOWN_RESPONSE");
    assert.equal(call?.response_token_status, "UNKNOWN_RESPONSE");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("finish persists a measured request with an unknown response in one terminal update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-finish-request-test-"));
  const store = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"), bootId: "boot-finish-request", nowMs: Date.UTC(2026, 9, 18),
  });
  try {
    assert.equal(store.startCallMinimal({
      eventId: "evt-terminal-request", tool: "read", sessionRef: "UNATTRIBUTED", startedAtMs: Date.UTC(2026, 9, 18),
    }), true);
    const request = measureRequestPayload({ text: "measured-before-handler" });
    store.finishCall({
      eventId: "evt-terminal-request",
      outcome: "ERROR",
      durationMs: 2,
      request,
    });

    const call = store.listCalls({ limit: 1 })[0];
    assert.equal(call?.request_bytes, request.bytes);
    assert.equal(call?.request_characters, request.characters);
    assert.equal(call?.request_measurement_status, "AVAILABLE");
    assert.equal(call?.request_token_status, "PENDING");
    assert.equal(call?.response_measurement_status, "UNKNOWN_RESPONSE");
    assert.equal(call?.response_token_status, "UNKNOWN_RESPONSE");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new boot interrupts stale boots and records a visible coverage gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-boot-gap-test-"));
  const first = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"),
    bootId: "boot-one",
    nowMs: 1_000,
  });
  first.heartbeat(2_000);
  first.close({ clean: false, nowMs: 2_000 });

  const second = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"),
    bootId: "boot-two",
    nowMs: 5_000,
  });
  try {
    const facts = second.runtimeFacts();
    assert.equal(facts.current_boot_id, "boot-two");
    assert.equal(facts.current_boot_status, "ACTIVE");
    assert.equal(facts.interrupted_boots, 1);
    assert.deepEqual(facts.gaps, [{ started_at_ms: 2_000, ended_at_ms: 5_000, reason: "INTERRUPTED" }]);
  } finally {
    second.close({ clean: true, nowMs: 6_000 });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean restart records the interval with no active writer as a coverage gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-clean-gap-test-"));
  const first = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"), bootId: "boot-clean-one", nowMs: 1_000,
  });
  first.close({ clean: true, nowMs: 2_000 });
  const second = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"), bootId: "boot-clean-two", nowMs: 5_000,
  });
  try {
    assert.deepEqual(second.runtimeFacts().gaps, [
      { started_at_ms: 2_000, ended_at_ms: 5_000, reason: "STOPPED" },
    ]);
  } finally {
    second.close({ clean: true, nowMs: 6_000 });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new boot marks stale in-progress calls INTERRUPTED without inventing a handler error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-interrupted-call-test-"));
  const first = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"), bootId: "boot-stale", nowMs: 1_000,
  });
  first.startCallMinimal({
    eventId: "stale-call", tool: "read", sessionRef: "UNATTRIBUTED", startedAtMs: 1_100,
  });
  first.setRequestMeasurement("stale-call", measureRequestPayload({ value: 1 }));
  first.close({ clean: false });

  const second = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"), bootId: "boot-next", nowMs: 2_000,
  });
  try {
    const call = second.listCalls({ limit: 1 })[0];
    assert.equal(call?.outcome, "INTERRUPTED");
    assert.equal(call?.finished_at_ms, 2_000);
    assert.equal(call?.request_token_status, "PROCESS_INTERRUPTED");
    assert.equal(call?.response_token_status, "PROCESS_INTERRUPTED");
  } finally {
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention preserves estimator epoch and every request and response status bucket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-retention-status-test-"));
  const store = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"),
    bootId: "boot-retention",
    nowMs: Date.UTC(2026, 5, 1),
    workerSha256: "a".repeat(64),
  });
  try {
    store.startCallMinimal({
      eventId: "old-partial",
      tool: "read",
      sessionRef: "UNATTRIBUTED",
      startedAtMs: Date.UTC(2026, 5, 1),
    });
    store.setRequestMeasurement("old-partial", measureRequestPayload({ value: 1 }));
    store.finishCall({
      eventId: "old-partial",
      outcome: "ERROR",
      durationMs: 4,
      response: measureResponsePayload({ content: [{ type: "image", data: "PRIVATE", mimeType: "image/png" }] }),
    });
    store.setSideTokenCount({ eventId: "old-partial", side: "request", tokens: 3, status: "AVAILABLE" });
    store.setSideTokenCount({ eventId: "old-partial", side: "response", tokens: 2, status: "PARTIAL_UNSUPPORTED_MEDIA" });
    store.runRetention(Date.UTC(2026, 9, 18), 90);

    const reader = new Database(join(directory, "usage.sqlite"), { readonly: true });
    try {
      assert.deepEqual(reader.prepare(`
        select outcome, request_token_status, response_token_status,
          estimator_epoch, call_count, request_token_known_calls, response_token_known_calls
        from usage_daily
      `).get(), {
        outcome: "ERROR",
        request_token_status: "AVAILABLE",
        response_token_status: "PARTIAL_UNSUPPORTED_MEDIA",
        estimator_epoch: estimatorEpochFor("a".repeat(64)),
        call_count: 1,
        request_token_known_calls: 1,
        response_token_known_calls: 1,
      });
      assert.deepEqual(reader.prepare(`
        select side, status, call_count from usage_daily_status order by side
      `).all(), [
        { side: "request", status: "AVAILABLE", call_count: 1 },
        { side: "response", status: "PARTIAL_UNSUPPORTED_MEDIA", call_count: 1 },
      ]);
    } finally {
      reader.close();
    }
  } finally {
    store.close({ clean: true, nowMs: Date.UTC(2026, 9, 18) });
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention preserves an all-unknown token bucket and a later restart remains usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-retention-null-token-test-"));
  const oldAt = Date.UTC(2026, 5, 1);
  const store = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"), bootId: "null-token-before", nowMs: oldAt,
  });
  try {
    store.startCall({
      eventId: "unknown-tokens", tool: "read", sessionRef: "UNATTRIBUTED", startedAtMs: oldAt,
      request: measureRequestPayload({ safe: true }),
    });
    store.finishCall({
      eventId: "unknown-tokens", success: true, durationMs: 1,
      response: measureResponsePayload({ structuredContent: { safe: true } }),
    });
    store.setSideTokenCount({
      eventId: "unknown-tokens", side: "request", tokens: null, status: "TOKENIZER_TIMEOUT",
    });
    store.setSideTokenCount({
      eventId: "unknown-tokens", side: "response", tokens: null, status: "TOKENIZER_TIMEOUT",
    });
    assert.deepEqual(store.runRetention(Date.UTC(2026, 9, 18), 90), {
      rolledCalls: 1,
      deletedCalls: 1,
    });
    const reader = new Database(join(directory, "usage.sqlite"), { readonly: true });
    try {
      assert.deepEqual(reader.prepare(`
        select request_tokens, response_tokens, request_token_known_calls, response_token_known_calls
        from usage_daily where local_date = '2026-06-01'
      `).get(), {
        request_tokens: null,
        response_tokens: null,
        request_token_known_calls: 0,
        response_token_known_calls: 0,
      });
    } finally {
      reader.close();
    }
  } finally {
    store.close({ clean: true, nowMs: Date.UTC(2026, 9, 18) });
  }

  const restarted = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"), bootId: "null-token-after", nowMs: Date.UTC(2026, 9, 19),
  });
  try {
    assert.equal(restarted.summarizeAll().calls, 1);
  } finally {
    restarted.close({ clean: true, nowMs: Date.UTC(2026, 9, 19) });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a changed worker hash creates a new estimator epoch and preserves historical provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-epoch-test-"));
  const firstHash = "a".repeat(64);
  const secondHash = "b".repeat(64);
  const first = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"),
    bootId: "boot-epoch-one",
    nowMs: 1_000,
    workerSha256: firstHash,
  });
  try {
    first.startCallMinimal({
      eventId: "epoch-one-call",
      tool: "read",
      sessionRef: "UNATTRIBUTED",
      startedAtMs: 1_100,
    });
    first.setSideTokenCount({
      eventId: "epoch-one-call", side: "request", tokens: 2, status: "AVAILABLE",
    });
  } finally {
    first.close({ clean: true, nowMs: 2_000 });
  }

  const second = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"),
    bootId: "boot-epoch-two",
    nowMs: 3_000,
    workerSha256: secondHash,
  });
  try {
    second.startCallMinimal({
      eventId: "epoch-two-call",
      tool: "read",
      sessionRef: "UNATTRIBUTED",
      startedAtMs: 3_100,
    });
    second.setSideTokenCount({
      eventId: "epoch-two-call", side: "request", tokens: 3, status: "AVAILABLE",
    });
  } finally {
    second.close({ clean: true, nowMs: 4_000 });
  }

  const reader = new Database(join(directory, "usage.sqlite"), { readonly: true });
  try {
    const epochs = reader.prepare(`
      select epoch_id, worker_sha256, cache_status
      from usage_estimator_epochs order by created_at_ms, epoch_id
    `).all() as Array<{ epoch_id: string; worker_sha256: string; cache_status: string }>;
    assert.equal(epochs.length, 2);
    assert.deepEqual(epochs.map((row) => row.worker_sha256), [firstHash, secondHash]);
    assert.deepEqual(epochs.map((row) => row.cache_status), ["VERIFIED", "VERIFIED"]);
    assert.deepEqual(
      reader.prepare("select event_id, estimator_epoch from usage_calls order by started_at_ms").all(),
      [
        { event_id: "epoch-one-call", estimator_epoch: estimatorEpochFor(firstHash) },
        { event_id: "epoch-two-call", estimator_epoch: estimatorEpochFor(secondHash) },
      ],
    );
  } finally {
    reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration backfills known-side counters for legacy daily facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-legacy-daily-test-"));
  const databasePath = join(directory, "usage.sqlite");
  const database = new Database(databasePath);
  try {
    database.exec(`
      create table usage_meta (key text primary key, value text not null);
      insert into usage_meta values ('schema_version', '2');
      create table usage_daily (
        local_date text not null, tool text not null, estimator_epoch text not null,
        outcome text not null, request_measurement_status text not null,
        response_measurement_status text not null, request_token_status text not null,
        response_token_status text not null, attribution_status text not null,
        call_count integer not null, request_bytes integer, response_bytes integer,
        request_characters integer, response_characters integer,
        request_byte_known_calls integer not null default 0,
        response_byte_known_calls integer not null default 0,
        request_character_known_calls integer not null default 0,
        response_character_known_calls integer not null default 0,
        request_tokens integer, response_tokens integer,
        request_token_known_calls integer not null default 0,
        response_token_known_calls integer not null default 0,
        duration_sum_ms integer not null, duration_known_calls integer not null,
        aggregated_at_ms integer not null,
        event_started_at_min_ms integer, event_started_at_max_ms integer
      );
    `);
    database.prepare(`
      insert into usage_daily values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2026-06-01", "read", "legacy-epoch", "SUCCESS", "AVAILABLE", "AVAILABLE",
      "AVAILABLE", "AVAILABLE", "ATTRIBUTED", 2, 100, 200, 90, 180,
      0, 0, 0, 0, 13, 17, 0, 0, 15, 2, Date.UTC(2026, 5, 2),
      Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 1, 1),
    );
  } finally {
    database.close();
  }

  const store = openUsageStore(directory, {
    identityKey: Buffer.from("test-key"), bootId: "legacy-daily", nowMs: Date.UTC(2026, 9, 18),
  });
  try {
    const reader = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(reader.prepare(`
        select request_byte_known_calls, response_byte_known_calls,
          request_character_known_calls, response_character_known_calls,
          request_token_known_calls, response_token_known_calls
        from usage_daily where estimator_epoch = 'legacy-epoch'
      `).get(), {
        request_byte_known_calls: 2,
        response_byte_known_calls: 2,
        request_character_known_calls: 2,
        response_character_known_calls: 2,
        request_token_known_calls: 2,
        response_token_known_calls: 2,
      });
    } finally {
      reader.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function readerCount(path: string, sql: string): string {
  const reader = new Database(path, { readonly: true });
  try {
    return String(Object.values(reader.prepare(sql).get() as Record<string, unknown>)[0]);
  } finally {
    reader.close();
  }
}

function recordCompletedCall(
  store: ReturnType<typeof openUsageStore>,
  eventId: string,
  startedAtMs: number,
  requestTokens: number,
  responseTokens: number,
): void {
  const request = measureRequestPayload(1);
  const response = measureResponsePayload({ structuredContent: 1 });
  store.startCall({
    eventId,
    tool: "read",
    sessionRef: "UNATTRIBUTED",
    startedAtMs,
    request,
  });
  store.finishCall({ eventId, success: true, durationMs: 1, response });
  store.setTokenCounts({ eventId, requestTokens, responseTokens, status: "AVAILABLE" });
}
