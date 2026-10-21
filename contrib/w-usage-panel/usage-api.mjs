import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const TIMEZONE = "Asia/Hong_Kong";
const METRIC_SCOPE = "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE";
const ATTRIBUTION_BASIS = "OWNER_CONFIRMED_EXCLUSIVE_ENDPOINT";
const RETAINED_DETAIL_DAYS = 90;
const INTERVAL_SCOPE = "RETAINED_CALLS_ONLY";
const INTERVALS = Object.freeze({
  "15m": { milliseconds: 15 * 60_000, maxDays: 7 },
  "30m": { milliseconds: 30 * 60_000, maxDays: 14 },
  "1h": { milliseconds: 60 * 60_000, maxDays: 30 },
  "4h": { milliseconds: 4 * 60 * 60_000, maxDays: 90 },
});
const DEFAULT_ESTIMATOR = {
  package: "tiktoken",
  version: "0.14.0",
  encoding: "o200k_base",
  algorithm_version: "mcp-visible-v3",
};
const TOKENIZER_FAILURE_STATUSES = new Set([
  "TOKENIZER_UNAVAILABLE",
  "TOKENIZER_WORKER_STARTUP_ERROR",
  "TOKENIZER_WORKER_EXIT",
  "TOKENIZER_PROTOCOL_ERROR",
  "TOKENIZER_ENCODE_ERROR",
  "TOKENIZER_TIMEOUT",
  "TOKENIZER_CIRCUIT_OPEN",
]);

export function queryUsageHealth(databasePath, options = {}) {
  if (!existsSync(databasePath)) return unknownHealth("DATABASE_NOT_CREATED", options);
  return withSnapshot(databasePath, (database) => healthFromDatabase(database, options));
}

export function queryUsageOverview(databasePath, options = {}) {
  const range = resolveRange(options);
  const interval = resolveInterval(options.interval, range);
  if (!existsSync(databasePath)) return emptyOverview(range, "DATABASE_NOT_CREATED", options.asOfMs, interval);
  return withSnapshot(databasePath, (database) => overviewFromDatabase(database, range, options));
}

export function queryUsageCalls(databasePath, options = {}) {
  const range = resolveRange(options);
  if (!existsSync(databasePath)) return emptyCalls(range, "DATABASE_NOT_CREATED", options.asOfMs);
  return withSnapshot(databasePath, (database) => callsFromDatabase(database, range, options));
}

export function queryUsageSnapshot(databasePath, options = {}) {
  const requestedAsOfMs = options.asOfMs ?? options.nowMs ?? Date.now();
  const asOfMs = Math.floor(requestedAsOfMs / 1_000) * 1_000;
  const range = resolveRange({ ...options, nowMs: asOfMs });
  const interval = resolveInterval(options.interval, range);
  if (!existsSync(databasePath)) {
    return {
      metric_scope: METRIC_SCOPE,
      status: "UNKNOWN",
      as_of: new Date(asOfMs).toISOString(),
      health: unknownHealth("DATABASE_NOT_CREATED", { ...options, asOfMs }),
      overview: emptyOverview(range, "DATABASE_NOT_CREATED", asOfMs, interval),
      calls: emptyCalls(range, "DATABASE_NOT_CREATED", asOfMs),
    };
  }
  return withSnapshot(databasePath, (database) => {
    const shared = { ...options, asOfMs, boundedRange: true };
    const health = healthFromDatabase(database, shared);
    const overview = overviewFromDatabase(database, range, shared);
    const calls = callsFromDatabase(database, range, {
      ...shared,
      limit: options.callsLimit ?? options.limit,
    });
    return {
      metric_scope: METRIC_SCOPE,
      status: overview.status,
      as_of: new Date(asOfMs).toISOString(),
      health,
      overview,
      calls,
    };
  });
}

export function createUsageRequestHandler({ databasePath, pagePath, runtimeHealthProvider }) {
  return async function handleUsageRequest(req, res, url) {
    const known = url.pathname === "/usage"
      || url.pathname === "/api/usage/health"
      || url.pathname === "/api/usage/snapshot"
      || url.pathname === "/api/usage/overview"
      || url.pathname === "/api/usage/calls";
    if (!known) return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
      return true;
    }
    try {
      if (url.pathname === "/usage") {
        const html = readFileSync(pagePath, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(html);
        return true;
      }
      const runtimeHealth = runtimeHealthProvider ? await runtimeHealthProvider() : undefined;
      const query = requestOptions(url, runtimeHealth);
      if (url.pathname === "/api/usage/health") {
        sendJson(res, 200, queryUsageHealth(databasePath, query));
      } else if (url.pathname === "/api/usage/snapshot") {
        sendJson(res, 200, queryUsageSnapshot(databasePath, query));
      } else if (url.pathname === "/api/usage/overview") {
        sendJson(res, 200, queryUsageOverview(databasePath, query));
      } else {
        sendJson(res, 200, queryUsageCalls(databasePath, query));
      }
      return true;
    } catch (error) {
      if (error?.code === "CURSOR_EXPIRED") {
        sendJson(res, 409, { error: "CURSOR_EXPIRED" });
      } else if (error?.code === "INVALID_USAGE_QUERY") {
        sendJson(res, 400, {
          error: "invalid_usage_query",
          ...(error.reason ? { reason: error.reason } : {}),
          ...(Number.isFinite(error.maxDays) ? { max_days: error.maxDays } : {}),
        });
      } else {
        sendJson(res, 500, { error: "usage_unavailable" });
      }
      return true;
    }
  };
}

function requestOptions(url, runtimeHealth) {
  return {
    range: url.searchParams.get("range") ?? "today",
    start: url.searchParams.get("from") ?? url.searchParams.get("start") ?? undefined,
    end: url.searchParams.get("to") ?? url.searchParams.get("end") ?? undefined,
    limit: parseOptionalInteger(url.searchParams.get("limit")),
    callsLimit: parseOptionalInteger(url.searchParams.get("calls_limit")),
    cursor: url.searchParams.get("cursor") ?? undefined,
    interval: url.searchParams.get("interval") ?? undefined,
    runtimeHealth,
  };
}

function withSnapshot(databasePath, callback) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("begin");
    const result = callback(database);
    database.exec("rollback");
    return result;
  } catch (error) {
    try { database.exec("rollback"); } catch { /* no open transaction */ }
    throw error;
  } finally {
    database.close();
  }
}

