# W usage monitor red-team release gate

## Scope and decision

This document covers the un-deployed `codex/w-devspace-usage` candidate only.
It measures **estimated MCP model-visible payload tokens**: normalized tool
arguments and model-visible `content` plus `structuredContent`. It does not
measure a W turn, model billing, system prompts, history, reasoning, tool
definitions, or a remaining quota.

**Decision: BLOCKED for deployment.** The implementation may advance through
local code and test gates, but it must not replace the active 7676 or 8787
processes until every release blocker below is resolved and independently
reviewed.

## Evidence that must remain true

- Exact facts (UTF-8 bytes, Unicode code points, calls, and duration) are
  distinct from `o200k_base` estimates. Unknown values remain null/unknown,
  never zero.
- Only numeric metadata and a locally HMAC-pseudonymized session reference are
  persisted. Payloads, commands, paths, raw sessions, and credentials are not.
- A handler exception records request facts and an unknown response. A restart
  interrupted between handler completion and deferred persistence is
  `INTERRUPTED`, is incomplete, and is not a handler `ERROR`.
- Schema/protocol validation that rejects a request before it reaches a handler
  is deliberately outside call accounting. This prevents claiming a tool
  invocation happened when no handler ran.
- On Windows, `download_artifact` is product-disabled. Real MCP tests cover
  all 12 tools enabled across full and Codex modes. A Linux-only, real
  `Client + InMemoryTransport` test now exercises the 13th handler and checks
  its recorded event against the final MCP result, but Windows correctly skips
  it. A Linux CI result is still required before cross-platform release claims
  can say all 13 registration surfaces were executed.

## Current release blockers

1. `npm audit --omit=dev --ignore-scripts --json` still reports two high
   findings from `@anthropic-ai/sandbox-runtime@0.0.80 -> node-forge@1.4.0`.
   Pi is now `1.3.0` and resolves the previously vulnerable
   `brace-expansion`, `undici`, and `protobufjs` versions; DevSpace's Pi
   adapter has been migrated to the upstream `ModelRuntime` API and passed its
   focused regression tests. The node-forge advisory has no patched release,
   and the audit's suggested `sandbox-runtime@0.0.50` downgrade is not a
   proven security fix. Do not use an override or downgrade to manufacture a
   green audit: this remains a P1 deployment block until an upstream-supported
   remediation or an Owner-approved, time-bounded risk decision.
2. Linux CI must execute the native-artifact MCP integration test. Its Windows
   skip is intentional product behavior, not evidence for the Linux path.
3. A fresh-context red-team review must inspect the final diff, current
   dependency tree, Linux result, and release manifest after the blockers are
   resolved.
4. A normal, non-force `npm audit fix` corrected the nonexistent
   `wrappy@1.0.3` metadata and upgraded the supported Vite transitive chain,
   but `npm audit signatures --ignore-scripts` still cannot complete because
   the next target is the nonexistent `util-deprecate@1.0.3` while its tarball
   is published as `1.0.2`. This is not treated as successful signature
   verification; release provenance remains incomplete
   until the registry/lock resolution is reproducibly repaired and rechecked.
5. This candidate remains un-deployed. Runtime preparation, listener backup,
   tokenizer installation, service restart, and W fixture acceptance require a
   separate Owner deployment authorization.
6. **Resolved acceptance boundary — monitor surfaces only.** The privacy
   assertion is deliberately limited to the new usage monitor's SQLite store,
   usage APIs, served usage HTML, and any monitor-specific logging added by
   this change. It does not claim that every pre-existing DevSpace log sink is
   free of paths or truncated commands: the baseline `tool_call` logger can
   emit those fields when its separate logging option is enabled. That is a
   documented, out-of-scope operational-logging risk, not a usage-monitor
   privacy pass or a reason to silently broaden this change into a global
   logger-redaction project.

## Red-team checks performed locally

- Integration: real MCP `Client` plus `InMemoryTransport` exercised all full
  mode tools and all Codex process/patch tools; each handler-path call has one
  measured event.
- Fault semantics: handler errors, tokenizer/cache faults, queue saturation,
  process interruption, retention, cursor expiry, and private health access
  have deterministic tests.
- Privacy: the sentinel verifier scans database, health, overview, calls,
  snapshot, and HTML for raw payload, command, path, token, or session leaks.
- Supply chain: release manifest hashes every deployed runtime sidecar plus the
  compiled `server.js`, `config.js`, and usage modules; source worker equals
  the packaged worker SHA-256 after a clean build. The manifest is explicitly
  an integrity inventory, not a standalone DevSpace executable: deployment
  must install the matching `npm pack` artifact, which supplies the remaining
  application closure; third-party dependencies remain subject to lockfile
  installation and the supply-chain gates below.
