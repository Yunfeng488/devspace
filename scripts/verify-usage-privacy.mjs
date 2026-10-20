import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { measureRequestPayload, measureResponsePayload } from "../dist/usage-metrics.js";
import { openUsageStore } from "../dist/usage-store.js";
import {
  queryUsageCalls,
  queryUsageHealth,
  queryUsageOverview,
  queryUsageSnapshot,
} from "../dist/usage-runtime/usage-api.mjs";

const sentinels = {
  request: "SYNTHETIC_REQUEST_SENTINEL_7f4d86",
  response: "SYNTHETIC_RESPONSE_SENTINEL_1c2a95",
  command: "SYNTHETIC_COMMAND_SENTINEL_38e1bb",
  path: "SYNTHETIC_PATH_SENTINEL_82a6d0",
  ownerToken: "SYNTHETIC_OWNER_TOKEN_SENTINEL_2d837c",
  session: "SYNTHETIC_RAW_SESSION_SENTINEL_a91452",
};
const forbidden = Object.values(sentinels);
const directory = await mkdtemp(join(tmpdir(), "devspace-usage-privacy-"));
const store = openUsageStore(directory, {
  identityKey: Buffer.from("privacy-fixture-key"),
  bootId: "privacy-boot",
  nowMs: Date.UTC(2026, 9, 18, 0),
});
const nowMs = Date.UTC(2026, 9, 18, 1);
try {
  store.startCallMinimal({
    eventId: "privacy-event",
    tool: "bash",
    sessionRef: store.sessionRef(sentinels.session),
    startedAtMs: nowMs,
  });
  store.setRequestMeasurement("privacy-event", measureRequestPayload({
    command: sentinels.command,
    path: sentinels.path,
    accessToken: sentinels.ownerToken,
    visible: sentinels.request,
  }));
  store.finishCall({
    eventId: "privacy-event",
    outcome: "ERROR",
    durationMs: 9,
    response: measureResponsePayload({
      content: [{ type: "text", text: sentinels.response }],
      _meta: { command: sentinels.command, path: sentinels.path, token: sentinels.ownerToken },
    }),
  });
  store.setTokenCounts({
    eventId: "privacy-event",
    requestTokens: 12,
    responseTokens: 7,
    status: "AVAILABLE",
  });
  store.close({ clean: true, nowMs });

  const databasePath = join(directory, "usage.sqlite");
  const database = new Database(databasePath, { readonly: true });
  let databaseJson;
  try {
    const rows = Object.fromEntries(
      database.prepare("select name from sqlite_master where type = 'table' order by name")
        .all()
        .map(({ name }) => {
          const table = String(name);
          return [table, database.prepare(`select * from "${table}"`).all()];
        }),
    );
    databaseJson = JSON.stringify(rows);
  } finally {
    database.close();
  }
  const health = queryUsageHealth(databasePath, { nowMs });
  const overview = queryUsageOverview(databasePath, { range: "all", nowMs });
  const calls = queryUsageCalls(databasePath, { range: "all", nowMs });
  const snapshot = queryUsageSnapshot(databasePath, { range: "all", nowMs });
  const html = await readFile(
    new URL("../dist/usage-runtime/usage.html", import.meta.url),
    "utf8",
  );
  const surfaces = {
    database: databaseJson,
    health: JSON.stringify(health),
    overview: JSON.stringify(overview),
    calls: JSON.stringify(calls),
    snapshot: JSON.stringify(snapshot),
    html,
  };
  const leaked = [];
  for (const [surface, content] of Object.entries(surfaces)) {
    for (const sentinel of forbidden) {
      if (content.includes(sentinel)) leaked.push({ surface, sentinel });
    }
  }
  assert.deepEqual(leaked, []);
  assert.equal(overview.exact.calls, 1);
  assert.equal(overview.estimated_tokens.request, 12);
  assert.equal(overview.estimated_tokens.response, 7);
  assert.equal(snapshot.overview.exact.calls, overview.exact.calls);
  assert.equal(snapshot.calls.items.length, calls.items.length);
  console.log(JSON.stringify({
    status: "PASS",
    sentinel_count: forbidden.length,
    surfaces_checked: Object.keys(surfaces),
    exact_calls: overview.exact.calls,
    request_tokens: overview.estimated_tokens.request,
    response_tokens: overview.estimated_tokens.response,
    raw_session_persisted: false,
    payload_persisted: false,
  }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
