import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadOrCreateIdentityKey, pseudonymizeSession } from "./usage-identity.js";
import type { PayloadMeasurement } from "./usage-metrics.js";

export const ESTIMATOR_PACKAGE = "tiktoken";
export const ESTIMATOR_VERSION = "0.14.0";
export const ESTIMATOR_ENCODING = "o200k_base";
export const ALGORITHM_VERSION = "mcp-visible-v3";
export const ESTIMATOR_CACHE_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";
export const USAGE_TIMEZONE = "Asia/Hong_Kong";
const HONG_KONG_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: USAGE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function estimatorEpochFor(workerSha256: string): string {
  return `${ESTIMATOR_PACKAGE}:${ESTIMATOR_VERSION}:${ESTIMATOR_ENCODING}:${ALGORITHM_VERSION}:worker-${workerSha256}`;
}

export type Outcome = "IN_PROGRESS" | "SUCCESS" | "ERROR" | "INTERRUPTED";
export type MeasurementStatus = "PENDING" | "AVAILABLE" | "MEASUREMENT_ERROR" | "MEASUREMENT_UNSUPPORTED" | "UNKNOWN_RESPONSE";
export type SideTokenStatus =
  | "PENDING"
  | "AVAILABLE"
  | "PARTIAL_UNSUPPORTED_MEDIA"
  | "TOKENIZER_UNAVAILABLE"
  | "TOKENIZER_WORKER_STARTUP_ERROR"
  | "TOKENIZER_WORKER_EXIT"
  | "TOKENIZER_PROTOCOL_ERROR"
  | "TOKENIZER_ENCODE_ERROR"
  | "TOKENIZER_TIMEOUT"
  | "TOKENIZER_CIRCUIT_OPEN"
  | "PAYLOAD_TOO_LARGE"
  | "TOKENIZER_BACKPRESSURE"
  | "MEASUREMENT_ERROR"
  | "MEASUREMENT_UNSUPPORTED"
  | "UNKNOWN_RESPONSE"
  | "SHUTDOWN_INCOMPLETE"
  | "PROCESS_INTERRUPTED";

export interface UsageCallRow {
  sequence: number;
  event_id: string;
  boot_id: string;
  started_at_ms: number;
  finished_at_ms: number | null;
  local_date: string;
  session_ref: string;
  attribution_status: "ATTRIBUTED" | "UNATTRIBUTED";
  tool: string;
  outcome: Outcome;
  duration_ms: number | null;
  request_bytes: number | null;
  request_characters: number | null;
  response_bytes: number | null;
  response_characters: number | null;
  request_measurement_status: MeasurementStatus;
  response_measurement_status: MeasurementStatus;
  request_tokens: number | null;
  response_tokens: number | null;
  request_token_status: SideTokenStatus;
  response_token_status: SideTokenStatus;
  estimator_epoch: string;
  token_status: SideTokenStatus | "MIXED";
}

export interface UsageSummary {
  calls: number;
  requestTokens: number | null;
  responseTokens: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
}

export interface RuntimeFacts {
  current_boot_id: string;
  current_boot_status: "ACTIVE" | "STOPPED" | "INTERRUPTED";
  heartbeat_at_ms: number;
  interrupted_boots: number;
  gaps: Array<{ started_at_ms: number; ended_at_ms: number; reason: string }>;
}

export interface UsageStore {
  sessionRef(rawSession: string | undefined): string;
  startCallMinimal(input: { eventId: string; tool: string; sessionRef: string; startedAtMs: number }): boolean;
  setRequestMeasurement(eventId: string, request: PayloadMeasurement): void;
  failRequestMeasurement(eventId: string, status?: "MEASUREMENT_ERROR" | "MEASUREMENT_UNSUPPORTED"): void;
  startCall(input: {
    eventId: string; tool: string; sessionRef: string; startedAtMs: number; request: PayloadMeasurement;
  }): boolean;
  finishCall(input: {
    eventId: string; outcome?: "SUCCESS" | "ERROR"; success?: boolean;
    durationMs: number; request?: PayloadMeasurement; response?: PayloadMeasurement;
    requestMeasurementStatus?: "MEASUREMENT_ERROR" | "MEASUREMENT_UNSUPPORTED";
    responseMeasurementStatus?: "MEASUREMENT_ERROR" | "MEASUREMENT_UNSUPPORTED";
  }): void;
  setSideTokenCount(input: {
    eventId: string; side: "request" | "response"; tokens: number | null; status: SideTokenStatus;
  }): void;
  setTokenCounts(input: {
    eventId: string; requestTokens: number | null; responseTokens: number | null; status: SideTokenStatus;
  }): void;
  terminalizePending(status: "SHUTDOWN_INCOMPLETE" | "TOKENIZER_UNAVAILABLE"): number;
  heartbeat(nowMs: number, runtimeHealth?: "ACTIVE" | "DEGRADED"): void;
  runtimeFacts(): RuntimeFacts;
  listCalls(input: { limit: number; beforeStartedAtMs?: number }): UsageCallRow[];
  summarizeAll(): UsageSummary;
  runRetention(nowMs: number, retentionDays: number): { rolledCalls: number; deletedCalls: number };
  close(options?: { clean?: boolean; nowMs?: number }): void;
}

