# W usage monitor red-team release gate

## Scope and verdict

This review covers the v1.0.8-same-source candidate on
`codex/w-devspace-usage`. It measures estimated MCP model-visible request and
response payload tokens, not a complete W turn, model billing, prompts,
reasoning, history, tool definitions, or remaining quota.

**Current verdict: `DEPLOYMENT_BLOCKED`.** Functional and cross-platform gates
pass, but the restored v1.0.8 dependency graph contains an unaccepted critical
finding and multiple unaccepted high findings. No deployment or restart is
authorized by this document.

## Invariants reviewed

- Exact byte/character/call/duration facts and estimated tokens are separate.
- Unknown, unsupported, interrupted, and partial measurements remain explicit.
- Payloads, commands, paths, raw sessions, credentials, and baggage are not
  persisted or sent to the optional telemetry sink.
- Handler exceptions preserve the original tool error, retain request facts,
  and mark the unobserved response `UNKNOWN_RESPONSE`.
- Tokenizer failures are fail-open for MCP tools and use bounded fixed error
  categories without raw worker text.
- Repeated failures open the circuit and terminalize queued measurements;
  recovery requires a later successful count.
- Old epochs remain partial. `mcp-visible-v3` is independently attributable
  through the algorithm version and worker hash.
- Usage endpoints are GET-only and the dashboard binds to localhost by
  default.

## Same-source boundary

- Base commit: `fe712e2b6c07231d2a76503bf2a674b165850616`.
- Implementation CI commit: `805160cd1c2150aed0950501f21a9ef4e17277b0`.
- `package-lock.json`, `src/local-agent-pi.ts`,
  `src/local-agent-pi.test.ts`, and `src/local-agent-pi-sandbox.test.ts` match
  the base exactly.
- No Pi `ModelRuntime` migration, dependency upgrade, forced override,
  downgrade, or audit-ignore rule remains in the candidate.
- `.playwright-cli/` is excluded and no `H:\workbuddy` change is absorbed.

## Cross-platform evidence

GitHub Actions run
[`39517698991`](https://github.com/Yunfeng488/devspace/actions/runs/39517698991)
passed on Ubuntu, Windows, and macOS for exact commit `805160c`. Each platform
completed Typecheck, Test, Build, runtime/privacy verification, package dry
run, performance gate, and Doctor. The Ubuntu Test step ran after successful
Pi sandbox dependency installation; the Linux-only `download_artifact` MCP
integration is guarded to skip only outside Linux, so its successful Ubuntu
Test step is the required thirteenth-tool execution evidence.

Local verification also passed. The final 1,000-pair benchmark recorded
0.5922 ms added p95 and 3.9419% p95 regression, below the 5% threshold.

The runtime manifest includes all monitor modules, declares
`INTEGRITY_INVENTORY_REQUIRES_DEVSPACE_PACKAGE`, and pins worker SHA-256
`2e839561ce79105575ecbb7799b5a5d5b120483f45a21a992b017770da9039de`.

## Privacy boundary

The privacy gate scans synthetic sentinels across the monitor SQLite store,
`/api/usage/health`, `/api/usage/overview`, `/api/usage/calls`,
`/api/usage/snapshot`, served usage HTML, and monitor-specific output. It does
not certify unrelated pre-existing DevSpace logs. Existing general logging may
contain paths or truncated command output and remains a documented out-of-scope
risk.

## Supply-chain gate

- Signature verification now passes: 384 verified registry signatures and 71
  verified attestations.
- Production audit fails with 17 findings: 1 critical, 7 high, 8 moderate, and
  1 low. The critical `proxy-addr` finding and the high findings outside the
  earlier `node-forge` exception are not covered by the prior Owner decision.
- A green CI run does not override this gate. No finding is silently ignored,
  downgraded, or labeled remediated.

## Remaining gate

Before deployment can be reconsidered, the Owner must either authorize a
separately scoped, supported dependency remediation that no longer preserves
the exact v1.0.8 graph, or explicitly accept the newly enumerated broader
production-dependency risk. A fresh backup, listener/process/config/panel/tunnel
preflight, controlled 8787/7676 cutover, and real `open_workspace + read`
reconciliation would still require a new deployment authorization afterward.
