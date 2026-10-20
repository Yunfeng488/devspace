import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const python = process.env.DEVSPACE_USAGE_PYTHON?.trim() || "py";
const pythonArguments = process.env.DEVSPACE_USAGE_PYTHON?.trim() ? [] : ["-3.11"];
const cacheDirectory = process.env.TIKTOKEN_CACHE_DIR?.trim()
  || join(tmpdir(), "devspace-usage-fixture-cache");
const cacheKey = createHash("sha1")
  .update("https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken")
  .digest("hex");
const worker = resolve("scripts/tiktoken-worker.py");
const workerHash = createHash("sha256").update(await readFile(worker)).digest("hex");
const fixtureText = [
  "English sentence.",
  "中文测试内容。",
  "const value = \"代码\";",
  "😀 emoji",
  "<|endoftext|> must be counted as ordinary model-visible text",
].join("\n");

const temporary = await mkdtemp(join(tmpdir(), "devspace-usage-fixture-run-"));
try {
  process.env.TIKTOKEN_CACHE_DIR = cacheDirectory;
  const prewarm = spawnSync(python, [
    ...pythonArguments,
    resolve("scripts/prewarm-usage-tokenizer.py"),
    "--cache-dir", cacheDirectory,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(prewarm.status, 0, prewarm.stderr || prewarm.stdout);
  const cachePath = join(cacheDirectory, cacheKey);
  assert.ok((await stat(cachePath)).size > 0);
  const cacheSha256 = createHash("sha256").update(await readFile(cachePath)).digest("hex");
  assert.equal(cacheSha256, "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d");

  const workerResult = spawnSync(python, [
    ...pythonArguments,
    worker,
    `--expected-cache-sha256=${cacheSha256}`,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      TIKTOKEN_CACHE_DIR: cacheDirectory,
      PYTHONUTF8: "1",
    },
    input: `${JSON.stringify({ id: 1, text: fixtureText })}\n`,
  });
  assert.equal(workerResult.status, 0, workerResult.stderr || workerResult.stdout);
  const responses = workerResult.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(responses[0], { ready: true });
  const response = responses[1];
  assert.equal(response.id, 1);
  assert.ok(Number.isInteger(response.tokens) && response.tokens > 0);
  console.log(JSON.stringify({
    status: "PASS",
    package: "tiktoken",
    version: "0.14.0",
    encoding: "o200k_base",
    cache_sha256: cacheSha256,
    worker_sha256: workerHash,
    fixture: {
      fixture_id: "mixed-language-code-emoji-reserved-token-v2",
      utf8_bytes: Buffer.byteLength(fixtureText),
      characters: Array.from(fixtureText).length,
      estimated_tokens: response.tokens,
    },
  }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