- UI: a synthetic, loopback-only preview was inspected at 390, 1024, and 1440
  CSS pixels with no document-level horizontal overflow. The accessible tree
  exposes scope, PARTIAL text-plus-symbol state, coverage ratios, a keyboard
  operable numerical trend table, and collapsed audit detail. The preview's
  only console error was its unserved favicon (test-harness-only, not a usage
  page script error).

## Post-fix verification — 2026-10-19

- The manifest test was first made to fail for the missing compiled
  `config.js`, then passed after `config.js` was added to the integrity
  inventory. The manifest now declares
  `INTEGRITY_INVENTORY_REQUIRES_DEVSPACE_PACKAGE`; it cannot be misrepresented
  as a standalone server distribution. `npm pack --dry-run --json` confirms
  that the matching package contains the broader application `dist` closure;
  third-party dependencies remain governed by the matching lockfile and its
  separate supply-chain gates.
- Local mechanical checks passed: `npm test`, `npm run typecheck`, `npm run
  build`, `npm run test:usage-runtime`, `npm pack --dry-run --json`, and
  `git diff --check`.
- The 1,000-pair performance fixture passed with 0.437 ms added p95 and a
  2.905% p95 end-to-end regression against the 15 ms handler fixture.
- Re-runs confirm the unresolved release blocks rather than masking them:
  `npm audit --omit=dev --ignore-scripts --json` reports the two high findings
  through `node-forge@1.4.0`, and `npm audit signatures --ignore-scripts`
  fails with `ETARGET` for `wrappy@1.0.3`. The existing Ubuntu CI matrix will
  execute the Linux-only test only after a remote CI run; no local Windows
  result is substituted for that evidence.
- The existing OS matrix now enforces the built runtime/manifest privacy gate,
  `npm pack --dry-run --json`, and the usage-monitor performance gate after
  the build. This makes the eventual Ubuntu result cover the artifact handler,
  package shape, and p95 regression, but it is configuration readiness rather
  than a substitute for a completed remote run.
- Full-suite output additionally confirmed the pre-existing general DevSpace
  logger retains tool paths. Under the resolved monitor-only acceptance
  boundary, this is reported as an out-of-scope operational-logging risk, not
  as a monitor-store or usage-API privacy failure.

## Privacy acceptance boundary

The release verifier uses synthetic request, response, command, path, owner
token, and raw-session sentinels. It must prove that none of those values
appear in the usage monitor database, `/api/usage/health`,
`/api/usage/overview`, `/api/usage/calls`, `/api/usage/snapshot`, or served
usage HTML. It must not be expanded to certify unrelated pre-existing DevSpace
log sinks without a separately authorized cross-cutting logger change.

## Required deployment-time checks

- Re-check the existing listener PID, command line, bind address, panel hash,
  and tunnel identity before any cutover.
- Prepare only `H:\workbuddy\runtime\devspace-usage`; the preparation script
  rejects every other canonical path and reparse-point ancestor.
- Verify one 7676 listener, one 8787 listener, unchanged tunnel identity, one
  synthetic MCP fixture, API/SQLite/UI reconciliation, and fail-open tokenizer
  degradation before accepting the release.

## P0 repair review addendum — 2026-10-20

- **Correctness:** reserved special-token syntax is explicitly treated as
  ordinary model-visible text. Fixed error categories replace worker exception
  messages, circuit-open queues terminalize promptly, and a success after the
  reset window is required to demonstrate recovery. Review also found and
  repaired an early-worker-ready race that could otherwise create a false
  startup timeout.
- **Privacy/security:** the health/API/UI boundary exposes category names and
  bounded numbers only. The optional telemetry sink cannot receive baggage,
  request/response text, paths, raw sessions or credentials, and sink failures
  remain fail-open. No exporter, remote endpoint or new dependency was added.
- **Architecture/performance:** the telemetry boundary is dependency-injected
  and disabled by default; SQLite remains local-first. The runtime manifest now
  includes the new compiled telemetry module. The final 1,000-pair benchmark
  remains inside its gate at 0.334 ms added p95 and 2.224% p95 regression.
- **Review verdict:** the local P0 candidate has no open Critical/Required code
  finding after the manifest-closure and readiness-race repairs. Deployment is
  still gated on a new Owner authorization, a fresh backup/cutover check and
  post-activation reconciliation. Linux-native CI evidence remains unavailable
  until an authorized remote CI run; the known audit/signature exception stays
  open and is not relabeled as a pass.
