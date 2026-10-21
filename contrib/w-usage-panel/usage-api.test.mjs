import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createUsageRequestHandler,
  queryUsageCalls,
  queryUsageHealth,
  queryUsageOverview,
  queryUsageSnapshot,
} from "./usage-api.mjs";

test("calls endpoint treats an omitted cursor as the first page", async () => {
  const fixture = await createFixture();
  try {
    const pagePath = join(fixture.directory, "usage.html");
    await writeFile(pagePath, "<!doctype html>", "utf8");
    const handler = createUsageRequestHandler({ databasePath: fixture.databasePath, pagePath });
    const response = captureResponse();

    const handled = await handler(
      { method: "GET" },
      response,
      new URL("http://127.0.0.1:8787/api/usage/calls?range=all&limit=10"),
    );

    assert.equal(handled, true);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).items.length, 2);
  } finally {
    await fixture.close();
  }
});

test("invalid API input returns a fixed error without reflecting the query", async () => {
  const fixture = await createFixture();
  try {
    const pagePath = join(fixture.directory, "usage.html");
    await writeFile(pagePath, "<!doctype html>", "utf8");
    const handler = createUsageRequestHandler({ databasePath: fixture.databasePath, pagePath });
    const response = captureResponse();
    await handler(
      { method: "GET" },
      response,
      new URL("http://127.0.0.1:8787/api/usage/overview?range=PRIVATE_QUERY_VALUE"),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), { error: "invalid_usage_query" });
    assert.doesNotMatch(response.body, /PRIVATE_QUERY_VALUE/);
  } finally {
    await fixture.close();
  }
});

test("interval queries reject unsupported values and oversized ranges with fixed safe reasons", async () => {
  const fixture = await createFixture();
  try {
    const pagePath = join(fixture.directory, "usage.html");
    await writeFile(pagePath, "<!doctype html>", "utf8");
    const handler = createUsageRequestHandler({ databasePath: fixture.databasePath, pagePath });

    const unsupported = captureResponse();
    await handler(
      { method: "GET" },
      unsupported,
      new URL("http://127.0.0.1:8787/api/usage/overview?range=today&interval=PRIVATE_INTERVAL"),
    );
    assert.equal(unsupported.status, 400);
    assert.deepEqual(JSON.parse(unsupported.body), {
      error: "invalid_usage_query",
      reason: "unsupported_interval",
    });
    assert.doesNotMatch(unsupported.body, /PRIVATE_INTERVAL/);

    const oversized = captureResponse();
    await handler(
      { method: "GET" },
      oversized,
      new URL("http://127.0.0.1:8787/api/usage/snapshot?range=30d&interval=15m"),
    );
    assert.equal(oversized.status, 400);
    assert.deepEqual(JSON.parse(oversized.body), {
      error: "invalid_usage_query",
      reason: "interval_range_too_large",
      max_days: 7,
    });
  } finally {
    await fixture.close();
  }
});

test("invalid integer pagination is rejected instead of silently clamped", async () => {
  const fixture = await createFixture();
  try {
    const pagePath = join(fixture.directory, "usage.html");
    await writeFile(pagePath, "<!doctype html>", "utf8");
    const handler = createUsageRequestHandler({ databasePath: fixture.databasePath, pagePath });
    for (const query of ["range=today&limit=abc", "range=today&calls_limit=1.5"]) {
      const response = captureResponse();
      await handler({ method: "GET" }, response, new URL(`http://127.0.0.1:8787/api/usage/snapshot?${query}`));
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(response.body), { error: "invalid_usage_query" });
    }
  } finally {
    await fixture.close();
  }
});