export function openUsageStore(
  directory: string,
  options: { identityKey?: Buffer; bootId?: string; nowMs?: number; workerSha256?: string } = {},
): UsageStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const identityKey = loadOrCreateIdentityKey(directory, options.identityKey);
  const databasePath = join(directory, "usage.sqlite");
  const database = new Database(databasePath);
  chmodSync(databasePath, 0o600);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
  const workerSha256 = options.workerSha256 ?? "UNSPECIFIED";
  const epochId = estimatorEpochFor(workerSha256);
  migrate(database, workerSha256, epochId);

  const bootId = options.bootId ?? randomUUID();
  const openedAtMs = options.nowMs ?? Date.now();
  beginBoot(database, bootId, openedAtMs);

  const insertCall = database.prepare(`
    insert or ignore into usage_calls (
      event_id, boot_id, started_at_ms, local_date, session_ref, attribution_status,
      tool, outcome, request_measurement_status, response_measurement_status,
      request_token_status, response_token_status, estimator_epoch
    ) values (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', 'PENDING', 'PENDING', 'PENDING', 'PENDING', ?)
  `);
  const setRequest = database.prepare(`
    update usage_calls set request_bytes = ?, request_characters = ?,
      request_measurement_status = 'AVAILABLE', request_token_status = 'PENDING'
    where event_id = ?
  `);
  const failRequest = database.prepare(`
    update usage_calls set request_measurement_status = ?, request_token_status = ?
    where event_id = ?
  `);
  const finish = database.prepare(`
    update usage_calls set finished_at_ms = ?, outcome = ?, duration_ms = ?,
      request_bytes = coalesce(?, request_bytes), request_characters = coalesce(?, request_characters),
      request_measurement_status = coalesce(?, request_measurement_status),
      request_token_status = coalesce(?, request_token_status),
      response_bytes = ?, response_characters = ?,
      response_measurement_status = ?, response_token_status = ?
    where event_id = ?
  `);
  const setRequestTokens = database.prepare(
    "update usage_calls set request_tokens = ?, request_token_status = ? where event_id = ?",
  );
  const setResponseTokens = database.prepare(
    "update usage_calls set response_tokens = ?, response_token_status = ? where event_id = ?",
  );
  const setEstimatorCacheStatus = database.prepare(
    "update usage_estimator_epochs set cache_status = ? where epoch_id = ?",
  );

  const runRetentionTransaction = database.transaction((nowMs: number, retentionDays: number) => {
    const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1_000;
    const totalsBefore = historyTotals(database);
    const aggregates = database.prepare(`
      select local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status,
        count(*) as call_count,
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
        sum(case when request_tokens is not null then 1 else 0 end) as request_token_known_calls,
        sum(case when response_tokens is not null then 1 else 0 end) as response_token_known_calls,
        sum(coalesce(duration_ms, 0)) as duration_sum_ms,
        sum(case when duration_ms is not null then 1 else 0 end) as duration_known_calls,
        min(started_at_ms) as event_started_at_min_ms,
        max(started_at_ms) as event_started_at_max_ms
      from usage_calls where started_at_ms < ?
      group by local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status
    `).all(cutoffMs) as Array<Record<string, string | number>>;
    const upsert = database.prepare(`
      insert into usage_daily (
        local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status,
        call_count, request_bytes, response_bytes, request_characters, response_characters,
        request_byte_known_calls, response_byte_known_calls,
        request_character_known_calls, response_character_known_calls,
        request_tokens, response_tokens, request_token_known_calls, response_token_known_calls,
        duration_sum_ms, duration_known_calls, aggregated_at_ms,
        event_started_at_min_ms, event_started_at_max_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status)
      do update set
        call_count = call_count + excluded.call_count,
        request_bytes = case
          when request_byte_known_calls + excluded.request_byte_known_calls = 0 then null
          else coalesce(request_bytes, 0) + coalesce(excluded.request_bytes, 0) end,
        response_bytes = case
          when response_byte_known_calls + excluded.response_byte_known_calls = 0 then null
          else coalesce(response_bytes, 0) + coalesce(excluded.response_bytes, 0) end,
        request_characters = case
          when request_character_known_calls + excluded.request_character_known_calls = 0 then null
          else coalesce(request_characters, 0) + coalesce(excluded.request_characters, 0) end,
        response_characters = case
          when response_character_known_calls + excluded.response_character_known_calls = 0 then null
          else coalesce(response_characters, 0) + coalesce(excluded.response_characters, 0) end,
        request_tokens = case
          when request_token_known_calls + excluded.request_token_known_calls = 0 then null
          else coalesce(request_tokens, 0) + coalesce(excluded.request_tokens, 0) end,
        response_tokens = case
          when response_token_known_calls + excluded.response_token_known_calls = 0 then null
          else coalesce(response_tokens, 0) + coalesce(excluded.response_tokens, 0) end,
        request_byte_known_calls = request_byte_known_calls + excluded.request_byte_known_calls,
        response_byte_known_calls = response_byte_known_calls + excluded.response_byte_known_calls,
        request_character_known_calls = request_character_known_calls + excluded.request_character_known_calls,
        response_character_known_calls = response_character_known_calls + excluded.response_character_known_calls,
        request_token_known_calls = request_token_known_calls + excluded.request_token_known_calls,
        response_token_known_calls = response_token_known_calls + excluded.response_token_known_calls,
        duration_sum_ms = duration_sum_ms + excluded.duration_sum_ms,
        duration_known_calls = duration_known_calls + excluded.duration_known_calls,
        aggregated_at_ms = excluded.aggregated_at_ms,
        event_started_at_min_ms = case
          when event_started_at_min_ms is null then excluded.event_started_at_min_ms
          when excluded.event_started_at_min_ms is null then event_started_at_min_ms
          else min(event_started_at_min_ms, excluded.event_started_at_min_ms) end,
        event_started_at_max_ms = case
          when event_started_at_max_ms is null then excluded.event_started_at_max_ms
          when excluded.event_started_at_max_ms is null then event_started_at_max_ms
          else max(event_started_at_max_ms, excluded.event_started_at_max_ms) end
    `);
    for (const row of aggregates) {
      upsert.run(
        row.local_date, row.tool, row.estimator_epoch, row.outcome,
        row.request_measurement_status, row.response_measurement_status,
        row.request_token_status, row.response_token_status, row.attribution_status,
        row.call_count, row.request_bytes, row.response_bytes,
        row.request_characters, row.response_characters,
        row.request_byte_known_calls, row.response_byte_known_calls,
        row.request_character_known_calls, row.response_character_known_calls,
        row.request_tokens, row.response_tokens,
        row.request_token_known_calls, row.response_token_known_calls,
        row.duration_sum_ms, row.duration_known_calls, nowMs,
        row.event_started_at_min_ms, row.event_started_at_max_ms,
      );
    }
    const statusAggregates = database.prepare(`
      select local_date, tool, estimator_epoch, side, status, count(*) as call_count
      from (
        select local_date, tool, estimator_epoch, 'request' as side, request_token_status as status
        from usage_calls where started_at_ms < ?
        union all
        select local_date, tool, estimator_epoch, 'response' as side, response_token_status as status
        from usage_calls where started_at_ms < ?
      )
      group by local_date, tool, estimator_epoch, side, status
    `).all(cutoffMs, cutoffMs) as Array<Record<string, string | number>>;
    const upsertStatus = database.prepare(`
      insert into usage_daily_status(local_date, tool, estimator_epoch, side, status, call_count)
      values (?, ?, ?, ?, ?, ?)
      on conflict(local_date, tool, estimator_epoch, side, status)
      do update set call_count = call_count + excluded.call_count
    `);
    for (const row of statusAggregates) {
      upsertStatus.run(
        row.local_date, row.tool, row.estimator_epoch, row.side, row.status, row.call_count,
      );
    }
    const rolledCalls = aggregates.reduce((sum, row) => sum + Number(row.call_count), 0);
    const deletedCalls = database.prepare("delete from usage_calls where started_at_ms < ?").run(cutoffMs).changes;
    if (deletedCalls !== rolledCalls) {
      throw new Error(`Usage retention reconciliation failed: rolled=${rolledCalls} deleted=${deletedCalls}`);
    }
    const totalsAfter = historyTotals(database);
    if (JSON.stringify(totalsAfter) !== JSON.stringify(totalsBefore)) {
      throw new Error("Usage retention reconciliation failed: aggregate totals changed");
    }
    if (deletedCalls > 0) {
      database.prepare(`
        insert into usage_meta(key, value) values ('retention_generation', '1')
        on conflict(key) do update set value = cast(value as integer) + 1
      `).run();
    }
    setMeta(database, "last_maintenance_at_ms", String(nowMs));
    return { rolledCalls, deletedCalls };
  });

  let closed = false;
  const store: UsageStore = {
    sessionRef: (rawSession) => pseudonymizeSession(rawSession, identityKey),
    startCallMinimal(input) {
      const result = insertCall.run(
        input.eventId, bootId, input.startedAtMs, localDate(input.startedAtMs), input.sessionRef,
        input.sessionRef === "UNATTRIBUTED" ? "UNATTRIBUTED" : "ATTRIBUTED",
        input.tool, epochId,
      );
      return result.changes > 0;
    },
    setRequestMeasurement(eventId, request) {
      setRequest.run(request.bytes, request.characters, eventId);
    },
    failRequestMeasurement(eventId, status = "MEASUREMENT_ERROR") {
      failRequest.run(status, status, eventId);
    },
    startCall(input) {
      const inserted = store.startCallMinimal(input);
      if (inserted) store.setRequestMeasurement(input.eventId, input.request);
      return inserted;
    },
    finishCall(input) {
      const outcome = input.outcome ?? (input.success ? "SUCCESS" : "ERROR");
      const row = database.prepare("select started_at_ms from usage_calls where event_id = ?")
        .get(input.eventId) as { started_at_ms: number } | undefined;
      const requestStatus: MeasurementStatus | undefined = input.request
        ? "AVAILABLE"
        : input.requestMeasurementStatus;
      const requestTokenStatus: SideTokenStatus | undefined = input.request
        ? "PENDING"
        : input.requestMeasurementStatus;
      const responseStatus: MeasurementStatus = input.response
        ? "AVAILABLE"
        : input.responseMeasurementStatus ?? "UNKNOWN_RESPONSE";
      const responseTokenStatus: SideTokenStatus = input.response
        ? "PENDING"
        : input.responseMeasurementStatus ?? "UNKNOWN_RESPONSE";
      finish.run(
        row ? row.started_at_ms + Math.max(0, input.durationMs) : null,
        outcome, Math.max(0, input.durationMs),
        input.request?.bytes ?? null, input.request?.characters ?? null,
        requestStatus ?? null, requestTokenStatus ?? null,
        input.response?.bytes ?? null, input.response?.characters ?? null,
        responseStatus, responseTokenStatus, input.eventId,
      );
    },
    setSideTokenCount(input) {
      (input.side === "request" ? setRequestTokens : setResponseTokens)
        .run(input.tokens, input.status, input.eventId);
      if (input.status === "AVAILABLE" || input.status === "PARTIAL_UNSUPPORTED_MEDIA") {
        setEstimatorCacheStatus.run("VERIFIED", epochId);
      } else if (["TOKENIZER_UNAVAILABLE", "TOKENIZER_TIMEOUT", "TOKENIZER_CIRCUIT_OPEN"].includes(input.status)) {
        setEstimatorCacheStatus.run("UNAVAILABLE_OR_INVALID", epochId);
      }
    },
    setTokenCounts(input) {
      store.setSideTokenCount({ eventId: input.eventId, side: "request", tokens: input.requestTokens, status: input.status });
      store.setSideTokenCount({ eventId: input.eventId, side: "response", tokens: input.responseTokens, status: input.status });
    },
    terminalizePending(status) {
      return database.prepare(`
        update usage_calls set
          request_token_status = case when request_token_status = 'PENDING' then ? else request_token_status end,
          response_token_status = case when response_token_status = 'PENDING' then ? else response_token_status end,
          request_measurement_status = case when request_measurement_status = 'PENDING' then 'MEASUREMENT_ERROR' else request_measurement_status end,
          response_measurement_status = case when response_measurement_status = 'PENDING' then 'UNKNOWN_RESPONSE' else response_measurement_status end
        where request_token_status = 'PENDING' or response_token_status = 'PENDING'
      `).run(status, status).changes;
    },
    heartbeat(nowMs, runtimeHealth = "ACTIVE") {
      database.prepare(`
        update usage_boots set heartbeat_at_ms = ?, runtime_health = ?
        where boot_id = ? and status = 'ACTIVE'
      `).run(nowMs, runtimeHealth, bootId);
    },
    runtimeFacts() {
      const current = database.prepare(
        "select boot_id, status, heartbeat_at_ms from usage_boots where boot_id = ?",
      ).get(bootId) as { boot_id: string; status: RuntimeFacts["current_boot_status"]; heartbeat_at_ms: number };
      const interrupted = database.prepare(
        "select count(*) as count from usage_boots where status = 'INTERRUPTED'",
      ).get() as { count: number };
      const gaps = database.prepare(
        "select started_at_ms, ended_at_ms, reason from usage_gaps order by started_at_ms",
      ).all() as RuntimeFacts["gaps"];
      return {
        current_boot_id: current.boot_id,
        current_boot_status: current.status,
        heartbeat_at_ms: current.heartbeat_at_ms,
        interrupted_boots: interrupted.count,
        gaps,
      };
    },
    listCalls(input) {
      const before = input.beforeStartedAtMs ?? Number.MAX_SAFE_INTEGER;
      const rows = database.prepare(`
        select sequence, event_id, boot_id, started_at_ms, finished_at_ms, local_date,
          session_ref, attribution_status, tool, outcome, duration_ms,
          request_bytes, request_characters, response_bytes, response_characters,
          request_measurement_status, response_measurement_status,
          request_tokens, response_tokens, request_token_status, response_token_status,
          estimator_epoch
        from usage_calls where started_at_ms < ?
        order by started_at_ms desc, event_id desc limit ?
      `).all(before, input.limit) as Omit<UsageCallRow, "token_status">[];
      return rows.map((row) => ({
        ...row,
        token_status: row.request_token_status === row.response_token_status ? row.request_token_status : "MIXED",
      }));
    },
    summarizeAll() {
      const row = database.prepare(`
        select sum(calls) as calls, sum(request_tokens) as request_tokens,
          sum(response_tokens) as response_tokens, sum(request_bytes) as request_bytes,
          sum(response_bytes) as response_bytes
        from (
          select count(*) as calls, sum(request_tokens) as request_tokens,
            sum(response_tokens) as response_tokens,
            sum(request_bytes) as request_bytes,
            sum(response_bytes) as response_bytes from usage_calls
          union all
          select sum(call_count), sum(request_tokens), sum(response_tokens),
            sum(request_bytes), sum(response_bytes) from usage_daily
        )
      `).get() as Record<string, number | null>;
      return {
        calls: row.calls ?? 0,
        requestTokens: row.request_tokens == null ? null : Number(row.request_tokens),
        responseTokens: row.response_tokens == null ? null : Number(row.response_tokens),
        requestBytes: row.request_bytes == null ? null : Number(row.request_bytes),
        responseBytes: row.response_bytes == null ? null : Number(row.response_bytes),
      };
    },
    runRetention: (nowMs, retentionDays) => runRetentionTransaction(nowMs, retentionDays),
    close(closeOptions = {}) {
      if (closed) return;
      if (closeOptions.clean !== false) {
        const stoppedAt = closeOptions.nowMs ?? Date.now();
        database.prepare(`
          update usage_boots set status = 'STOPPED', stopped_at_ms = ?, heartbeat_at_ms = ?
          where boot_id = ? and status = 'ACTIVE'
        `).run(stoppedAt, stoppedAt, bootId);
      }
      database.close();
      closed = true;
    },
  };
  return store;
}