function healthFromDatabase(database, options) {
  const asOfMs = options.asOfMs ?? options.nowMs ?? Date.now();
  const meta = readMeta(database);
  const allRange = boundedAllRange(asOfMs);
  const archiveRange = archivedRange(allRange, asOfMs);
  const retained = aggregateRows(database, allRange, false, asOfMs);
  const archived = aggregateRows(database, archiveRange, true, asOfMs);
  const total = combine([...retained, ...archived]);
  const latest = database.prepare(
    "select max(started_at_ms) as value from usage_calls where started_at_ms <= ?",
  ).get(asOfMs);
  const boots = readBoots(database, asOfMs);
  const epochs = readEstimatorEpochs(database, allRange, archiveRange, asOfMs);
  const current = readCurrentEstimatorEpoch(database, asOfMs);
  const archiveBoundary = readArchiveBoundary(database, allRange, asOfMs);
  const live = options.runtimeHealth;
  const writerState = live?.writer_state ?? boots.active?.runtime_health ?? "UNKNOWN";
  const status = coverageStatus({
    range: allRange,
    meta,
    gaps: boots.gaps,
    total,
    writerState,
    cacheStatus: current?.cache_status ?? "UNKNOWN",
    archiveBoundary,
  });
  return {
    metric_scope: METRIC_SCOPE,
    status,
    reason: total.calls === 0 && !meta.coverage_started_at_ms ? "NO_COVERAGE" : null,
    as_of: new Date(asOfMs).toISOString(),
    writer_state: writerState,
    monitor_health: writerState,
    boot_id: live?.boot_id ?? boots.active?.boot_id ?? null,
    last_successful_write_at: live?.last_successful_write_at
      ?? (live?.last_successful_write_at_ms == null ? null : new Date(live.last_successful_write_at_ms).toISOString()),
    queue_bytes: nullableNonNegativeNumber(live?.queue_bytes ?? live?.queue?.queued_bytes),
    oldest_queue_item_age_ms: nullableNonNegativeNumber(live?.queue?.oldest_queued_age_ms),
    last_tokenizer_success_at: live?.last_tokenizer_success_at_ms == null
      ? null
      : new Date(live.last_tokenizer_success_at_ms).toISOString(),
    failure_counters: live?.failure_counters ?? live?.failure_counts ?? {},
    tokenizer_failure_counts: total.tokenizerFailureCounts,
    tokenizer_cache_status: current?.cache_status ?? "UNKNOWN",
    last_maintenance_at: isoFromMeta(meta.last_maintenance_at_ms),
    coverage_started_at: isoFromMeta(meta.coverage_started_at_ms),
    coverage_gaps: boots.gaps,
    archive_boundary: archiveBoundary,
    latest_call_at: latest.value == null ? null : new Date(Number(latest.value)).toISOString(),
    retained_calls: combine(retained).calls,
    archived_calls: combine(archived).calls,
    total_calls: total.calls,
    partial_calls: total.partialCalls,
    incomplete_calls: total.incompleteCalls,
    tokenizer_unavailable_calls: total.tokenizerUnavailableCalls,
    payload_too_large_calls: total.payloadTooLargeCalls,
    backpressure_calls: total.backpressureCalls,
    dropped_calls: total.payloadTooLargeCalls + total.backpressureCalls,
    unattributed_calls: total.unattributedCalls,
    estimator: estimatorOutput(current),
    estimator_epochs: epochs,
    current_estimator_epoch_id: current?.epoch_id ?? null,
    client_scope: "W",
    attribution: ATTRIBUTION_BASIS,
    attribution_basis: ATTRIBUTION_BASIS,
  };
}

function overviewFromDatabase(database, range, options) {
  const asOfMs = options.asOfMs ?? options.nowMs ?? Date.now();
  const interval = resolveInterval(options.interval, range);
  const queryRange = withSnapshotBound(range, asOfMs);
  const archiveRange = archivedRange(queryRange, asOfMs);
  const meta = readMeta(database);
  const rows = [
    ...aggregateRows(database, queryRange, false, asOfMs),
    ...aggregateRows(database, archiveRange, true, asOfMs),
  ];
  const total = combine(rows);
  const boots = readBoots(database, asOfMs);
  const epochs = readEstimatorEpochs(database, queryRange, archiveRange, asOfMs);
  const current = readCurrentEstimatorEpoch(database, asOfMs);
  const archiveBoundary = readArchiveBoundary(database, queryRange, asOfMs);
  const writerState = options.runtimeHealth?.writer_state ?? boots.active?.runtime_health ?? "UNKNOWN";
  const status = coverageStatus({
    range,
    meta,
    gaps: boots.gaps,
    total,
    writerState,
    cacheStatus: current?.cache_status ?? "UNKNOWN",
    archiveBoundary,
  });
  const durationWhere = appendWhere(queryRange.where, "duration_ms is not null");
  const durationSql = durationWhere.sql
    ? durationWhere.sql
    : "1=1";
  const durations = database.prepare(`
    select duration_ms from usage_calls ${durationSql} order by duration_ms
  `).all(...queryRange.parameters).map((row) => Number(row.duration_ms));
  const sessionSql = queryRange.where || "1=1";
  const sessions = database.prepare(`
    select session_ref, count(*) as calls,
      sum(coalesce(request_tokens, 0) + coalesce(response_tokens, 0)) as estimated_tokens,
      sum(case when request_tokens is not null then 1 else 0 end)
        + sum(case when response_tokens is not null then 1 else 0 end) as known_sides,
      sum(case when outcome = 'IN_PROGRESS' then 1 else 0 end) as in_progress_calls
    from usage_calls ${sessionSql} group by session_ref
    order by estimated_tokens desc, session_ref
  `).all(...queryRange.parameters).map((row) => ({
    session_ref: String(row.session_ref),
    calls: Number(row.calls),
    estimated_tokens: Number(row.known_sides) > 0 ? Number(row.estimated_tokens) : null,
    known_sides: Number(row.known_sides),
    applicable_sides: Number(row.calls) * 2 - Number(row.in_progress_calls),
  }));
  const snapshotStatus = fixedAsOfStatus(range, asOfMs, status);
  const output = {
    metric_scope: METRIC_SCOPE,
    status: snapshotStatus,
    as_of: new Date(asOfMs).toISOString(),
    range: { kind: range.kind, start: range.start, end: range.end, timezone: TIMEZONE },
    exact: exactOutput(total),
    estimated_tokens: tokenOutput(total),
    coverage: {
      started_at: isoFromMeta(meta.coverage_started_at_ms),
      gaps: boots.gaps,
      request: coverageSide(total.requestKnownCalls, total.requestApplicableCalls),
      response: coverageSide(total.responseKnownCalls, total.responseApplicableCalls),
      unknown_response_calls: total.unknownResponseCalls,
      incomplete_calls: total.incompleteCalls,
      partial_calls: total.partialCalls,
      dropped_calls: total.payloadTooLargeCalls + total.backpressureCalls,
      unattributed_calls: total.unattributedCalls,
      archive_boundary: archiveBoundary,
      session_breakdown: "RETAINED_CALLS_ONLY",
    },
    latency_ms: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      retained_call_samples: durations.length,
    },
    estimator: estimatorOutput(current),
    estimator_epochs: epochs,
    current_estimator_epoch_id: current?.epoch_id ?? null,
    client_scope: "W",
    attribution: ATTRIBUTION_BASIS,
    attribution_basis: ATTRIBUTION_BASIS,
    by_day: groupOutput(rows, "local_date", "date"),
    by_tool: groupOutput(rows, "tool", "tool"),
    by_session: sessions,
    exclusions: [
      "W whole-turn context",
      "model output and reasoning",
      "system prompts and conversation history",
      "tool definitions and billing usage",
    ],
  };
  if (interval) Object.assign(output, intervalOverview(database, range, interval, meta, boots.gaps, asOfMs));
  return output;
}