test("snapshot calls_limit controls the embedded call page", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    for (let index = 0; index < 3; index += 1) {
      database.prepare(`
        insert into usage_calls (
          event_id, boot_id, started_at_ms, finished_at_ms, local_date, session_ref,
          attribution_status, tool, outcome, duration_ms,
          request_bytes, request_characters, response_bytes, response_characters,
          request_measurement_status, response_measurement_status,
          request_tokens, response_tokens, request_token_status, response_token_status,
          estimator_epoch
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `event-${index}`, "boot", 10_000 + index, 10_001 + index, "2026-10-18",
        "session", "ATTRIBUTED", "read", "SUCCESS", 1,
        0, 0, 0, 0, "AVAILABLE", "AVAILABLE",
        0, 0, "AVAILABLE", "AVAILABLE", "epoch",
      );
    }
    database.close();
    const pagePath = join(fixture.directory, "usage.html");
    await writeFile(pagePath, "<!doctype html>", "utf8");
    const handler = createUsageRequestHandler({ databasePath: fixture.databasePath, pagePath });
    const response = captureResponse();
    await handler(
      { method: "GET" },
      response,
      new URL("http://127.0.0.1:8787/api/usage/snapshot?range=all&calls_limit=1"),
    );

    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.calls.items.length, 1);
    assert.ok(body.calls.next_cursor);
  } finally {
    await fixture.close();
  }
});

test("database read failures do not masquerade as bad client input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-api-corrupt-"));
  const databasePath = join(directory, "usage.sqlite");
  const pagePath = join(directory, "usage.html");
  try {
    await writeFile(databasePath, "not a sqlite database", "utf8");
    await writeFile(pagePath, "<!doctype html>", "utf8");
    const handler = createUsageRequestHandler({ databasePath, pagePath });
    const response = captureResponse();
    await handler({ method: "GET" }, response, new URL("http://127.0.0.1:8787/api/usage/health"));
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.body), { error: "usage_unavailable" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom ranges reject impossible dates, reversed dates and spans over 366 days", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(() => queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-02-30", end: "2026-03-01",
    }), /valid calendar date/);
    assert.throws(() => queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-10-18", end: "2026-10-17",
    }), /after end/);
    assert.throws(() => queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2025-01-01", end: "2026-10-18",
    }), /366 days/);
  } finally {
    await fixture.close();
  }
});

test("overview keeps exact counts separate from partial token estimates", async () => {
  const fixture = await createFixture();
  try {
    const overview = queryUsageOverview(fixture.databasePath, {
      range: "today",
      nowMs: Date.UTC(2026, 9, 18, 4),
    });

    assert.equal(overview.metric_scope, "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE");
    assert.equal(overview.status, "PARTIAL");
    assert.deepEqual(overview.exact, {
      calls: 2,
      success_calls: 1,
      failure_calls: 1,
      request_bytes: 30,
      response_bytes: 40,
      total_bytes: 70,
      request_characters: 26,
      response_characters: 35,
      total_characters: 61,
      coverage: {
        request_bytes: { known_calls: 2, applicable_calls: 2, ratio: 1 },
        response_bytes: { known_calls: 1, applicable_calls: 2, ratio: 0.5 },
        request_characters: { known_calls: 2, applicable_calls: 2, ratio: 1 },
        response_characters: { known_calls: 1, applicable_calls: 2, ratio: 0.5 },
      },
      status: {
        request_bytes: "AVAILABLE",
        response_bytes: "PARTIAL",
        request_characters: "AVAILABLE",
        response_characters: "PARTIAL",
      },
    });
    assert.deepEqual(overview.estimated_tokens, {
      request: 7,
      response: 11,
      total: 18,
      request_known_calls: 1,
      request_applicable_calls: 2,
      response_known_calls: 1,
      response_applicable_calls: 2,
      total_calls: 2,
    });
    assert.equal(overview.coverage.started_at, "2026-06-01T00:00:00.000Z");
    assert.deepEqual(overview.coverage.response, {
      known_calls: 1,
      applicable_calls: 2,
      ratio: 0.5,
    });
    assert.equal(overview.coverage.unknown_response_calls, 1);
    assert.equal(overview.coverage.incomplete_calls, 1);
    assert.equal(overview.coverage.unattributed_calls, 1);
    assert.equal(overview.estimator.encoding, "o200k_base");
    assert.equal(overview.by_tool[0].tool, "read");
    assert.equal(overview.by_day[0].date, "2026-10-18");
    assert.deepEqual(
      overview.by_session.find((session) => session.session_ref === "UNATTRIBUTED"),
      { session_ref: "UNATTRIBUTED", calls: 1, estimated_tokens: null, known_sides: 0, applicable_sides: 2 },
    );
  } finally {
    await fixture.close();
  }
});

test("overview groups retained calls into Hong Kong aligned interval buckets", async () => {
  const fixture = await createFixture();
  try {
    const expectations = [
      ["15m", 48, "2026-10-18T01:00:00.000Z", "2026-10-18T01:15:00.000Z"],
      ["30m", 24, "2026-10-18T01:00:00.000Z", "2026-10-18T01:30:00.000Z"],
      ["1h", 12, "2026-10-18T01:00:00.000Z", "2026-10-18T02:00:00.000Z"],
      ["4h", 3, "2026-10-18T00:00:00.000Z", "2026-10-18T04:00:00.000Z"],
    ];
    for (const [interval, bucketCount, start, end] of expectations) {
      const overview = queryUsageOverview(fixture.databasePath, {
        range: "today",
        interval,
        nowMs: Date.UTC(2026, 9, 18, 4),
        runtimeHealth: { writer_state: "ACTIVE" },
      });
      assert.equal(overview.interval, interval);
      assert.equal(overview.interval_scope, "RETAINED_CALLS_ONLY");
      assert.equal(overview.by_interval.length, bucketCount);
      const bucket = overview.by_interval.find((entry) => entry.calls === 2);
      assert.equal(bucket.start, start);
      assert.equal(bucket.end, end);
      assert.equal(bucket.status, "PARTIAL");
      assert.deepEqual(bucket.estimated_tokens, {
        request: 7,
        response: 11,
        total: 18,
        request_known_calls: 1,
        request_applicable_calls: 2,
        request_ratio: 0.5,
        response_known_calls: 1,
        response_applicable_calls: 2,
        response_ratio: 0.5,
        total_calls: 2,
      });
    }
  } finally {
    await fixture.close();
  }
});

test("interval buckets distinguish monitored zero usage from a full coverage gap", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("insert into usage_gaps(started_at_ms, ended_at_ms, reason) values (?, ?, ?)")
      .run(
        Date.parse("2026-10-17T16:15:00.000Z"),
        Date.parse("2026-10-17T16:30:00.000Z"),
        "INTERRUPTED",
      );
    database.close();

    const overview = queryUsageOverview(fixture.databasePath, {
      range: "today",
      interval: "15m",
      nowMs: Date.UTC(2026, 9, 18, 4),
      runtimeHealth: { writer_state: "ACTIVE" },
    });
    const monitoredZero = overview.by_interval[0];
    assert.equal(monitoredZero.status, "AVAILABLE");
    assert.equal(monitoredZero.calls, 0);
    assert.deepEqual(monitoredZero.estimated_tokens, {
      request: 0,
      response: 0,
      total: 0,
      request_known_calls: 0,
      request_applicable_calls: 0,
      request_ratio: null,
      response_known_calls: 0,
      response_applicable_calls: 0,
      response_ratio: null,
      total_calls: 0,
    });
    const unknown = overview.by_interval[1];
    assert.equal(unknown.start, "2026-10-17T16:15:00.000Z");
    assert.equal(unknown.status, "UNKNOWN");
    assert.equal(unknown.calls, 0);
    assert.equal(unknown.estimated_tokens.request, null);
    assert.equal(unknown.estimated_tokens.response, null);
    assert.equal(unknown.estimated_tokens.total, null);
  } finally {
    await fixture.close();
  }
});

test("partial gap overlap and an unfinished current bucket are explicitly partial", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("insert into usage_gaps(started_at_ms, ended_at_ms, reason) values (?, ?, ?)")
      .run(
        Date.parse("2026-10-17T16:20:00.000Z"),
        Date.parse("2026-10-17T16:25:00.000Z"),
        "INTERRUPTED",
      );
    database.close();

    const overview = queryUsageOverview(fixture.databasePath, {
      range: "today",
      interval: "15m",
      nowMs: Date.parse("2026-10-17T16:37:00.000Z"),
      runtimeHealth: { writer_state: "ACTIVE" },
    });
    assert.equal(overview.by_interval[1].status, "PARTIAL");
    assert.equal(overview.by_interval[1].estimated_tokens.total, null);
    assert.equal(overview.by_interval.at(-1).end, "2026-10-17T16:37:00.000Z");
    assert.equal(overview.by_interval.at(-1).status, "PARTIAL");
    assert.equal(overview.by_interval.at(-1).estimated_tokens.total, null);
  } finally {
    await fixture.close();
  }
});

test("snapshot uses its fixed as-of boundary for short interval data", async () => {
  const fixture = await createFixture();
  try {
    const asOfMs = Date.UTC(2026, 9, 18, 4);
    const snapshot = queryUsageSnapshot(fixture.databasePath, {
      range: "today", interval: "1h", asOfMs,
    });
    assert.equal(snapshot.overview.interval, "1h");
    assert.equal(snapshot.overview.by_interval.length, 12);
    assert.equal(snapshot.overview.by_interval.at(-1).end, snapshot.as_of);
    assert.equal(snapshot.overview.available_from, "2026-07-20T04:00:00.000Z");
  } finally {
    await fixture.close();
  }
});

test("each interval accepts its documented maximum range and rejects one extra day", async () => {
  const fixture = await createFixture();
  try {
    const nowMs = Date.UTC(2026, 9, 18, 4);
    const cases = [
      ["15m", "2026-10-12", "2026-10-11", 7],
      ["30m", "2026-10-05", "2026-10-04", 14],
      ["1h", "2026-09-19", "2026-09-18", 30],
      ["4h", "2026-07-21", "2026-07-20", 90],
    ];
    for (const [interval, acceptedStart, rejectedStart, maxDays] of cases) {
      const overview = queryUsageOverview(fixture.databasePath, {
        range: "custom", start: acceptedStart, end: "2026-10-18", interval, nowMs,
      });
      assert.equal(overview.interval, interval);
      assert.throws(() => queryUsageOverview(fixture.databasePath, {
        range: "custom", start: rejectedStart, end: "2026-10-18", interval, nowMs,
      }), (error) => error.reason === "interval_range_too_large" && error.maxDays === maxDays);
    }
  } finally {
    await fixture.close();
  }
});

test("omitting interval preserves the existing overview response shape", async () => {
  const fixture = await createFixture();
  try {
    const overview = queryUsageOverview(fixture.databasePath, {
      range: "today", nowMs: Date.UTC(2026, 9, 18, 4),
    });
    assert.equal("interval" in overview, false);
    assert.equal("interval_scope" in overview, false);
    assert.equal("available_from" in overview, false);
    assert.equal("by_interval" in overview, false);
  } finally {
    await fixture.close();
  }
});

test("all-time overview reconciles retained calls with long-term daily summaries", async () => {
  const fixture = await createFixture();
  try {
    const overview = queryUsageOverview(fixture.databasePath, {
      range: "all",
      nowMs: Date.UTC(2026, 9, 18, 4),
    });
    assert.equal(overview.exact.calls, 3);
    assert.equal(overview.exact.request_bytes, 130);
    assert.equal(overview.exact.response_bytes, 240);
    assert.equal(overview.estimated_tokens.request, 20);
    assert.equal(overview.estimated_tokens.response, 28);
    assert.equal(overview.coverage.session_breakdown, "RETAINED_CALLS_ONLY");
  } finally {
    await fixture.close();
  }
});

test("overview persists retained and archived exact facts and token coverage without changing counts", async () => {
  const fixture = await createFixture();
  try {
    for (const range of ["all", "today"]) {
      const overview = queryUsageOverview(fixture.databasePath, {
        range,
        nowMs: Date.UTC(2026, 9, 18, 4),
        runtimeHealth: { writer_state: "ACTIVE" },
      });
      assert.deepEqual(
        [overview.exact.calls, overview.exact.total_bytes],
        range === "all" ? [3, 370] : [2, 70],
      );
      assert.deepEqual(
        [
          overview.estimated_tokens.request_known_calls,
          overview.estimated_tokens.request_applicable_calls,
          overview.estimated_tokens.response_known_calls,
          overview.estimated_tokens.response_applicable_calls,
        ],
        range === "all" ? [2, 3, 2, 3] : [1, 2, 1, 2],
      );
      assert.equal(
        overview.estimated_tokens.request,
        range === "all" ? 20 : 7,
      );
      assert.equal(
        overview.estimated_tokens.response,
        range === "all" ? 28 : 11,
      );
    }
  } finally {
    await fixture.close();
  }
});

test("exact measurements remain unknown when every applicable call is unmeasured", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare(`
      update usage_calls
      set request_bytes = null, request_characters = null,
        response_bytes = null, response_characters = null,
        request_measurement_status = 'MEASUREMENT_ERROR',
        response_measurement_status = 'UNKNOWN_RESPONSE'
      where event_id = 'unknown'
    `).run();
    database.prepare(`
      update usage_calls
      set request_bytes = null, request_characters = null,
        response_bytes = null, response_characters = null,
        request_measurement_status = 'MEASUREMENT_ERROR',
        response_measurement_status = 'UNKNOWN_RESPONSE'
      where event_id = 'known'
    `).run();
    database.close();

    const overview = queryUsageOverview(fixture.databasePath, {
      range: "today", nowMs: Date.UTC(2026, 9, 18, 4),
    });
    assert.deepEqual(
      [
        overview.exact.request_bytes,
        overview.exact.response_bytes,
        overview.exact.total_bytes,
        overview.exact.request_characters,
        overview.exact.response_characters,
        overview.exact.total_characters,
      ],
      [null, null, null, null, null, null],
    );
    assert.deepEqual(overview.exact.coverage.request_bytes, {
      known_calls: 0, applicable_calls: 2, ratio: 0,
    });
    assert.deepEqual(overview.exact.coverage.response_bytes, {
      known_calls: 0, applicable_calls: 2, ratio: 0,
    });
    assert.equal(overview.by_day[0].exact.total_bytes, null);
  } finally {
    await fixture.close();
  }
});

test("partial exact coverage exposes known counts beside a known subtotal", async () => {
  const fixture = await createFixture();
  try {
    const overview = queryUsageOverview(fixture.databasePath, {
      range: "today", nowMs: Date.UTC(2026, 9, 18, 4),
    });
    assert.equal(overview.exact.total_bytes, 70);
    assert.deepEqual(overview.exact.coverage.response_bytes, {
      known_calls: 1, applicable_calls: 2, ratio: 0.5,
    });
    assert.deepEqual(overview.by_tool.find((row) => row.tool === "bash").exact.coverage.response_bytes, {
      known_calls: 0, applicable_calls: 1, ratio: 0,
    });
  } finally {
    await fixture.close();
  }
});

test("health and calls expose statuses and numeric metadata without payload fields", async () => {
  const fixture = await createFixture();
  try {
    const health = queryUsageHealth(fixture.databasePath);
    assert.equal(health.status, "PARTIAL");
    assert.equal(health.total_calls, 3);
    assert.equal(health.archived_calls, 1);
    assert.equal(health.partial_calls, 1);
    assert.equal(health.dropped_calls, 0);
    assert.equal(health.incomplete_calls, 1);
    assert.equal(health.monitor_health, "ACTIVE");
    assert.equal(health.tokenizer_cache_status, "VERIFIED");
    assert.equal(health.last_maintenance_at, "2026-10-18T00:00:00.000Z");
    assert.equal(health.tokenizer_unavailable_calls, 1);
    assert.equal(health.coverage_started_at, "2026-06-01T00:00:00.000Z");

    const calls = queryUsageCalls(fixture.databasePath, { range: "all", limit: 10 });
    assert.equal(calls.items.length, 2);
    assert.equal(calls.metric_scope, "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE");
    assert.equal(calls.attribution_basis, "OWNER_CONFIRMED_EXCLUSIVE_ENDPOINT");
    assert.equal(calls.estimator_epochs.length, 1);
    const known = calls.items.find((item) => item.event_id === "known");
    assert.equal(known.request_token_status, "AVAILABLE");
    assert.equal(known.response_token_status, "AVAILABLE");
    assert.doesNotMatch(JSON.stringify(calls), /TOP-SECRET|raw-session/i);
  } finally {
    await fixture.close();
  }
});

test("health leaves an unavailable queue depth unknown instead of treating it as zero", async () => {
  const fixture = await createFixture();
  try {
    assert.equal(queryUsageHealth(fixture.databasePath).queue_bytes, null);
    assert.equal(queryUsageHealth(fixture.databasePath, {
      runtimeHealth: { writer_state: "ACTIVE", queue: { queued_bytes: 0 } },
    }).queue_bytes, 0);
  } finally {
    await fixture.close();
  }
});

test("health exposes bounded tokenizer recovery facts without payload data", async () => {
  const fixture = await createFixture();
  try {
    const health = queryUsageHealth(fixture.databasePath, {
      runtimeHealth: {
        writer_state: "ACTIVE",
        payload: "PRIVATE-PAYLOAD",
        command: "PRIVATE-COMMAND",
        path: "PRIVATE-PATH",
        session: "PRIVATE-SESSION",
        queue: { queued_bytes: 17, oldest_queued_age_ms: 250 },
        last_tokenizer_success_at_ms: Date.UTC(2026, 9, 18, 2),
        failure_counts: {
          storage: 0,
          tokenizer: 2,
          dropped: 0,
          incomplete: 0,
          by_reason: { TOKENIZER_ENCODE_ERROR: 2 },
        },
      },
    });
    assert.equal(health.queue_bytes, 17);
    assert.equal(health.oldest_queue_item_age_ms, 250);
    assert.equal(health.last_tokenizer_success_at, "2026-10-18T02:00:00.000Z");
    assert.deepEqual(health.failure_counters.by_reason, { TOKENIZER_ENCODE_ERROR: 2 });
    assert.doesNotMatch(
      JSON.stringify(health),
      /PRIVATE-(PAYLOAD|COMMAND|PATH|SESSION)/,
    );
  } finally {
    await fixture.close();
  }
});

test("calls range and composite cursor retain same-millisecond rows without duplicates", async () => {
  const fixture = await createFixture();
  try {
    const first = queryUsageCalls(fixture.databasePath, {
      range: "today", nowMs: Date.UTC(2026, 9, 18, 4), limit: 1,
    });
    const second = queryUsageCalls(fixture.databasePath, {
      range: "today", nowMs: Date.UTC(2026, 9, 18, 4), limit: 1, cursor: first.next_cursor,
    });
    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0].event_id, second.items[0].event_id);
    assert.equal(first.snapshot_upper_bound, second.snapshot_upper_bound);
  } finally {
    await fixture.close();
  }
});

test("calls cursor expires when retention generation changes", async () => {
  const fixture = await createFixture();
  try {
    const first = queryUsageCalls(fixture.databasePath, { range: "all", limit: 1 });
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("update usage_meta set value = '2' where key = 'retention_generation'").run();
    database.close();
    assert.throws(
      () => queryUsageCalls(fixture.databasePath, { range: "all", limit: 1, cursor: first.next_cursor }),
      (error) => error?.code === "CURSOR_EXPIRED",
    );
  } finally {
    await fixture.close();
  }
});

test("snapshot returns health overview and first calls page from one as-of boundary", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = queryUsageSnapshot(fixture.databasePath, {
      range: "today", nowMs: Date.UTC(2026, 9, 18, 4), callsLimit: 1,
    });
    assert.equal(snapshot.metric_scope, "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE");
    assert.equal(snapshot.as_of, snapshot.health.as_of);
    assert.equal(snapshot.as_of, snapshot.overview.as_of);
    assert.equal(snapshot.as_of, snapshot.calls.as_of);
    assert.equal(snapshot.overview.exact.calls, 2);
    assert.equal(snapshot.calls.items.length, 1);
  } finally {
    await fixture.close();
  }
});

test("snapshot resolves its today range and as-of timestamp from one clock reading", async () => {
  const fixture = await createFixture();
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => reads++ === 0
    ? Date.UTC(2026, 9, 18, 15, 59, 59)
    : Date.UTC(2026, 9, 18, 16, 0, 1);
  try {
    const snapshot = queryUsageSnapshot(fixture.databasePath, { range: "today" });
    assert.equal(snapshot.as_of, "2026-10-18T15:59:59.000Z");
    assert.equal(snapshot.overview.range.start, "2026-10-18");
    assert.equal(snapshot.overview.range.end, "2026-10-18");
  } finally {
    Date.now = originalNow;
    await fixture.close();
  }
});

test("snapshot excludes rows after its fixed as-of boundary from every projection", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare(`
      insert into usage_calls (
        event_id, boot_id, started_at_ms, finished_at_ms, local_date, session_ref,
        attribution_status, tool, outcome, duration_ms,
        request_bytes, request_characters, response_bytes, response_characters,
        request_measurement_status, response_measurement_status,
        request_tokens, response_tokens, request_token_status, response_token_status,
        estimator_epoch
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "future", "boot", Date.UTC(2026, 9, 18, 1, 0, 1),
      Date.UTC(2026, 9, 18, 1, 0, 2), "2026-10-18", "future-session",
      "ATTRIBUTED", "read", "SUCCESS", 5, 999, 999, 999, 999,
      "AVAILABLE", "AVAILABLE", 999, 999, "AVAILABLE", "AVAILABLE", "epoch-v2",
    );
    database.close();

    const snapshot = queryUsageSnapshot(fixture.databasePath, {
      range: "today",
      asOfMs: Date.UTC(2026, 9, 18, 1),
      callsLimit: 50,
      runtimeHealth: { writer_state: "ACTIVE" },
    });
    assert.equal(snapshot.as_of, "2026-10-18T01:00:00.000Z");
    assert.equal(snapshot.overview.exact.calls, 2);
    assert.equal(snapshot.overview.exact.total_bytes, 70);
    assert.equal(snapshot.health.total_calls, 3);
    assert.equal(snapshot.health.latest_call_at, "2026-10-18T01:00:00.000Z");
    assert.ok(snapshot.calls.items.every((item) => item.event_id !== "future"));
    assert.ok(snapshot.overview.by_session.every((item) => item.session_ref !== "future-session"));
  } finally {
    await fixture.close();
  }
});