function historyTotals(database: Database.Database): Record<string, number> {
  const calls = database.prepare(`
    select
      count(*) as calls,
      sum(case when outcome = 'SUCCESS' then 1 else 0 end) as success_calls,
      sum(case when outcome = 'ERROR' then 1 else 0 end) as failure_calls,
      sum(case when attribution_status = 'UNATTRIBUTED' then 1 else 0 end) as unattributed_calls,
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
    from usage_calls
  `).get() as Record<string, number | null>;
  const daily = database.prepare(`
    select
      sum(call_count) as calls,
      sum(case when outcome = 'SUCCESS' then call_count else 0 end) as success_calls,
      sum(case when outcome = 'ERROR' then call_count else 0 end) as failure_calls,
      sum(case when attribution_status = 'UNATTRIBUTED' then call_count else 0 end) as unattributed_calls,
      sum(request_bytes) as request_bytes,
      sum(response_bytes) as response_bytes,
      sum(request_characters) as request_characters,
      sum(response_characters) as response_characters,
      sum(request_tokens) as request_tokens,
      sum(response_tokens) as response_tokens,
      sum(request_byte_known_calls) as request_byte_known_calls,
      sum(response_byte_known_calls) as response_byte_known_calls,
      sum(request_character_known_calls) as request_character_known_calls,
      sum(response_character_known_calls) as response_character_known_calls,
      sum(request_token_known_calls) as request_known_calls,
      sum(response_token_known_calls) as response_known_calls,
      sum(duration_sum_ms) as duration_sum_ms,
      sum(duration_known_calls) as duration_known_calls
    from usage_daily
  `).get() as Record<string, number | null>;
  const keys = Object.keys(calls).sort();
  const totals: Record<string, number> = {};
  for (const key of keys) totals[key] = Number(calls[key] ?? 0) + Number(daily[key] ?? 0);

  const statuses = database.prepare(`
    select side, status, sum(call_count) as calls from (
      select side, status, call_count from usage_daily_status
      union all
      select 'request' as side, request_token_status as status, 1 as call_count from usage_calls
      union all
      select 'response' as side, response_token_status as status, 1 as call_count from usage_calls
    )
    group by side, status order by side, status
  `).all() as Array<{ side: string; status: string; calls: number }>;
  for (const row of statuses) {
    totals[`${row.side}_status_${row.status}`] = Number(row.calls);
  }
  return Object.fromEntries(Object.entries(totals).sort(([left], [right]) => left.localeCompare(right)));
}

