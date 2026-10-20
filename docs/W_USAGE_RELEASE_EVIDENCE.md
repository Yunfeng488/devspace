# W usage monitor release evidence

## Frozen candidate boundary

- Candidate worktree: `codex/w-devspace-usage` at base
  `fe712e2b6c07231d2a76503bf2a674b165850616`.
- This evidence concerns only the candidate worktree. It does not authorize a
  7676 or 8787 restart, panel replacement, tunnel/configuration/root change,
  runtime preparation, or access to `%USERPROFILE%\.workbuddy`.
- The candidate contains intentional uncommitted implementation files and
  existing `.playwright-cli/` output. They are preserved for independent review
  and are not treated as deployed artifacts.
- The 2026-10-20 pre-gate freeze recorded 30 tracked changes and 11 untracked
  files (including two excluded `.playwright-cli/` artifacts). The binary diff
  SHA-256 was
  `edb8c10d3757b4b9e7f5d205cb526802c9ea50352392938c0a8b8010bb7573bd`,
  the dependency-tree SHA-256 was
  `6f9097d080ecf746589dccec882a52ba5e40fdca1370a38ebe3dfec23a98bd70`,
  and the initial `package-lock.json` SHA-256 was
  `e991cc63b9f5daef9d93c6bb81fdeddc6441666e4933a0304cbd43cd9b82376c`.
  The later normal `npm audit fix` intentionally changes the dependency tree
  and lockfile; the committed Git SHA is the final candidate identity.

## Rechecked supply-chain gates

- The installed production chain is
  `@anthropic-ai/sandbox-runtime@0.0.80 -> node-forge@1.4.0`.
- A fresh `npm audit --omit=dev --ignore-scripts --json` reports two high
  findings in that chain. The audit's only suggested downgrade is
  `@anthropic-ai/sandbox-runtime@0.0.50`; it is not an accepted remediation.
- Registry metadata at the time of this evidence reports 0.0.80 as the latest
  sandbox-runtime release and 1.4.0 as the latest node-forge release. There is
  no upstream-supported patched update to select, so deployment remains
  blocked without an explicit, time-bounded Owner risk decision.
- A normal, non-force `npm audit fix` updated supported transitive releases for
  `nanoid`, `postcss`, and `source-map-js`, reducing the audit from five high
  findings back to the two accepted `node-forge` chain findings. It also
  corrected the nonexistent `wrappy@1.0.3` lock metadata to `wrappy@1.0.2`.
- `npm audit signatures --ignore-scripts` still cannot complete: after the
  `wrappy` correction it reproducibly reaches the next inconsistent registry
  target, `util-deprecate@1.0.3`, while the referenced tarball is the published
  `1.0.2`. This remains a signature-verification failure; the lockfile was not
  hand-edited and no force override or downgrade was used.

## Local verification and its limits

- Windows verification completed: `npm test`, `npm run typecheck`, `npm run
  build`, `npm run test:usage-runtime`, `npm run benchmark:usage`, and `npm
  pack --dry-run --json`. The Linux-only native artifact MCP test was
  intentionally skipped on Windows.
- The privacy verifier checks only the new monitor database, usage APIs, and
  usage HTML with six synthetic sentinels. It proves no raw payload, command,
  path, owner token, or raw session in those monitor surfaces; it does not
  certify the pre-existing general DevSpace logs.
- An Ubuntu CI run remains required to execute the native artifact handler and
  establish all-13-tool coverage. A remote run requires separately authorized
  push or pull-request activity.

## Release disposition

`DEPLOYMENT_BLOCKED`: do not deploy until a supported remediation clears the
high-severity audit, registry signature verification completes successfully,
Ubuntu CI passes, and a fresh-context red-team review accepts the final diff
and release manifest. Deployment itself remains a separate Owner-authorized
operation.

## 2026-10-20 temporary Owner risk exception and controlled activation

- The Owner explicitly accepted a temporary exception for the two known
  high-severity `node-forge` findings and the unresolved
  `npm audit signatures` `wrappy@1.0.3` `ETARGET` failure. This is an
  authorization to activate the candidate, not a remediation or a passing
  supply-chain gate. The two issues remain open release risks.