test("every non-active writer state makes otherwise complete coverage partial", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("delete from usage_calls where event_id = 'unknown'").run();
    database.prepare("delete from usage_daily").run();
    database.prepare("delete from usage_gaps").run();
    database.prepare("update usage_meta set value = ? where key = 'coverage_started_at_ms'")
      .run(String(Date.UTC(2026, 5, 1)));
    database.prepare("update usage_boots set started_at_ms = ?")
      .run(Date.UTC(2026, 5, 1));
    database.prepare("delete from usage_gaps").run();
    database.close();
    const nowMs = Date.UTC(2026, 9, 19, 4);

    const overview = queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-10-18", end: "2026-10-18",
      nowMs, runtimeHealth: { writer_state: "ACTIVE" },
    });
    assert.equal(
      overview.status,
      "AVAILABLE",
      JSON.stringify({ coverage: overview.coverage, estimated: overview.estimated_tokens }),
    );
    for (const writer_state of ["DEGRADED_INIT", "INITIALIZING", "UNKNOWN", "OFFLINE", "DISABLED"]) {
      assert.equal(queryUsageOverview(fixture.databasePath, {
        range: "custom", start: "2026-10-18", end: "2026-10-18",
        nowMs, runtimeHealth: { writer_state },
      }).status, "PARTIAL", writer_state);
    }
  } finally {
    await fixture.close();
  }
});