function migrate(database: Database.Database, workerSha256: string, epochId: string): void {
  const version = tableExists(database, "usage_meta")
    ? Number((database.prepare("select value from usage_meta where key = 'schema_version'").get() as { value?: string } | undefined)?.value ?? 0)
    : 0;
  if (version === 1 && tableExists(database, "usage_calls") && !hasColumn(database, "usage_calls", "sequence")) {
    database.exec("alter table usage_calls rename to usage_calls_v1; alter table usage_daily rename to usage_daily_v1;");
  }
  createSchema(database);
  if (!hasColumn(database, "usage_estimator_epochs", "cache_status")) {
    database.exec("alter table usage_estimator_epochs add column cache_status text not null default 'UNKNOWN'");
  }
  addColumnIfMissing(database, "usage_daily", "event_started_at_min_ms", "integer");
  addColumnIfMissing(database, "usage_daily", "event_started_at_max_ms", "integer");
  addColumnIfMissing(database, "usage_daily", "request_byte_known_calls", "integer not null default 0");
  addColumnIfMissing(database, "usage_daily", "response_byte_known_calls", "integer not null default 0");
  addColumnIfMissing(database, "usage_daily", "request_character_known_calls", "integer not null default 0");
  addColumnIfMissing(database, "usage_daily", "response_character_known_calls", "integer not null default 0");
  rebuildDailyIfColumnsAreNotNull(database);
  backfillLegacyDailyKnownCalls(database);
  database.prepare(`
    insert or ignore into usage_estimator_epochs (
      epoch_id, package, version, encoding, algorithm_version, worker_sha256, cache_status, created_at_ms
    ) values (?, ?, ?, ?, ?, ?, 'UNKNOWN', ?)
  `).run(
    epochId, ESTIMATOR_PACKAGE, ESTIMATOR_VERSION, ESTIMATOR_ENCODING,
    ALGORITHM_VERSION, workerSha256, Date.now(),
  );
  if (tableExists(database, "usage_calls_v1")) migrateV1(database, epochId);
  setMeta(database, "schema_version", "3");
  setMeta(database, "timezone", USAGE_TIMEZONE);
  setMeta(database, "retention_generation", readMeta(database, "retention_generation") ?? "0");
  setMeta(database, "estimator_cache_sha256", ESTIMATOR_CACHE_SHA256);
  setMeta(database, "algorithm_version", ALGORITHM_VERSION);
}