function intervalOverview(database, range, interval, meta, gaps, asOfMs) {
  const bounds = intervalBounds(range, interval, asOfMs);
  const availableFromMs = retainedAvailableFrom(meta, asOfMs);
  const grouped = intervalRows(database, bounds.queryStartMs, bounds.endMs, interval.milliseconds);
  const byStart = new Map(grouped.map((row) => [row.bucketStartMs, row]));
  const buckets = [];
  for (let startMs = bounds.startMs; startMs < bounds.endMs; startMs += interval.milliseconds) {
    const endMs = Math.min(startMs + interval.milliseconds, bounds.endMs);
    const total = byStart.get(startMs) ?? combine([]);
    const status = intervalBucketStatus({
      startMs, endMs, asOfMs, availableFromMs, gaps, total,
      completeEndMs: startMs + interval.milliseconds,
    });
    buckets.push({
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      status,
      calls: total.calls,
      success_calls: total.successCalls,
      failure_calls: total.failureCalls,
      estimated_tokens: intervalTokenOutput(total, status),
    });
  }
  return {
    interval: interval.name,
    interval_scope: INTERVAL_SCOPE,
    available_from: Number.isFinite(availableFromMs) ? new Date(availableFromMs).toISOString() : null,
    by_interval: buckets,
  };
}

function intervalRows(database, startMs, endMs, intervalMs) {
  const rows = database.prepare(`
    select cast(started_at_ms / ? as integer) * ? as bucket_start_ms,
      min(local_date) as local_date, min(tool) as tool, estimator_epoch, outcome,
      request_measurement_status, response_measurement_status,
      request_token_status, response_token_status, attribution_status,
      count(*) as calls,
      sum(request_bytes) as request_bytes, sum(response_bytes) as response_bytes,
      sum(request_characters) as request_characters, sum(response_characters) as response_characters,
      sum(request_tokens) as request_tokens, sum(response_tokens) as response_tokens,
      sum(case when request_bytes is not null then 1 else 0 end) as request_byte_known_calls,
      sum(case when response_bytes is not null then 1 else 0 end) as response_byte_known_calls,
      sum(case when request_characters is not null then 1 else 0 end) as request_character_known_calls,
      sum(case when response_characters is not null then 1 else 0 end) as response_character_known_calls,
      sum(case when request_tokens is not null then 1 else 0 end) as request_known_calls,
      sum(case when response_tokens is not null then 1 else 0 end) as response_known_calls
    from usage_calls
    where started_at_ms >= ? and started_at_ms < ?
    group by bucket_start_ms, estimator_epoch, outcome,
      request_measurement_status, response_measurement_status,
      request_token_status, response_token_status, attribution_status
    order by bucket_start_ms
  `).all(intervalMs, intervalMs, startMs, endMs);
  const groups = new Map();
  for (const row of rows) {
    const bucketStartMs = Number(row.bucket_start_ms);
    const values = groups.get(bucketStartMs) ?? [];
    values.push(normalizeAggregate(row));
    groups.set(bucketStartMs, values);
  }
  return Array.from(groups, ([bucketStartMs, values]) => ({
    bucketStartMs,
    ...combine(values),
  }));
}

function intervalBounds(range, interval, asOfMs) {
  const retainedStartMs = asOfMs - RETAINED_DETAIL_DAYS * 86_400_000;
  const requestedStartMs = range.start
    ? Date.parse(`${range.start}T00:00:00+08:00`)
    : retainedStartMs;
  const requestedEndMs = range.end
    ? Date.parse(`${shiftDate(range.end, 1)}T00:00:00+08:00`)
    : asOfMs;
  const queryStartMs = Math.max(requestedStartMs, retainedStartMs);
  const startMs = Math.floor(queryStartMs / interval.milliseconds)
    * interval.milliseconds;
  return { startMs, queryStartMs, endMs: Math.min(requestedEndMs, asOfMs) };
}

function retainedAvailableFrom(meta, asOfMs) {
  const coverageStartMs = Number(meta.coverage_started_at_ms);
  if (!Number.isFinite(coverageStartMs)) return null;
  return Math.max(coverageStartMs, asOfMs - RETAINED_DETAIL_DAYS * 86_400_000);
}

function intervalBucketStatus({ startMs, endMs, completeEndMs, asOfMs, availableFromMs, gaps, total }) {
  if (!Number.isFinite(availableFromMs) || availableFromMs >= endMs) return "UNKNOWN";
  if (gaps.some((gap) => Number(gap.started_at_ms) <= startMs && Number(gap.ended_at_ms) >= endMs)) {
    return "UNKNOWN";
  }
  const overlapsGap = gaps.some((gap) =>
    Number(gap.started_at_ms) < endMs && Number(gap.ended_at_ms) > startMs);
  if (availableFromMs > startMs || overlapsGap || completeEndMs > asOfMs
    || total.partialCalls > 0 || total.incompleteCalls > 0) {
    return "PARTIAL";
  }
  return "AVAILABLE";
}