test("activation day is partial while later full days can be available", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("delete from usage_calls where event_id = 'unknown'").run();
    database.prepare("delete from usage_daily").run();
    database.prepare("update usage_meta set value = ? where key = 'coverage_started_at_ms'")
      .run(String(Date.UTC(2026, 9, 18, 1)));
    database.prepare("update usage_boots set started_at_ms = ?")
      .run(Date.UTC(2026, 9, 18, 1));
    database.close();
    const runtimeHealth = { writer_state: "ACTIVE" };
    const nowMs = Date.UTC(2026, 9, 21, 4);

    assert.equal(queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-10-18", end: "2026-10-18", nowMs, runtimeHealth,
    }).status, "PARTIAL");
    assert.equal(queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-10-18", end: "2026-10-19", nowMs, runtimeHealth,
    }).status, "PARTIAL");
    assert.equal(queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-10-17", end: "2026-10-18", nowMs, runtimeHealth,
    }).status, "PARTIAL");
    const laterDay = queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-10-20", end: "2026-10-20", nowMs, runtimeHealth,
    });
    assert.equal(
      laterDay.status,
      "AVAILABLE",
      JSON.stringify({
        coverage: laterDay.coverage,
        exact: laterDay.exact,
        estimated: laterDay.estimated_tokens,
        status: laterDay.status,
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("archived rows use event bounds rather than retention time", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("delete from usage_calls where event_id = 'unknown'").run();
    database.prepare("delete from usage_daily").run();
    const insertDaily = database.prepare("insert into usage_daily values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // A June event retained in October must be visible in a June fixed snapshot.
    insertDaily.run(
      "2026-06-01", "read", "epoch-v2", "SUCCESS", "AVAILABLE", "AVAILABLE",
      "AVAILABLE", "AVAILABLE", "ATTRIBUTED", 1, 10, 20, 9, 18, 1, 1, 1, 1,
      4, 6, 1, 1, 2, 1, Date.UTC(2026, 9, 18),
      Date.UTC(2026, 5, 1, 2), Date.UTC(2026, 5, 1, 3),
    );
    database.close();

    const beforeRetentionTime = queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-06-01", end: "2026-06-01",
      nowMs: Date.UTC(2026, 5, 1, 4),
    });
    assert.equal(beforeRetentionTime.exact.calls, 1);
    assert.equal(beforeRetentionTime.exact.total_bytes, 30);
    assert.equal(beforeRetentionTime.estimated_tokens.total, 10);

    const atBucketEnd = queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-06-01", end: "2026-06-01",
      nowMs: Date.UTC(2026, 5, 1, 3),
    });
    assert.equal(atBucketEnd.exact.calls, 1);
    assert.equal(atBucketEnd.coverage.archive_boundary.crossing_calls, 0);
    const crossing = queryUsageOverview(fixture.databasePath, {
      range: "custom", start: "2026-06-01", end: "2026-06-01",
      nowMs: Date.UTC(2026, 5, 1, 2, 30),
    });
    assert.equal(crossing.exact.calls, 0);
    assert.equal(crossing.coverage.archive_boundary.crossing_calls, 1);
    assert.equal(crossing.coverage.archive_boundary.provenance, "CROSSING_BUCKET_EXCLUDED");
  } finally {
    await fixture.close();
  }
});