function backfillLegacyDailyKnownCalls(database: Database.Database): void {
  database.prepare(`
    update usage_daily set
      request_byte_known_calls = case
        when request_byte_known_calls = 0 and request_bytes is not null then call_count
        else request_byte_known_calls end,
      response_byte_known_calls = case
        when response_byte_known_calls = 0 and response_bytes is not null then call_count
        else response_byte_known_calls end,
      request_character_known_calls = case
        when request_character_known_calls = 0 and request_characters is not null then call_count
        else request_character_known_calls end,
      response_character_known_calls = case
        when response_character_known_calls = 0 and response_characters is not null then call_count
        else response_character_known_calls end,
      request_token_known_calls = case
        when request_token_known_calls = 0 and request_tokens is not null then call_count
        else request_token_known_calls end,
      response_token_known_calls = case
        when response_token_known_calls = 0 and response_tokens is not null then call_count
        else response_token_known_calls end
  `).run();
}

function createSchema(database: Database.Database): void {
  database.exec(`
    create table if not exists usage_estimator_epochs (
      epoch_id text primary key, package text not null, version text not null,
      encoding text not null, algorithm_version text not null,
      worker_sha256 text not null, cache_status text not null, created_at_ms integer not null
    );
    create table if not exists usage_boots (
      boot_id text primary key, started_at_ms integer not null, heartbeat_at_ms integer not null,
      stopped_at_ms integer, status text not null, runtime_health text not null
    );
    create table if not exists usage_gaps (
      gap_id integer primary key autoincrement, started_at_ms integer not null,
      ended_at_ms integer not null, reason text not null
    );
    create table if not exists usage_calls (
      sequence integer primary key autoincrement,
      event_id text not null unique, boot_id text not null,
      started_at_ms integer not null, finished_at_ms integer,
      local_date text not null, session_ref text not null, attribution_status text not null,
      tool text not null, outcome text not null, duration_ms integer,
      request_bytes integer, request_characters integer,
      response_bytes integer, response_characters integer,
      request_measurement_status text not null, response_measurement_status text not null,
      request_tokens integer, response_tokens integer,
      request_token_status text not null, response_token_status text not null,
      estimator_epoch text not null
    );
    create index if not exists usage_calls_started_event on usage_calls(started_at_ms desc, event_id desc);
    create index if not exists usage_calls_local_date_tool on usage_calls(local_date, tool);
    create table if not exists usage_daily (
      local_date text not null, tool text not null, estimator_epoch text not null,
      outcome text not null, request_measurement_status text not null,
      response_measurement_status text not null, request_token_status text not null,
      response_token_status text not null, attribution_status text not null,
      call_count integer not null, request_bytes integer, response_bytes integer,
      request_characters integer, response_characters integer,
      request_byte_known_calls integer not null, response_byte_known_calls integer not null,
      request_character_known_calls integer not null, response_character_known_calls integer not null,
      request_tokens integer, response_tokens integer,
      request_token_known_calls integer not null, response_token_known_calls integer not null,
      duration_sum_ms integer not null, duration_known_calls integer not null,
      aggregated_at_ms integer not null,
      event_started_at_min_ms integer, event_started_at_max_ms integer,
      primary key(local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status)
    );
    create table if not exists usage_daily_status (
      local_date text not null, tool text not null, estimator_epoch text not null,
      side text not null, status text not null, call_count integer not null,
      primary key(local_date, tool, estimator_epoch, side, status)
    );
    create table if not exists usage_meta (key text primary key, value text not null);
  `);
}