- Before activation, a backup was made at
  `C:\Users\1\.devspace\backups\w-usage-predeploy-20261020T083521` containing
  the prior live `dist`, package manifests, panel server, and configuration.
  No WorkBuddy-owned files, credentials, general logs, tunnel configuration,
  or allowed roots were copied or changed.
- A contradictory lockfile record for `@pierre/theme` was corrected from its
  declared `1.0.2` to the already-pinned URL/integrity and dependent version
  `1.0.3`. A fresh production-only `npm ci --omit=dev --ignore-scripts` then
  succeeded. `better-sqlite3` was rebuilt for the active Node ABI before
  service activation.
- The activated release is
  `C:\Users\1\.devspace\releases\devspace-w-usage-20261020T083521\app`.
  The existing 8787 panel was updated only to dispatch the monitor API/page
  and pass the monitor runtime paths to its child; it then used the existing
  `/api/restart` route once to start the release on 7676.
- Immediate runtime checks passed: one 8787 panel listener, one 7676 child
  listener, `GET /healthz`, `GET /api/usage/health`,
  `GET /api/usage/snapshot?range=today`, `GET /api/usage/calls`, and
  `GET /usage` all returned successfully. The monitor declares
  `metric_scope=MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE` and currently reports
  `PARTIAL`; it does not report unknown token coverage as zero.
- Not yet accepted: an authenticated real-host `open_workspace + read` call,
  Ubuntu CI coverage for the Linux-only artifact tool, and the independent
  fresh-context red-team review. These are explicit remaining acceptance
  items, not implied by the service becoming reachable.

## 2026-10-20 P0 tokenizer repair candidate (not activated)

- The production incident was reproduced with a reserved marker in otherwise
  ordinary MCP text. The Python worker now calls `o200k_base.encode()` with
  `disallowed_special=()`, so reserved marker syntax is counted as text rather
  than rejecting the entire side. A real `tiktoken==0.14.0` worker fixture now
  passes with worker SHA-256
  `2e839561ce79105575ecbb7799b5a5d5b120483f45a21a992b017770da9039de`.
- Estimator semantics are now `mcp-visible-v3`. Because the epoch includes the
  algorithm version and worker hash, existing v2 history remains intact and
  partial while a later activation creates a distinct v3 coverage epoch.
- Runtime failures are split into fixed startup, worker-exit, protocol,
  encode, timeout and circuit-open categories. Health and UI expose bounded
  counts, last tokenizer success, queue bytes and oldest queued age. Circuit
  opening drains queued items to a terminal category rather than leaving
  unexplained `PENDING` work.
- A default-off `UsageTelemetrySink` accepts only low-cardinality MCP/GenAI
  metadata and validated trace context. No exporter or network output was
  added; payloads, paths, sessions, credentials and baggage are excluded by
  contract and tests.
- The candidate includes an idempotent 8787 home-page link injector and hashes
  the new compiled `usage-telemetry.js` inside the runtime manifest. Neither
  the live panel nor the running 7676/8787 processes were changed in this
  repair node.
- Current Windows evidence: full `npm test` passed (Linux-native artifact test
  skipped as designed), typecheck passed, build passed, runtime/privacy gate
  passed, package dry-run passed, and the final 1,000-pair benchmark measured
  0.549 ms added p95 / 3.650% p95 regression. The focused fault suite covers
  reserved markers, startup/exit/protocol/encode/timeout/circuit behavior,
  fast drain, recovery and the early-ready race. A deliberate mutation of the
  early-ready guard made the recovery test fail and was then reverted.
- The accepted temporary supply-chain exception remains exactly that: current
  audit still reports two HIGH findings through
  `@anthropic-ai/sandbox-runtime@0.0.80 -> node-forge@1.4.0`, and signature
  verification still fails `ETARGET`, now at `util-deprecate@1.0.3` after the
  supported `wrappy` correction. Neither remaining issue is claimed fixed.
  Ubuntu CI and post-activation real-host reconciliation remain pending.