function intervalTokenOutput(total, status) {
  if (status === "UNKNOWN" || (status === "PARTIAL" && total.calls === 0)) {
    return {
      request: null, response: null, total: null,
      request_known_calls: 0, request_applicable_calls: 0, request_ratio: null,
      response_known_calls: 0, response_applicable_calls: 0, response_ratio: null,
      total_calls: total.calls,
    };
  }
  const requestApplicable = total.requestApplicableCalls;
  const responseApplicable = total.responseApplicableCalls;
  return {
    request: total.requestKnownCalls > 0 ? total.requestTokens : (total.calls === 0 ? 0 : null),
    response: total.responseKnownCalls > 0 ? total.responseTokens : (total.calls === 0 ? 0 : null),
    total: total.requestKnownCalls + total.responseKnownCalls > 0
      ? (total.requestTokens ?? 0) + (total.responseTokens ?? 0)
      : (total.calls === 0 ? 0 : null),
    request_known_calls: total.requestKnownCalls,
    request_applicable_calls: requestApplicable,
    request_ratio: requestApplicable === 0 ? null : total.requestKnownCalls / requestApplicable,
    response_known_calls: total.responseKnownCalls,
    response_applicable_calls: responseApplicable,
    response_ratio: responseApplicable === 0 ? null : total.responseKnownCalls / responseApplicable,
    total_calls: total.calls,
  };
}

function callsFromDatabase(database, range, options) {
  const asOfMs = options.asOfMs ?? options.nowMs ?? Date.now();
  const queryRange = withSnapshotBound(range, asOfMs);
  const archiveRange = archivedRange(queryRange, asOfMs);
  const limit = clampInteger(options.callsLimit ?? options.limit, 1, 100, 50);
  const meta = readMeta(database);
  const total = combine([
    ...aggregateRows(database, queryRange, false, asOfMs),
    ...aggregateRows(database, archiveRange, true, asOfMs),
  ]);
  const epochs = readEstimatorEpochs(database, queryRange, archiveRange, asOfMs);
  const current = readCurrentEstimatorEpoch(database, asOfMs);
  const archiveBoundary = readArchiveBoundary(database, queryRange, asOfMs);
  const boots = readBoots(database, asOfMs);
  const status = coverageStatus({
    range,
    meta,
    gaps: boots.gaps,
    total,
    writerState: options.runtimeHealth?.writer_state ?? boots.active?.runtime_health ?? "UNKNOWN",
    cacheStatus: current?.cache_status ?? "UNKNOWN",
    archiveBoundary,
  });
  const generation = Number(meta.retention_generation ?? 0);
  const rangeKey = JSON.stringify([range.kind, range.start, range.end]);
  const decoded = options.cursor ? decodeCursor(options.cursor) : null;
  if (decoded && (decoded.retentionGeneration !== generation || decoded.rangeKey !== rangeKey)) {
    throw cursorExpired();
  }
  const rangePredicate = queryRange.where ? queryRange.where.replace(/^where /, "") : "1=1";
  let upper = decoded
    ? { startedAtMs: decoded.upperStartedAtMs, eventId: decoded.upperEventId }
    : database.prepare(`
      select started_at_ms, event_id from usage_calls where ${rangePredicate}
      order by started_at_ms desc, event_id desc limit 1
    `).get(...queryRange.parameters);
  if (!upper) return {
    ...emptyCalls(range, null, asOfMs),
    status,
    estimator_epochs: epochs,
  };
  upper = { startedAtMs: Number(upper.startedAtMs ?? upper.started_at_ms), eventId: String(upper.eventId ?? upper.event_id) };
  const predicates = [
    rangePredicate,
    "(started_at_ms < ? or (started_at_ms = ? and event_id <= ?))",
  ];
  const parameters = [...queryRange.parameters, upper.startedAtMs, upper.startedAtMs, upper.eventId];
  if (decoded) {
    predicates.push("(started_at_ms < ? or (started_at_ms = ? and event_id < ?))");
    parameters.push(decoded.beforeStartedAtMs, decoded.beforeStartedAtMs, decoded.beforeEventId);
  }
  const rows = database.prepare(`
    select event_id, started_at_ms, local_date, session_ref, attribution_status, tool,
      outcome, duration_ms, request_bytes, request_characters, response_bytes,
      response_characters, request_measurement_status, response_measurement_status,
      request_tokens, response_tokens, request_token_status, response_token_status,
      estimator_epoch
    from usage_calls where ${predicates.join(" and ")}
    order by started_at_ms desc, event_id desc limit ?
  `).all(...parameters, limit + 1);
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const items = visible.map(callOutput);
  const last = visible.at(-1);
  const cursor = hasMore && last ? encodeCursor({
    version: 1,
    retentionGeneration: generation,
    rangeKey,
    upperStartedAtMs: upper.startedAtMs,
    upperEventId: upper.eventId,
    beforeStartedAtMs: Number(last.started_at_ms),
    beforeEventId: String(last.event_id),
  }) : null;
  return {
    metric_scope: METRIC_SCOPE,
    status: fixedAsOfStatus(range, asOfMs, status),
    as_of: new Date(asOfMs).toISOString(),
    range: { kind: range.kind, start: range.start, end: range.end, timezone: TIMEZONE },
    attribution_basis: ATTRIBUTION_BASIS,
    estimator_epochs: epochs,
    current_estimator_epoch_id: current?.epoch_id ?? null,
    archive_boundary: archiveBoundary,
    snapshot_upper_bound: encodeCursor({ startedAtMs: upper.startedAtMs, eventId: upper.eventId }),
    items,
    next_cursor: cursor,
  };
}

function aggregateRows(database, range, archived) {
  if (archived) {
    return database.prepare(`
      select local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status,
        call_count as calls, request_bytes, response_bytes, request_characters,
        response_characters, request_tokens, response_tokens,
        request_byte_known_calls, response_byte_known_calls,
        request_character_known_calls, response_character_known_calls,
        request_token_known_calls as request_known_calls,
        response_token_known_calls as response_known_calls,
        duration_sum_ms, duration_known_calls
      from usage_daily ${range.where}
    `).all(...range.parameters).map(normalizeAggregate);
  }
  return database.prepare(`
    select local_date, tool, estimator_epoch, outcome,
      request_measurement_status, response_measurement_status,
      request_token_status, response_token_status, attribution_status,
      count(*) as calls,
      sum(request_bytes) as request_bytes,
      sum(response_bytes) as response_bytes,
      sum(request_characters) as request_characters,
      sum(response_characters) as response_characters,
      sum(request_tokens) as request_tokens,
      sum(response_tokens) as response_tokens,
      sum(case when request_bytes is not null then 1 else 0 end) as request_byte_known_calls,
      sum(case when response_bytes is not null then 1 else 0 end) as response_byte_known_calls,
      sum(case when request_characters is not null then 1 else 0 end) as request_character_known_calls,
      sum(case when response_characters is not null then 1 else 0 end) as response_character_known_calls,
      sum(case when request_tokens is not null then 1 else 0 end) as request_known_calls,
      sum(case when response_tokens is not null then 1 else 0 end) as response_known_calls,
      sum(coalesce(duration_ms, 0)) as duration_sum_ms,
      sum(case when duration_ms is not null then 1 else 0 end) as duration_known_calls
    from usage_calls ${range.where}
    group by local_date, tool, estimator_epoch, outcome,
      request_measurement_status, response_measurement_status,
      request_token_status, response_token_status, attribution_status
  `).all(...range.parameters).map(normalizeAggregate);
}