function migrateV1(database: Database.Database, epochId: string): void {
  database.transaction(() => {
    database.exec(`
      insert or ignore into usage_calls (
        event_id, boot_id, started_at_ms, finished_at_ms, local_date, session_ref,
        attribution_status, tool, outcome, duration_ms,
        request_bytes, request_characters, response_bytes, response_characters,
        request_measurement_status, response_measurement_status,
        request_tokens, response_tokens, request_token_status, response_token_status,
        estimator_epoch
      )
      select event_id, 'legacy', started_at_ms, finished_at_ms, local_date, session_ref,
        case when session_ref = 'UNATTRIBUTED' then 'UNATTRIBUTED' else 'ATTRIBUTED' end,
        tool, case when outcome = 'INCOMPLETE' then 'IN_PROGRESS' else outcome end, duration_ms,
        request_bytes, request_characters, response_bytes, response_characters,
        'AVAILABLE', case when response_bytes is null then 'UNKNOWN_RESPONSE' else 'AVAILABLE' end,
        request_tokens, response_tokens,
        case when request_tokens is not null then 'AVAILABLE'
          when token_status = 'PENDING' then 'SHUTDOWN_INCOMPLETE' else token_status end,
        case when response_tokens is not null then token_status
          when response_bytes is null then 'UNKNOWN_RESPONSE'
          when token_status = 'PENDING' then 'SHUTDOWN_INCOMPLETE' else token_status end,
        '${epochId}'
      from usage_calls_v1;
    `);
    database.exec(`
      insert or ignore into usage_daily (
        local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status,
        call_count, request_bytes, response_bytes, request_characters, response_characters,
        request_byte_known_calls, response_byte_known_calls,
        request_character_known_calls, response_character_known_calls,
        request_tokens, response_tokens, request_token_known_calls, response_token_known_calls,
        duration_sum_ms, duration_known_calls, aggregated_at_ms,
        event_started_at_min_ms, event_started_at_max_ms
      )
      select local_date, tool, '${epochId}', 'SUCCESS',
        'AVAILABLE', 'AVAILABLE', 'LEGACY_MIXED', 'LEGACY_MIXED', 'UNATTRIBUTED',
        call_count, request_bytes, response_bytes, request_characters, response_characters,
        case when request_bytes is not null then call_count else 0 end,
        case when response_bytes is not null then call_count else 0 end,
        case when request_characters is not null then call_count else 0 end,
        case when response_characters is not null then call_count else 0 end,
        request_tokens, response_tokens, request_token_known_calls, response_token_known_calls,
        duration_sum_ms, call_count, 0, null, null
      from usage_daily_v1;
    `);
    database.exec("drop table usage_calls_v1; drop table usage_daily_v1;");
  })();
}

