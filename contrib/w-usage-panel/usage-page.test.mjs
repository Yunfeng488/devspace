import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("./usage.html", import.meta.url);

test("usage page states its scope and accessible status semantics", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /不是 W 整回合、账单或额度用量/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /显示趋势数字表格/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:/i);
});

test("usage page cancels stale requests and pauses polling while hidden", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /controller\?\.abort\(\)/);
  assert.match(html, /sequence\s*!==\s*requestSequence/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /if\s*\(!document\.hidden\)/);
  assert.match(html, /setInterval\(load,\s*5000\)/);
  assert.match(html, /\/api\/usage\/snapshot/);
  assert.doesNotMatch(html, /fetch\("\/api\/usage\/(?:health|overview|calls)/);
  assert.match(html, /load\(\{ announce: false \}\)/);
});

test("unknown values are rendered as unknown instead of zero", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /value\s*==\s*null\s*\?\s*"未知"/);
  assert.match(html, /overview\.status\s*!==\s*"UNKNOWN"/);
  assert.match(html, /exactKnown\?format\(exact\.calls\):"未知"/);
  assert.match(html, /overview\.status==="UNKNOWN"[\s\S]*?返回 Token 覆盖：未知/);
  assert.doesNotMatch(html, /row\.response_bytes\s*\?\?\s*0/);
  assert.doesNotMatch(html, /request_tokens \|\| 0/);
  assert.doesNotMatch(html, /response_tokens \|\| 0/);
  assert.doesNotMatch(html, /id="calls" class="value">0</);
  assert.doesNotMatch(html, /id="bytes" class="value">0 B</);
  assert.match(html, /function renderUnavailable\(\)/);
  assert.match(html, /renderUnavailable\(\)/);
});

test("usage page keeps exactly four first-fold KPI cards and folds secondary detail", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.equal((html.match(/class="card kpi-card/g) ?? []).length, 4);
  assert.match(html, /已知请求估算 Token/);
  assert.match(html, /已知返回估算 Token/);
  assert.match(html, /请求覆盖/);
  assert.match(html, /返回覆盖/);
  assert.match(html, /<details[^>]*id="custom-details"/);
  assert.match(html, /<details[^>]*id="health-details"/);
  assert.match(html, /<details[^>]*id="session-details"/);
  assert.match(html, /<details[^>]*id="calls-details"/);
});

test("usage page explains tokenizer recovery and queue age without rendering payloads", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /最后 Token 成功/);
  assert.match(html, /最老排队等待/);
  assert.match(html, /Tokenizer 失败分类/);
});

test("usage page offers accessible short-interval token trends without fake OHLC", async () => {
  const html = await readFile(pageUrl, "utf8");
  for (const [value, label] of [["15m", "15 分钟"], ["30m", "30 分钟"], ["1h", "1 小时"], ["4h", "4 小时"]]) {
    assert.match(html, new RegExp(`data-interval="${value}"[^>]*>${label}`));
  }
  assert.match(html, /aria-label="趋势周期"/);
  assert.match(html, /interval_range_too_large/);
  assert.match(html, /RETAINED_CALLS_ONLY/);
  assert.match(html, /请求 Token/);
  assert.match(html, /返回 Token/);
  assert.match(html, /部分覆盖/);
  assert.match(html, /renderIntervalChart/);
  assert.match(html, /finestInterval/);
  assert.match(html, /button\.disabled=!allowed/);
  assert.match(html, /setInterval\(load,5000\)/);
  assert.match(html, /activeBucketStart/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /preventScroll:true/);
  assert.doesNotMatch(html, /tabindex="0" role="img"/);
  assert.doesNotMatch(html, /\b(?:open|high|low|close|OHLC)\b/i);
});
