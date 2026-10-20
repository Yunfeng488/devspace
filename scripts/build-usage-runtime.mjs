import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(root, "dist", "usage-runtime");
const sources = [
  "scripts/tiktoken-worker.py",
  "scripts/prewarm-usage-tokenizer.py",
  "scripts/requirements-usage-tokenizer.txt",
  "scripts/prepare-usage-runtime.ps1",
  "scripts/verify-usage-tokenizer-fixtures.mjs",
  "contrib/w-usage-panel/usage-api.mjs",
  "contrib/w-usage-panel/panel-integration.mjs",
  "contrib/w-usage-panel/usage.html",
].map((source) => ({ source, role: "runtime_sidecar" })).concat([
  "dist/config.js",
  "dist/server.js",
  "dist/usage-metrics.js",
  "dist/usage-monitor.js",
  "dist/usage-store.js",
  "dist/usage-telemetry.js",
  "dist/usage-tokenizer.js",
].map((source) => ({ source, role: "core_usage_module" })));

await mkdir(output, { recursive: true });
const files = [];
for (const entry of sources) {
  const source = join(root, entry.source);
  const target = join(output, basename(entry.source));
  await cp(source, target);
  const bytes = await readFile(target);
  files.push({
    file: basename(entry.source),
    source: entry.source.replaceAll("\\", "/"),
    role: entry.role,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
files.sort((left, right) => left.file.localeCompare(right.file));
const manifest = {
  schema_version: 1,
  metric_scope: "MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE",
  deployment_contract: "INTEGRITY_INVENTORY_REQUIRES_DEVSPACE_PACKAGE",
  estimator: { package: "tiktoken", version: "0.14.0", encoding: "o200k_base", algorithm_version: "mcp-visible-v3" },
  required_environment: ["DEVSPACE_USAGE_DIR", "DEVSPACE_USAGE_PYTHON", "DEVSPACE_USAGE_WORKER", "DEVSPACE_USAGE_WORKER_SHA256"],
  files,
};
await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
