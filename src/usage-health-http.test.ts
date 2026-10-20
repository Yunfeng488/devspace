import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

test("public health is minimal and usage health requires its local capability token", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-usage-health-http-"));
  const usageDir = join(root, "usage");
  const loaded = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: join(root, ".state"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    DEVSPACE_USAGE_DIR: usageDir,
    DEVSPACE_USAGE_WORKER: join(root, "worker.py"),
    DEVSPACE_USAGE_WORKER_SHA256: "a".repeat(64),
    PORT: "1",
  });
  const running = createServer({
    ...loaded,
    usage: { ...loaded.usage, enabled: false, stateDir: usageDir },
  });
  const httpServer = running.app.listen(0, "127.0.0.1");
  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
  };
  try {
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    const publicHealth = await fetch(`${base}/healthz`);
    assert.equal(publicHealth.status, 200);
    assert.deepEqual(await publicHealth.json(), { ok: true, name: "devspace" });

    const unauthorized = await fetch(`${base}/usage-healthz`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