function normalizeAggregate(row) {
  const calls = Number(row.calls ?? 0);
  const incompleteOutcome = ["IN_PROGRESS", "INTERRUPTED"].includes(row.outcome);
  const inProgressCalls = row.outcome === "IN_PROGRESS" ? calls : 0;
  const responseApplicable = calls - inProgressCalls;
  const tokenStatuses = [row.request_token_status, row.response_token_status];
  const tokenizerFailureCounts = {};
  for (const status of tokenStatuses) {
    if (TOKENIZER_FAILURE_STATUSES.has(status)) {
      tokenizerFailureCounts[status] = (tokenizerFailureCounts[status] ?? 0) + calls;
    }
  }
  const partial = row.request_token_status !== "AVAILABLE"
    || row.response_token_status !== "AVAILABLE";
  const incomplete = incompleteOutcome
    || [row.request_measurement_status, row.response_measurement_status].includes("PENDING")
    || tokenStatuses.some((status) =>
      ["PENDING", "SHUTDOWN_INCOMPLETE", "PROCESS_INTERRUPTED"].includes(status)
      || TOKENIZER_FAILURE_STATUSES.has(status));
  return {
    local_date: String(row.local_date),
    tool: String(row.tool),
    estimatorEpoch: String(row.estimator_epoch),
    calls,
    successCalls: row.outcome === "SUCCESS" ? calls : 0,
    failureCalls: row.outcome === "ERROR" ? calls : 0,
    requestBytes: nullableNumber(row.request_bytes),
    responseBytes: nullableNumber(row.response_bytes),
    requestCharacters: nullableNumber(row.request_characters),
    responseCharacters: nullableNumber(row.response_characters),
    requestTokens: nullableNumber(row.request_tokens),
    responseTokens: nullableNumber(row.response_tokens),
    requestByteKnownCalls: Number(row.request_byte_known_calls ?? 0),
    responseByteKnownCalls: Number(row.response_byte_known_calls ?? 0),
    requestCharacterKnownCalls: Number(row.request_character_known_calls ?? 0),
    responseCharacterKnownCalls: Number(row.response_character_known_calls ?? 0),
    requestKnownCalls: Number(row.request_known_calls ?? 0),
    responseKnownCalls: Number(row.response_known_calls ?? 0),
    requestApplicableCalls: calls,
    responseApplicableCalls: responseApplicable,
    unknownResponseCalls: row.response_token_status === "UNKNOWN_RESPONSE" ? calls : 0,
    partialCalls: partial ? calls : 0,
    incompleteCalls: incomplete ? calls : 0,
    unattributedCalls: row.attribution_status === "UNATTRIBUTED" ? calls : 0,
    tokenizerUnavailableCalls: tokenStatuses.some((status) => TOKENIZER_FAILURE_STATUSES.has(status)) ? calls : 0,
    tokenizerFailureCounts,
    payloadTooLargeCalls: [row.request_token_status, row.response_token_status]
      .includes("PAYLOAD_TOO_LARGE") ? calls : 0,
    backpressureCalls: [row.request_token_status, row.response_token_status]
      .includes("TOKENIZER_BACKPRESSURE") ? calls : 0,
  };
}

function combine(rows) {
  const total = {
    calls: 0, successCalls: 0, failureCalls: 0,
    requestBytes: null, responseBytes: null, requestCharacters: null, responseCharacters: null,
    requestTokens: null, responseTokens: null,
    requestByteKnownCalls: 0, responseByteKnownCalls: 0,
    requestCharacterKnownCalls: 0, responseCharacterKnownCalls: 0,
    requestKnownCalls: 0, responseKnownCalls: 0,
    requestApplicableCalls: 0, responseApplicableCalls: 0, partialCalls: 0,
    incompleteCalls: 0, unattributedCalls: 0, tokenizerUnavailableCalls: 0,
    payloadTooLargeCalls: 0, backpressureCalls: 0, unknownResponseCalls: 0,
    tokenizerFailureCounts: {},
  };
  for (const row of rows) {
    total.calls += row.calls;
    total.successCalls += row.successCalls;
    total.failureCalls += row.failureCalls;
    total.requestByteKnownCalls += row.requestByteKnownCalls;
    total.responseByteKnownCalls += row.responseByteKnownCalls;
    total.requestCharacterKnownCalls += row.requestCharacterKnownCalls;
    total.responseCharacterKnownCalls += row.responseCharacterKnownCalls;
    total.requestKnownCalls += row.requestKnownCalls;
    total.responseKnownCalls += row.responseKnownCalls;
    total.requestApplicableCalls += row.requestApplicableCalls;
    total.responseApplicableCalls += row.responseApplicableCalls;
    total.partialCalls += row.partialCalls;
    total.incompleteCalls += row.incompleteCalls;
    total.unattributedCalls += row.unattributedCalls;
    total.tokenizerUnavailableCalls += row.tokenizerUnavailableCalls;
    for (const [status, calls] of Object.entries(row.tokenizerFailureCounts)) {
      total.tokenizerFailureCounts[status] = (total.tokenizerFailureCounts[status] ?? 0) + calls;
    }
    total.payloadTooLargeCalls += row.payloadTooLargeCalls;
    total.backpressureCalls += row.backpressureCalls;
    total.unknownResponseCalls += row.unknownResponseCalls;
    total.requestBytes = addKnown(total.requestBytes, row.requestBytes);
    total.responseBytes = addKnown(total.responseBytes, row.responseBytes);
    total.requestCharacters = addKnown(total.requestCharacters, row.requestCharacters);
    total.responseCharacters = addKnown(total.responseCharacters, row.responseCharacters);
    total.requestTokens = addKnown(total.requestTokens, row.requestTokens);
    total.responseTokens = addKnown(total.responseTokens, row.responseTokens);
  }
  return total;
}

function addKnown(total, value) {
  return value == null ? total : (total ?? 0) + value;
}

