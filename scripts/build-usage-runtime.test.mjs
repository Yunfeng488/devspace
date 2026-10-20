import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("built usage runtime manifest hashes every declared deployment file", async () => {
  const output = resolve("dist/usage-runtime");
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.metric_scope, "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE");
  assert.equal(manifest.deployment_contract, "INTEGRITY_INVENTORY_REQUIRES_DEVSPACE_PACKAGE");
  assert.equal(manifest.estimator.algorithm_version, "mcp-visible-v3");
  assert.deepEqual(manifest.required_environment, [
    "DEVSPACE_USAGE_DIR", "DEVSPACE_USAGE_PYTHON", "DEVSPACE_USAGE_WORKER", "DEVSPACE_USAGE_WORKER_SHA256",
  ]);
  assert.deepEqual(
    manifest.files.filter((entry) => entry.role === "core_usage_module").map((entry) => entry.source).sort(),
    [
      "dist/config.js",
      "dist/server.js",
      "dist/usage-metrics.js",
      "dist/usage-monitor.js",
      "dist/usage-store.js",
      "dist/usage-telemetry.js",
      "dist/usage-tokenizer.js",
    ],
  );
  assert.ok(manifest.files.length >= 13);
  for (const entry of manifest.files) {
    const bytes = await readFile(join(output, entry.file));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
});

test("runtime preparation fails when a native dependency command exits nonzero", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-prepare-test-"));
  const release = join(directory, "release");
  const runtime = join(directory, "runtime");
  try {
    await cp(resolve("dist/usage-runtime"), release, { recursive: true });
    const venvResult = spawnSync("py.exe", ["-3.11", "-m", "venv", join(runtime, "venv")], {
      encoding: "utf8",
    });
    assert.equal(venvResult.status, 0, venvResult.stderr);
    const requirementsPath = join(release, "requirements-usage-tokenizer.txt");
    const prewarmPath = join(release, "prewarm-usage-tokenizer.py");
    await writeFile(
      requirementsPath,
      "C:\\\\definitely-missing\\\\missing.whl --hash=sha256:" + "0".repeat(64) + "\n",
      "utf8",
    );
    await writeFile(prewarmPath, "raise SystemExit(0)\n", "utf8");
    const manifestPath = join(release, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const file of ["requirements-usage-tokenizer.txt", "prewarm-usage-tokenizer.py"]) {
      const bytes = await readFile(join(release, file));
      const entry = manifest.files.find((candidate) => candidate.file === file);
      entry.bytes = bytes.length;
      entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const venvPython = join(runtime, "venv", "Scripts", "python.exe");
    const result = spawnSync("pwsh.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(release, "prepare-usage-runtime.ps1"),
      "-RuntimeDirectory", runtime,
      "-Python311", venvPython,
      "-ReleaseDirectory", release,
    ], { encoding: "utf8" });

    assert.notEqual(result.status, 0, `script unexpectedly succeeded: ${result.stdout}`);
    assert.doesNotMatch(result.stdout, /"runtime_directory"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime preparation rejects a path outside the fixed runtime name boundary", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspace-usage-prepare-boundary-test-"));
  const release = join(directory, "release");
  const runtime = join(directory, "unrelated");
  try {
    await cp(resolve("dist/usage-runtime"), release, { recursive: true });
    const result = spawnSync("pwsh.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(release, "prepare-usage-runtime.ps1"),
      "-RuntimeDirectory", runtime,
      "-Python311", join(directory, "missing-python.exe"),
      "-ReleaseDirectory", release,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /RuntimeDirectory must be the approved path/);
    assert.equal(existsSync(runtime), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