test("a legacy archived bucket with no event bounds is explicitly degraded", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("update usage_daily set event_started_at_min_ms = null, event_started_at_max_ms = null").run();
    database.close();
    const overview = queryUsageOverview(fixture.databasePath, {
      range: "all", nowMs: Date.UTC(2026, 9, 18, 4),
      runtimeHealth: { writer_state: "ACTIVE" },
    });
    assert.equal(overview.status, "PARTIAL");
    assert.equal(overview.coverage.archive_boundary.provenance, "LEGACY_DAY_BOUNDED_MIXED");
    assert.equal(overview.coverage.archive_boundary.legacy_calls, 1);
  } finally {
    await fixture.close();
  }
});

test("an unverified tokenizer cache makes otherwise complete coverage partial", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("delete from usage_calls where event_id = 'unknown'").run();
    database.prepare("delete from usage_daily").run();
    database.prepare("delete from usage_estimator_epochs where epoch_id != 'epoch-v2'").run();
    database.prepare("update usage_estimator_epochs set cache_status = 'UNKNOWN'").run();
    database.close();

    assert.equal(queryUsageOverview(fixture.databasePath, {
      range: "today",
      nowMs: Date.UTC(2026, 9, 18, 4),
      runtimeHealth: { writer_state: "ACTIVE" },
    }).status, "PARTIAL");
  } finally {
    await fixture.close();
  }
});

