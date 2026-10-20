import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addUsageMonitorLink,
  createWUsagePanelIntegration,
  fetchUsageRuntimeHealth,
  localUsageHealthToken,
} from "./panel-integration.mjs";

test("panel home gains one idempotent usage monitor entry without rewriting existing content", () => {
  const original = '<!doctype html><html><body><header><a href="/existing">Existing</a></header><main>Home</main></body></html>';
  const once = addUsageMonitorLink(original);
  const twice = addUsageMonitorLink(once);
  assert.match(once, /<a[^>]+href="\/usage"[^>]*>用量监控<\/a>/);
  assert.match(once, /href="\/existing"/);
  assert.equal(twice, once);
  assert.equal((once.match(/href="\/usage"/g) ?? []).length, 1);
});

test("panel integration owns only the declared GET endpoints", async () => {
  const handler = createWUsagePanelIntegration({ usageDirectory: "C:\\missing-usage-fixture", devspaceHealthUrl: null });
  const healthResponse = responseCapture();
  assert.equal(
    await handler({ method: "GET" }, healthResponse, new URL("http://127.0.0.1:8787/api/usage/health")),
    true,
  );
  assert.equal(healthResponse.status, 200);
  assert.equal(JSON.parse(healthResponse.body).status, "UNKNOWN");

  const unrelatedResponse = responseCapture();
  assert.equal(
    await handler({ method: "GET" }, unrelatedResponse, new URL("http://127.0.0.1:8787/api/other")),
    false,
  );
  assert.equal(unrelatedResponse.status, null);
});

test("panel integration rejects mutation methods", async () => {
  const handler = createWUsagePanelIntegration({ usageDirectory: "C:\\missing-usage-fixture", devspaceHealthUrl: null });
  const response = responseCapture();
  assert.equal(
    await handler({ method: "POST" }, response, new URL("http://127.0.0.1:8787/api/usage/overview")),
    true,
  );
  assert.equal(response.status, 405);
  assert.equal(JSON.parse(response.body).error, "method_not_allowed");
});

test("runtime health is fetched from the loopback DevSpace health endpoint with a timeout", async () => {
  let request;
  const health = await fetchUsageRuntimeHealth({
    accessToken: "synthetic-owner-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ usage: { writer_state: "ACTIVE", queue: { queued_bytes: 7 } } }) };
    },
  });
  assert.equal(request.url, "http://127.0.0.1:7676/usage-healthz");
  assert.equal(request.options.cache, "no-store");
  assert.ok(request.options.signal);
  assert.equal(request.options.headers.Authorization, "Bearer synthetic-owner-token");
  assert.deepEqual(health, { writer_state: "ACTIVE", queue: { queued_bytes: 7 } });
});

test("runtime health fetch fails visibly without exposing transport errors", async () => {
  assert.deepEqual(await fetchUsageRuntimeHealth({
    accessToken: "synthetic-owner-token",
    fetchImpl: async () => { throw new Error("PRIVATE"); },
  }), {
    writer_state: "OFFLINE",
  });
});

test("runtime health does not call DevSpace without an explicit access token", async () => {
  let called = false;
  const health = await fetchUsageRuntimeHealth({
    fetchImpl: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  assert.equal(called, false);
  assert.deepEqual(health, { writer_state: "UNKNOWN" });
});

test("panel accepts only a regular, bounded and well-formed local health token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-panel-token-test-"));
  const tokenPath = join(directory, "usage-health.token");
  try {
    assert.equal(localUsageHealthToken(directory), undefined);
    await writeFile(tokenPath, "malformed", "utf8");
    assert.equal(localUsageHealthToken(directory), undefined);
    await writeFile(tokenPath, "x".repeat(1_025), "utf8");
    assert.equal(localUsageHealthToken(directory), undefined);
    const expected = "a".repeat(43);
    await writeFile(tokenPath, `${expected}\n`, "utf8");
    assert.equal(localUsageHealthToken(directory), expected);
    await rm(tokenPath);
    await mkdir(tokenPath);
    assert.equal(localUsageHealthToken(directory), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function responseCapture() {
  return {
    status: null,
    body: "",
    writeHead(status) { this.status = status; },
    end(body = "") { this.body = body; },
  };
}