function coverageStatus({ range, meta, gaps, total, writerState, cacheStatus, archiveBoundary }) {
  const partial = () => "PARTIAL";
  const startedAtMs = Number(meta.coverage_started_at_ms);
  if (!Number.isFinite(startedAtMs)) {
    return "UNKNOWN";
  }
  const started = hongKongDate(startedAtMs);
  if (range.end && range.end < started) {
    return "UNKNOWN";
  }
  if (!range.start || range.start <= started) {
    return partial();
  }
  if (gaps.some((gap) => gapOverlapsRange(gap, range))) {
    return partial();
  }
  if (archiveBoundary.uncertain_legacy_calls > 0
    || archiveBoundary.crossing_calls > 0) {
    return partial();
  }
  if (writerState !== "ACTIVE") {
    return partial();
  }
  if (cacheStatus !== "VERIFIED") {
    return partial();
  }
  if (total.partialCalls > 0) {
    return partial();
  }
  if (total.incompleteCalls > 0) {
    return partial();
  }
  return "AVAILABLE";
}

function gapOverlapsRange(gap, range) {
  if (!range.start && !range.end) return true;
  const start = hongKongDate(Number(gap.started_at_ms));
  const end = hongKongDate(Number(gap.ended_at_ms));
  return (!range.end || start <= range.end) && (!range.start || end >= range.start);
}

function readBoots(database, asOfMs = Number.POSITIVE_INFINITY) {
  const active = database.prepare(`
    select boot_id, started_at_ms, heartbeat_at_ms, status, runtime_health
    from usage_boots
    where status = 'ACTIVE' and started_at_ms <= ?
    order by started_at_ms desc limit 1
  `).get(asOfMs);
  const gaps = database.prepare(`
    select started_at_ms, ended_at_ms, reason
    from usage_gaps
    where started_at_ms <= ?
    order by started_at_ms
  `).all(asOfMs).map((row) => ({
    started_at_ms: Number(row.started_at_ms),
    ended_at_ms: Math.min(Number(row.ended_at_ms), asOfMs),
    reason: String(row.reason),
  }));
  return { active, gaps };
}

function readEstimatorEpochs(database, retainedRange, archiveRange, asOfMs) {
  const epochIds = database.prepare(`
    select distinct estimator_epoch from usage_calls
    ${retainedRange.where || ""}
    union
    select distinct estimator_epoch from usage_daily
    ${archiveRange.where || ""}
  `).all(...retainedRange.parameters, ...archiveRange.parameters)
    .map((row) => String(row.estimator_epoch));
  if (epochIds.length === 0) return [];
  const placeholders = epochIds.map(() => "?").join(",");
  return database.prepare(`
    select epoch_id, package, version, encoding, algorithm_version, worker_sha256, cache_status, created_at_ms
    from usage_estimator_epochs
    where epoch_id in (${placeholders}) and created_at_ms <= ?
    order by created_at_ms
  `).all(...epochIds, asOfMs).map(epochOutput);
}

function epochOutput(row) {
  const output = {
    epoch_id: String(row.epoch_id),
    package: String(row.package),
    version: String(row.version),
    encoding: String(row.encoding),
    algorithm_version: String(row.algorithm_version),
    worker_sha256: String(row.worker_sha256),
    cache_status: String(row.cache_status),
    created_at: new Date(Number(row.created_at_ms)).toISOString(),
  };
  Object.defineProperty(output, "created_at_ms", {
    value: Number(row.created_at_ms),
    enumerable: false,
  });
  return output;
}

function estimatorOutput(epoch) {
  return epoch ? {
    package: epoch.package,
    version: epoch.version,
    encoding: epoch.encoding,
    algorithm_version: epoch.algorithm_version,
  } : DEFAULT_ESTIMATOR;
}

function readCurrentEstimatorEpoch(database, asOfMs) {
  const row = database.prepare(`
    select epoch_id, package, version, encoding, algorithm_version, worker_sha256, cache_status, created_at_ms
    from usage_estimator_epochs
    where created_at_ms <= ?
    order by created_at_ms desc, epoch_id desc limit 1
  `).get(asOfMs);
  return row ? epochOutput(row) : null;
}

function callOutput(row) {
  return {
    event_id: String(row.event_id),
    started_at: new Date(Number(row.started_at_ms)).toISOString(),
    local_date: String(row.local_date),
    session_ref: String(row.session_ref),
    attribution_status: String(row.attribution_status),
    tool: String(row.tool),
    outcome: String(row.outcome),
    duration_ms: nullableNumber(row.duration_ms),
    request_bytes: nullableNumber(row.request_bytes),
    request_characters: nullableNumber(row.request_characters),
    response_bytes: nullableNumber(row.response_bytes),
    response_characters: nullableNumber(row.response_characters),
    request_measurement_status: String(row.request_measurement_status),
    response_measurement_status: String(row.response_measurement_status),
    request_tokens: nullableNumber(row.request_tokens),
    response_tokens: nullableNumber(row.response_tokens),
    request_token_status: String(row.request_token_status),
    response_token_status: String(row.response_token_status),
    estimator_epoch: String(row.estimator_epoch),
  };
}

function exactOutput(total) {
  return {
    calls: total.calls,
    success_calls: total.successCalls,
    failure_calls: total.failureCalls,
    request_bytes: total.requestBytes,
    response_bytes: total.responseBytes,
    total_bytes: addKnown(total.requestBytes, total.responseBytes),
    request_characters: total.requestCharacters,
    response_characters: total.responseCharacters,
    total_characters: addKnown(total.requestCharacters, total.responseCharacters),
    coverage: {
      request_bytes: coverageSide(total.requestByteKnownCalls, total.calls),
      response_bytes: coverageSide(total.responseByteKnownCalls, total.responseApplicableCalls),
      request_characters: coverageSide(total.requestCharacterKnownCalls, total.calls),
      response_characters: coverageSide(total.responseCharacterKnownCalls, total.responseApplicableCalls),
    },
    status: {
      request_bytes: exactSideStatus(total.requestBytes, total.requestByteKnownCalls, total.calls),
      response_bytes: exactSideStatus(total.responseBytes, total.responseByteKnownCalls, total.responseApplicableCalls),
      request_characters: exactSideStatus(total.requestCharacters, total.requestCharacterKnownCalls, total.calls),
      response_characters: exactSideStatus(total.responseCharacters, total.responseCharacterKnownCalls, total.responseApplicableCalls),
    },
  };
}