function beginBoot(database: Database.Database, bootId: string, nowMs: number): void {
  database.transaction(() => {
    const latest = database.prepare(`
      select status, stopped_at_ms from usage_boots order by started_at_ms desc limit 1
    `).get() as { status: string; stopped_at_ms: number | null } | undefined;
    if (latest?.status === "STOPPED" && latest.stopped_at_ms !== null && latest.stopped_at_ms < nowMs) {
      database.prepare(
        "insert into usage_gaps(started_at_ms, ended_at_ms, reason) values (?, ?, 'STOPPED')",
      ).run(latest.stopped_at_ms, nowMs);
    }
    const active = database.prepare(
      "select boot_id, heartbeat_at_ms from usage_boots where status = 'ACTIVE'",
    ).all() as Array<{ boot_id: string; heartbeat_at_ms: number }>;
    for (const previous of active) {
      database.prepare("update usage_boots set status = 'INTERRUPTED' where boot_id = ?").run(previous.boot_id);
      database.prepare(
        "insert into usage_gaps(started_at_ms, ended_at_ms, reason) values (?, ?, 'INTERRUPTED')",
      ).run(previous.heartbeat_at_ms, nowMs);
    }
    database.prepare(`
      update usage_calls set
        outcome = 'INTERRUPTED', finished_at_ms = ?,
        duration_ms = max(0, ? - started_at_ms),
        request_measurement_status = case when request_measurement_status = 'PENDING'
          then 'MEASUREMENT_ERROR' else request_measurement_status end,
        response_measurement_status = case when response_measurement_status = 'PENDING'
          then 'UNKNOWN_RESPONSE' else response_measurement_status end,
        request_token_status = case when request_token_status = 'PENDING'
          then 'PROCESS_INTERRUPTED' else request_token_status end,
        response_token_status = case when response_token_status = 'PENDING'
          then 'PROCESS_INTERRUPTED' else response_token_status end
      where outcome = 'IN_PROGRESS'
    `).run(nowMs, nowMs);
    database.prepare(`
      insert into usage_boots(boot_id, started_at_ms, heartbeat_at_ms, status, runtime_health)
      values (?, ?, ?, 'ACTIVE', 'ACTIVE')
    `).run(bootId, nowMs, nowMs);
    database.prepare("insert or ignore into usage_meta(key, value) values ('coverage_started_at_ms', ?)")
      .run(String(nowMs));
  })();
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  return (database.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>)
    .some((entry) => entry.name === column);
}

