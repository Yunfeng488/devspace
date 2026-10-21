import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 8799);
const directory = fileURLToPath(new URL(".", import.meta.url));
const html = await readFile(join(directory, "usage.html"), "utf8");
const now = new Date().toISOString();
const overview = {
  metric_scope: "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE",
  status: "PARTIAL",
  exact: {
    calls: 3, success_calls: 2, failure_calls: 1,
    request_bytes: 1800, response_bytes: 9200,
    request_characters: 1560, response_characters: 8010,
    total_bytes: 11000, total_characters: 9570,
  },
  estimated_tokens: {
    request: 480, response: 2300, total: 2780, request_known_calls: 3,
    request_applicable_calls: 3, response_known_calls: 2, response_applicable_calls: 3,
    total_calls: 3,
  },
  latency_ms: { p50: 18, p95: 63, retained_call_samples: 3 },
  coverage: {
    started_at: now, incomplete_calls: 1, partial_calls: 1, unattributed_calls: 1,
    unknown_response_calls: 1, dropped_calls: 0,
    request: { known_calls: 3, applicable_calls: 3, ratio: 1 },
    response: { known_calls: 2, applicable_calls: 3, ratio: 2 / 3 },
  },
  attribution: "OWNER_CONFIRMED_EXCLUSIVE_ENDPOINT",
  attribution_basis: "OWNER_CONFIRMED_EXCLUSIVE_ENDPOINT",
  by_day: [
    { date: "2026-10-16", calls: 1, estimated_tokens: { request: 160, response: 700, total: 860, request_known_calls: 1, request_applicable_calls: 1, response_known_calls: 1, response_applicable_calls: 1 } },
    { date: "2026-10-17", calls: 1, estimated_tokens: { request: 180, response: 950, total: 1130, request_known_calls: 1, request_applicable_calls: 1, response_known_calls: 1, response_applicable_calls: 1 } },
    { date: "2026-10-18", calls: 1, estimated_tokens: { request: 140, response: 650, total: 790, request_known_calls: 1, request_applicable_calls: 1, response_known_calls: 1, response_applicable_calls: 1 } },
  ],
  by_tool: [
    { tool: "read", calls: 2, estimated_tokens: { request: 220, response: 1650, total: 1870, request_known_calls: 2, request_applicable_calls: 2, response_known_calls: 1, response_applicable_calls: 2 } },
    { tool: "bash", calls: 1, estimated_tokens: { request: 260, response: 650, total: 910, request_known_calls: 1, request_applicable_calls: 1, response_known_calls: 1, response_applicable_calls: 1 } },
  ],
  by_session: [{ session_ref: "w_fixture_session", calls: 2, estimated_tokens: 1870, known_sides: 3, applicable_sides: 4 }],
};
overview.interval = "15m";
overview.interval_scope = "RETAINED_CALLS_ONLY";
overview.by_interval = previewBuckets("15m");
overview.available_from = overview.by_interval[0].start;

function previewBuckets(selected) {
  const intervalMs = { "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000 }[selected] ?? 900_000;
  const intervalEnd = Math.floor(Date.now() / intervalMs) * intervalMs;
  return Array.from({ length: 12 }, (_, index) => {
  const start = intervalEnd - (11 - index) * intervalMs;
  const request = index % 4 === 0 ? 0 : 25 + index * 9;
  const response = index % 4 === 0 ? 0 : 80 + index * 21;
  const status = index === 4 ? "UNKNOWN" : index === 8 ? "PARTIAL" : "AVAILABLE";
  const tokensUnknown = status === "UNKNOWN" || (status === "PARTIAL" && index % 4 === 0);
  return {
    start: new Date(start).toISOString(), end: new Date(start + intervalMs).toISOString(), status,
    calls: status === "UNKNOWN" ? 0 : index % 4 === 0 ? 0 : 1,
    success_calls: status === "UNKNOWN" || index % 4 === 0 ? 0 : 1, failure_calls: 0,
    estimated_tokens: {
      request: tokensUnknown ? null : request,
      response: tokensUnknown ? null : response,
      total: tokensUnknown ? null : request + response,
      request_known_calls: status === "UNKNOWN" || index % 4 === 0 ? 0 : 1,
      request_applicable_calls: status === "UNKNOWN" || index % 4 === 0 ? 0 : 1,
      request_ratio: status === "UNKNOWN" || index % 4 === 0 ? null : 1,
      response_known_calls: status === "UNKNOWN" || index % 4 === 0 ? 0 : 1,
      response_applicable_calls: status === "UNKNOWN" || index % 4 === 0 ? 0 : 1,
      response_ratio: status === "UNKNOWN" || index % 4 === 0 ? null : 1,
      total_calls: status === "UNKNOWN" || index % 4 === 0 ? 0 : 1,
    },
  };
  });
}
const health = {
  status: "PARTIAL", total_calls: 3, retained_calls: 3, archived_calls: 0,
  partial_calls: 1, incomplete_calls: 1, dropped_calls: 0,
  writer_state: "ACTIVE", unattributed_calls: 1,
  tokenizer_unavailable_calls: 0, payload_too_large_calls: 0, backpressure_calls: 0,
  tokenizer_cache_status: "VERIFIED",
};
const calls = { items: [
  { started_at: now, tool: "read", outcome: "SUCCESS", request_token_status: "AVAILABLE", response_token_status: "AVAILABLE", request_tokens: 160, response_tokens: 700, request_bytes: 500, response_bytes: 2800, duration_ms: 18 },
  { started_at: now, tool: "bash", outcome: "ERROR", request_token_status: "AVAILABLE", response_token_status: "UNKNOWN_RESPONSE", request_tokens: null, response_tokens: null, request_bytes: 900, response_bytes: null, duration_ms: 63 },
] };
const snapshot = {
  metric_scope: "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE",
  status: "PARTIAL",
  as_of: now,
  health,
  overview,
  calls,
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  if (path === "/usage") return send(response, 200, "text/html; charset=utf-8", html);
  if (path === "/api/usage/snapshot") return json(response, { ...snapshot, overview: overviewFor(url) });
  if (path === "/api/usage/overview") return json(response, overviewFor(url));
  if (path === "/api/usage/health") return json(response, health);
  if (path === "/api/usage/calls") return json(response, calls);
  return send(response, 404, "text/plain; charset=utf-8", "not found");
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`preview ready http://127.0.0.1:${port}/usage\n`));
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

function overviewFor(url) {
  const selected = url.searchParams.get("interval");
  if (selected) {
    const buckets = previewBuckets(selected);
    return { ...overview, interval: selected, available_from: buckets[0].start, by_interval: buckets };
  }
  const { interval: _interval, interval_scope: _scope, available_from: _available, by_interval: _buckets, ...daily } = overview;
  return daily;
}

function json(response, value) {
  send(response, 200, "application/json; charset=utf-8", JSON.stringify(value));
}

function send(response, status, contentType, body) {
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  response.end(body);
}