test("multiple estimator epochs surface every epoch and use the newest one for health", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("delete from usage_calls where event_id = 'unknown'").run();
    database.prepare("delete from usage_daily").run();
    database.prepare("update usage_estimator_epochs set created_at_ms = ? where epoch_id = 'epoch-v2'")
      .run(Date.UTC(2026, 5, 1));
    database.prepare("update usage_calls set estimator_epoch = 'epoch-v2'").run();
    database.prepare(`
      insert into usage_daily values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2026-06-01", "read", "epoch-v2", "SUCCESS", "AVAILABLE", "AVAILABLE",
      "AVAILABLE", "AVAILABLE", "ATTRIBUTED", 1, 100, 200, 90, 180, 1, 1, 1, 1,
      13, 17, 1, 1, 15, 1, Date.UTC(2026, 9, 18),
      Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 1),
    );
    database.prepare("insert into usage_estimator_epochs values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "epoch-v3", "tiktoken", "0.14.0", "o200k_base", "mcp-visible-v3",
        "b".repeat(64), "UNAVAILABLE_OR_INVALID", Date.UTC(2026, 9, 18, 2),
      );
    database.prepare("update usage_calls set estimator_epoch = 'epoch-v3' where event_id = 'known'").run();
    database.close();

    const overview = queryUsageOverview(fixture.databasePath, {
      range: "all",
      nowMs: Date.UTC(2026, 9, 18, 4),
      runtimeHealth: { writer_state: "ACTIVE" },
    });
    assert.deepEqual(
      overview.estimator_epochs.map((epoch) => epoch.epoch_id),
      ["epoch-v2", "epoch-v3"],
    );
    assert.doesNotMatch(JSON.stringify(overview.estimator_epochs), /created_at_ms/);
    assert.equal(overview.estimator.algorithm_version, "mcp-visible-v3");
    assert.equal(overview.status, "PARTIAL");
    assert.equal(queryUsageHealth(fixture.databasePath).tokenizer_cache_status, "UNAVAILABLE_OR_INVALID");
  } finally {
    await fixture.close();
  }
});

test("an estimator epoch created after a fixed snapshot stays invisible", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("delete from usage_calls").run();
    database.prepare("delete from usage_daily").run();
    database.prepare("insert into usage_estimator_epochs values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "epoch-future", "tiktoken", "0.14.0", "o200k_base", "mcp-visible-future",
        "b".repeat(64), "VERIFIED", Date.UTC(2026, 5, 1, 3),
      );
    database.prepare("update usage_estimator_epochs set created_at_ms = ? where epoch_id = ?")
      .run(Date.UTC(2026, 5, 1), "epoch-v2");
    database.close();
    const snapshot = queryUsageSnapshot(fixture.databasePath, {
      range: "custom", start: "2026-06-01", end: "2026-06-01",
      asOfMs: Date.UTC(2026, 5, 1, 2),
      runtimeHealth: { writer_state: "ACTIVE" },
    });
    assert.deepEqual(snapshot.overview.estimator_epochs, []);
    assert.deepEqual(snapshot.health.estimator_epochs, []);
    assert.equal(snapshot.overview.estimator.algorithm_version, "mcp-visible-v2");
  } finally {
    await fixture.close();
  }
});

test("interrupted calls remain visibly incomplete without inflating handler failures", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("delete from usage_calls where event_id = 'unknown'").run();
    database.prepare("update usage_calls set outcome = 'INTERRUPTED' where event_id = 'known'").run();
    database.close();
    const health = queryUsageHealth(fixture.databasePath);
    assert.equal(health.status, "PARTIAL");
    assert.equal(health.incomplete_calls, 1);
    const overview = queryUsageOverview(fixture.databasePath, { range: "all" });
    assert.equal(overview.exact.failure_calls, 0);
    assert.equal(overview.coverage.incomplete_calls, 1);
  } finally {
    await fixture.close();
  }
});

test("session coverage excludes an in-progress response just like the overview coverage", async () => {
  const fixture = await createFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare(`
      update usage_calls set outcome = 'IN_PROGRESS', finished_at_ms = null, duration_ms = null,
        response_bytes = null, response_characters = null, response_tokens = null,
        response_measurement_status = 'PENDING', response_token_status = 'PENDING'
      where event_id = 'known'
    `).run();
    database.close();
    const overview = queryUsageOverview(fixture.databasePath, { range: "today", nowMs: Date.UTC(2026, 9, 18, 4) });
    const session = overview.by_session.find((row) => row.session_ref.startsWith("w_"));
    assert.deepEqual(session, {
      session_ref: "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      calls: 1,
      estimated_tokens: 7,
      known_sides: 1,
      applicable_sides: 1,
    });
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-api-test-"));
  const databasePath = join(directory, "usage.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    create table usage_calls (
      sequence integer primary key autoincrement, event_id text not null unique,
      boot_id text not null, started_at_ms integer not null, finished_at_ms integer,
      local_date text not null, session_ref text not null, attribution_status text not null,
      tool text not null, outcome text not null, duration_ms integer,
      request_bytes integer, request_characters integer, response_bytes integer,
      response_characters integer, request_measurement_status text not null,
      response_measurement_status text not null, request_tokens integer, response_tokens integer,
      request_token_status text not null, response_token_status text not null,
      estimator_epoch text not null
    );
    create table usage_daily (
      local_date text not null, tool text not null, estimator_epoch text not null,
      outcome text not null, request_measurement_status text not null,
      response_measurement_status text not null, request_token_status text not null,
      response_token_status text not null, attribution_status text not null,
      call_count integer not null,
      request_bytes integer, response_bytes integer,
      request_characters integer, response_characters integer,
      request_byte_known_calls integer not null, response_byte_known_calls integer not null,
      request_character_known_calls integer not null, response_character_known_calls integer not null,
      request_tokens integer, response_tokens integer,
      request_token_known_calls integer not null, response_token_known_calls integer not null,
      duration_sum_ms integer not null, duration_known_calls integer not null,
      aggregated_at_ms integer not null,
      event_started_at_min_ms integer, event_started_at_max_ms integer
    );
    create table usage_estimator_epochs (
      epoch_id text primary key, package text not null, version text not null,
      encoding text not null, algorithm_version text not null,
      worker_sha256 text not null, cache_status text not null, created_at_ms integer not null
    );
    create table usage_boots (
      boot_id text primary key, started_at_ms integer not null, heartbeat_at_ms integer not null,
      stopped_at_ms integer, status text not null, runtime_health text not null
    );
    create table usage_gaps (
      gap_id integer primary key autoincrement, started_at_ms integer not null,
      ended_at_ms integer not null, reason text not null
    );
    create table usage_meta (key text primary key, value text not null);
  `);
  const insertCall = database.prepare(`
    insert into usage_calls (
      event_id, boot_id, started_at_ms, finished_at_ms, local_date, session_ref,
      attribution_status, tool, outcome, duration_ms, request_bytes, request_characters,
      response_bytes, response_characters, request_measurement_status,
      response_measurement_status, request_tokens, response_tokens,
      request_token_status, response_token_status, estimator_epoch
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCall.run(
    "known", "boot", Date.UTC(2026, 9, 18, 1), Date.UTC(2026, 9, 18, 1) + 20,
    "2026-10-18", "w_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "ATTRIBUTED", "read", "SUCCESS", 20,
    10, 9, 40, 35, "AVAILABLE", "AVAILABLE", 7, 11, "AVAILABLE", "AVAILABLE", "epoch-v2",
  );
  insertCall.run(
    "unknown", "boot", Date.UTC(2026, 9, 18, 1), Date.UTC(2026, 9, 18, 1) + 30,
    "2026-10-18", "UNATTRIBUTED", "UNATTRIBUTED", "bash", "ERROR", 30,
    20, 17, null, null, "AVAILABLE", "UNKNOWN_RESPONSE", null, null,
    "TOKENIZER_UNAVAILABLE", "UNKNOWN_RESPONSE", "epoch-v2",
  );
  database.prepare("insert into usage_daily values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "2026-06-01", "read", "epoch-v2", "SUCCESS", "AVAILABLE", "AVAILABLE",
      "AVAILABLE", "AVAILABLE", "ATTRIBUTED", 1, 100, 200, 90, 180, 1, 1, 1, 1,
      13, 17, 1, 1, 15, 1, Date.UTC(2026, 9, 18),
      Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 1),
    );
  database.prepare("insert into usage_estimator_epochs values (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("epoch-v2", "tiktoken", "0.14.0", "o200k_base", "mcp-visible-v2", "a".repeat(64), "VERIFIED", Date.UTC(2026, 5, 1));
  database.prepare("insert into usage_boots values (?, ?, ?, ?, ?, ?)")
    .run("boot", Date.UTC(2026, 5, 1), Date.UTC(2026, 9, 18, 4), null, "ACTIVE", "ACTIVE");
  const meta = database.prepare("insert into usage_meta values (?, ?)");
  for (const [key, value] of [
    ["schema_version", "2"],
    ["coverage_started_at_ms", String(Date.UTC(2026, 5, 1))],
    ["estimator_package", "tiktoken"],
    ["estimator_version", "0.14.0"],
    ["estimator_encoding", "o200k_base"],
    ["algorithm_version", "mcp-visible-v2"],
    ["retention_generation", "1"],
    ["last_maintenance_at_ms", String(Date.UTC(2026, 9, 18))],
  ]) meta.run(key, value);
  database.close();
  return {
    directory,
    databasePath,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
function captureResponse() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = body;
    },
  };
}