function tokenOutput(total) {
  return {
    request: total.requestKnownCalls > 0 ? total.requestTokens : null,
    response: total.responseKnownCalls > 0 ? total.responseTokens : null,
    total: total.requestKnownCalls + total.responseKnownCalls > 0
      ? total.requestTokens + total.responseTokens
      : null,
    request_known_calls: total.requestKnownCalls,
    request_applicable_calls: total.requestApplicableCalls,
    response_known_calls: total.responseKnownCalls,
    response_applicable_calls: total.responseApplicableCalls,
    total_calls: total.calls,
  };
}

function allRangeUnbounded() {
  return { kind: "all", start: null, end: null, where: "", parameters: [] };
}

function boundedAllRange(asOfMs) {
  return {
    kind: "all",
    start: null,
    end: hongKongDate(asOfMs),
    where: "where started_at_ms <= ?",
    parameters: [asOfMs],
  };
}

function archivedRange(range, asOfMs) {
  const predicates = [];
  const parameters = [];
  if (range.start) {
    predicates.push("local_date >= ?");
    parameters.push(range.start);
  }
  if (range.end) {
    predicates.push("local_date <= ?");
    parameters.push(range.end);
  }
  predicates.push(`(
    (
      event_started_at_min_ms is not null
      and event_started_at_max_ms is not null
      and event_started_at_min_ms <= ?
      and event_started_at_max_ms <= ?
    )
    or (
      (event_started_at_min_ms is null or event_started_at_max_ms is null)
      and local_date < ?
    )
  )`);
  parameters.push(asOfMs, asOfMs, hongKongDate(asOfMs));
  return {
    ...range,
    where: `where ${predicates.join(" and ")}`,
    parameters,
  };
}

function readArchiveBoundary(database, range, asOfMs) {
  const predicates = [];
  const parameters = [];
  if (range.start) {
    predicates.push("local_date >= ?");
    parameters.push(range.start);
  }
  if (range.end) {
    predicates.push("local_date <= ?");
    parameters.push(range.end);
  }
  const where = predicates.length > 0 ? `where ${predicates.join(" and ")}` : "";
  const asOfDate = hongKongDate(asOfMs);
  const row = database.prepare(`
    select
      sum(case when (event_started_at_min_ms is null or event_started_at_max_ms is null)
        and local_date < ?
        then call_count else 0 end) as legacy_calls,
      sum(case when (event_started_at_min_ms is null or event_started_at_max_ms is null)
        and not (local_date < ?)
        then call_count else 0 end) as uncertain_legacy_calls,
      sum(case when event_started_at_min_ms is not null and event_started_at_max_ms is not null
        and event_started_at_min_ms <= ? and event_started_at_max_ms > ?
        then call_count else 0 end) as crossing_calls,
      sum(case when event_started_at_min_ms is not null and event_started_at_max_ms is not null
        and event_started_at_max_ms <= ?
        then call_count else 0 end) as bounded_calls
    from usage_daily ${where}
  `).get(asOfDate, asOfDate, asOfMs, asOfMs, asOfMs, ...parameters);
  const boundary = {
    status: "AVAILABLE",
    provenance: "EVENT_BOUNDED",
    legacy_calls: Number(row.legacy_calls ?? 0),
    legacy_provenance: Number(row.legacy_calls ?? 0) > 0 ? "LEGACY_DAY_BOUNDED" : null,
    uncertain_legacy_calls: Number(row.uncertain_legacy_calls ?? 0),
    crossing_calls: Number(row.crossing_calls ?? 0),
    bounded_calls: Number(row.bounded_calls ?? 0),
  };
  if (boundary.uncertain_legacy_calls > 0) boundary.provenance = "BOUNDARY_UNCERTAIN";
  else if (boundary.crossing_calls > 0) boundary.provenance = "CROSSING_BUCKET_EXCLUDED";
  else if (boundary.legacy_calls > 0) boundary.provenance = "LEGACY_DAY_BOUNDED_MIXED";
  if (boundary.legacy_calls > 0
    || boundary.uncertain_legacy_calls > 0
    || boundary.crossing_calls > 0) boundary.status = "PARTIAL";
  return boundary;
}

function withSnapshotBound(range, asOfMs) {
  const predicates = [];
  const parameters = [];
  if (range.where) {
    predicates.push(range.where.replace(/^where /, ""));
    parameters.push(...range.parameters);
  }
  predicates.push("started_at_ms <= ?");
  parameters.push(asOfMs);
  return {
    ...range,
    where: `where ${predicates.join(" and ")}`,
    parameters,
  };
}

function fixedAsOfStatus(range, asOfMs, current) {
  const rangeEndMs = range.end
    ? Date.parse(`${range.end}T23:59:59.999+08:00`)
    : Number.POSITIVE_INFINITY;
  if (rangeEndMs <= asOfMs) return current;
  return current === "UNKNOWN" ? "UNKNOWN" : "PARTIAL";
}

function coverageSide(known, applicable) {
  return {
    known_calls: known,
    applicable_calls: applicable,
    ratio: applicable === 0 ? null : known / applicable,
  };
}

function exactSideStatus(value, known, applicable) {
  if (value == null || known === 0) return applicable === 0 ? "NOT_APPLICABLE" : "UNKNOWN";
  return known < applicable ? "PARTIAL" : "AVAILABLE";
}

function groupOutput(rows, sourceKey, outputKey) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[sourceKey];
    const values = groups.get(key) ?? [];
    values.push(row);
    groups.set(key, values);
  }
  return Array.from(groups, ([key, values]) => {
    const total = combine(values);
    const exact = exactOutput(total);
    return {
      [outputKey]: key,
      ...exact,
      exact,
      estimated_tokens: tokenOutput(total),
    };
  }).sort((left, right) => outputKey === "date"
    ? String(left[outputKey]).localeCompare(String(right[outputKey]))
    : (right.estimated_tokens.total ?? -1) - (left.estimated_tokens.total ?? -1)
      || right.calls - left.calls
      || String(left[outputKey]).localeCompare(String(right[outputKey])));
}

function resolveRange(options) {
  const kind = options.range ?? "today";
  const today = hongKongDate(options.nowMs ?? Date.now());
  if (kind === "all") return allRangeUnbounded();
  if (kind === "custom") {
    const start = validatedDate(options.start, "start");
    const end = validatedDate(options.end, "end");
    if (start > end) throw new Error("start must not be after end");
    if (daysInclusive(start, end) > 366) throw new Error("custom range must not exceed 366 days");
    return dateRange(kind, start, end);
  }
  if (kind === "today") return dateRange(kind, today, today);
  if (kind === "7d") return dateRange(kind, shiftDate(today, -6), today);
  if (kind === "30d") return dateRange(kind, shiftDate(today, -29), today);
  throw invalidQuery("unsupported range");
}