function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  if (hasColumn(database, table, column)) return;
  database.exec(`alter table ${table} add column ${column} ${declaration}`);
}

function rebuildDailyIfColumnsAreNotNull(database: Database.Database): void {
  const columns = database.prepare("pragma table_info(usage_daily)")
    .all() as Array<{ name: string; notnull: number }>;
  const exactColumns = [
    "request_bytes", "response_bytes", "request_characters", "response_characters",
    "request_tokens", "response_tokens",
  ];
  const requiresRebuild = columns.some((column) =>
    exactColumns.includes(column.name) && Number(column.notnull) === 1);
  if (!requiresRebuild) return;

  database.transaction(() => {
    database.exec(`
      alter table usage_daily rename to usage_daily_before_nullable_exact;
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
        request_token_known_calls integer not null, response_token_known_calls integer not null,
        duration_sum_ms integer not null, duration_known_calls integer not null,
        aggregated_at_ms integer not null,
        event_started_at_min_ms integer, event_started_at_max_ms integer,
        primary key(local_date, tool, estimator_epoch, outcome,
          request_measurement_status, response_measurement_status,
          request_token_status, response_token_status, attribution_status)
      );
      insert into usage_daily (
        local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status,
        call_count, request_bytes, response_bytes, request_characters, response_characters,
        request_tokens, response_tokens,
        request_byte_known_calls, response_byte_known_calls,
        request_character_known_calls, response_character_known_calls,
        request_token_known_calls, response_token_known_calls,
        duration_sum_ms, duration_known_calls, aggregated_at_ms,
        event_started_at_min_ms, event_started_at_max_ms
      )
      select local_date, tool, estimator_epoch, outcome,
        request_measurement_status, response_measurement_status,
        request_token_status, response_token_status, attribution_status,
        call_count, request_bytes, response_bytes, request_characters, response_characters,
        case when request_bytes is not null then call_count else 0 end,
        case when response_bytes is not null then call_count else 0 end,
        case when request_characters is not null then call_count else 0 end,
        case when response_characters is not null then call_count else 0 end,
        request_tokens, response_tokens,
        request_token_known_calls, response_token_known_calls,
        duration_sum_ms, duration_known_calls, aggregated_at_ms,
        event_started_at_min_ms, event_started_at_max_ms
      from usage_daily_before_nullable_exact;
      drop table usage_daily_before_nullable_exact;
    `);
  })();
}

function readMeta(database: Database.Database, key: string): string | undefined {
  return (database.prepare("select value from usage_meta where key = ?").get(key) as { value?: string } | undefined)?.value;
}

function setMeta(database: Database.Database, key: string, value: string): void {
  database.prepare(`
    insert into usage_meta(key, value) values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(key, value);
}

function localDate(timestampMs: number): string {
  const parts = HONG_KONG_DATE_FORMATTER.formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