function resolveInterval(value, range) {
  if (value == null || value === "") return null;
  const definition = INTERVALS[value];
  if (!definition) throw invalidQuery("unsupported interval", "unsupported_interval");
  const requestedDays = range.start && range.end
    ? daysInclusive(range.start, range.end)
    : Number.POSITIVE_INFINITY;
  if (requestedDays > definition.maxDays) {
    throw invalidQuery("interval range too large", "interval_range_too_large", definition.maxDays);
  }
  return { name: value, ...definition };
}

function dateRange(kind, start, end) {
  return {
    kind,
    start,
    end,
    where: "where local_date >= ? and local_date <= ?",
    parameters: [start, end],
    localDateOnly: true,
  };
}

function validatedDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidQuery(`${name} must be YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) throw invalidQuery(`${name} must be a valid calendar date`);
  return value;
}

function daysInclusive(start, end) {
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

function hongKongDate(timestampMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function readMeta(database) {
  return Object.fromEntries(database.prepare("select key, value from usage_meta").all()
    .map((row) => [String(row.key), String(row.value)]));
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}

function appendWhere(where, predicate) {
  return { sql: where ? `${where} and ${predicate}` : `where ${predicate}` };
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded.version !== 1
      || !Number.isSafeInteger(decoded.retentionGeneration)
      || typeof decoded.rangeKey !== "string"
      || !Number.isFinite(decoded.upperStartedAtMs)
      || typeof decoded.upperEventId !== "string"
      || !Number.isFinite(decoded.beforeStartedAtMs)
      || typeof decoded.beforeEventId !== "string") throw new Error("invalid cursor");
    return decoded;
  } catch {
    throw new Error("invalid cursor");
  }
}

function cursorExpired() {
  return Object.assign(new Error("cursor expired"), { code: "CURSOR_EXPIRED" });
}

function unknownHealth(reason, options = {}) {
  const asOfMs = options.asOfMs ?? options.nowMs ?? Date.now();
  const live = options.runtimeHealth;
  const writerState = live?.writer_state ?? "UNKNOWN";
  return {
    metric_scope: METRIC_SCOPE,
    status: "UNKNOWN",
    reason,
    as_of: new Date(asOfMs).toISOString(),
    writer_state: writerState,
    monitor_health: writerState,
    boot_id: live?.boot_id ?? null,
    last_successful_write_at: live?.last_successful_write_at
      ?? (live?.last_successful_write_at_ms == null ? null : new Date(live.last_successful_write_at_ms).toISOString()),
    queue_bytes: nullableNonNegativeNumber(live?.queue_bytes ?? live?.queue?.queued_bytes),
    oldest_queue_item_age_ms: nullableNonNegativeNumber(live?.queue?.oldest_queued_age_ms),
    last_tokenizer_success_at: live?.last_tokenizer_success_at_ms == null
      ? null
      : new Date(live.last_tokenizer_success_at_ms).toISOString(),
    failure_counters: live?.failure_counters ?? live?.failure_counts ?? {},
    tokenizer_failure_counts: {},
    tokenizer_cache_status: "UNKNOWN",
    last_maintenance_at: null,
    coverage_started_at: null,
    coverage_gaps: [],
    latest_call_at: null,
    retained_calls: 0,
    archived_calls: 0,
    total_calls: 0,
    partial_calls: 0,
    incomplete_calls: 0,
    tokenizer_unavailable_calls: 0,
    payload_too_large_calls: 0,
    backpressure_calls: 0,
    dropped_calls: 0,
    unattributed_calls: 0,
    estimator: DEFAULT_ESTIMATOR,
    estimator_epochs: [],
    client_scope: "W",
    attribution: ATTRIBUTION_BASIS,
    attribution_basis: ATTRIBUTION_BASIS,
  };
}

function emptyOverview(range, reason, asOfMs = Date.now(), interval = null) {
  const total = combine([]);
  const output = {
    metric_scope: METRIC_SCOPE,
    status: "UNKNOWN",
    reason,
    as_of: new Date(asOfMs).toISOString(),
    range: { kind: range.kind, start: range.start, end: range.end, timezone: TIMEZONE },
    exact: exactOutput(total),
    estimated_tokens: tokenOutput(total),
    coverage: {
      started_at: null, gaps: [], request: coverageSide(0, 0), response: coverageSide(0, 0),
      unknown_response_calls: 0, incomplete_calls: 0, partial_calls: 0, dropped_calls: 0,
      unattributed_calls: 0,
      session_breakdown: "RETAINED_CALLS_ONLY",
    },
    latency_ms: { p50: null, p95: null, retained_call_samples: 0 },
    estimator: DEFAULT_ESTIMATOR,
    estimator_epochs: [],
    client_scope: "W",
    attribution: ATTRIBUTION_BASIS,
    attribution_basis: ATTRIBUTION_BASIS,
    by_day: [], by_tool: [], by_session: [],
    exclusions: ["W whole-turn context", "model output and reasoning", "system prompts and conversation history", "tool definitions and billing usage"],
  };
  if (interval) Object.assign(output, {
    interval: interval.name,
    interval_scope: INTERVAL_SCOPE,
    available_from: null,
    by_interval: [],
  });
  return output;
}

function emptyCalls(range, reason, asOfMs = Date.now()) {
  return {
    metric_scope: METRIC_SCOPE,
    status: "UNKNOWN",
    reason,
    as_of: new Date(asOfMs).toISOString(),
    range: { kind: range.kind, start: range.start, end: range.end, timezone: TIMEZONE },
    attribution_basis: ATTRIBUTION_BASIS,
    estimator_epochs: [],
    snapshot_upper_bound: null,
    items: [],
    next_cursor: null,
  };
}

function isoFromMeta(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Date(numeric).toISOString() : null;
}

function isoDateFromMeta(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? hongKongDate(numeric) : null;
}

function nullableNumber(value) { return value == null ? null : Number(value); }
function nullableNonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}
function parseOptionalInteger(value) {
  if (value == null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw invalidQuery("integer query parameter is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidQuery("integer query parameter is invalid");
  return parsed;
}
function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

function invalidQuery(message, reason, maxDays) {
  return Object.assign(new Error(message), {
    code: "INVALID_USAGE_QUERY",
    ...(reason ? { reason } : {}),
    ...(Number.isFinite(maxDays) ? { maxDays } : {}),
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}
