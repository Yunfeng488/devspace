# W usage monitor release evidence

## Current candidate boundary

- Branch: `codex/w-devspace-usage`.
- Production-source base: DevSpace v1.0.8 commit
  `fe712e2b6c07231d2a76503bf2a674b165850616`.
- Audited monitor implementation commit:
  `6c6423b3ef926f21869dc5eac3c0946dd45af213`.
- The dependency lock is byte-for-byte identical to the v1.0.8 base. Both
  copies have Git object id `dd8546fca58df0a0104d7dacd66bd5c9e611d770`.
- The Pi adapter and its focused tests are also identical to the v1.0.8 base.
  Installed direct versions are `@anthropic-ai/sandbox-runtime@0.0.71`,
  `@earendil-works/pi-coding-agent@0.80.3`,
  `@modelcontextprotocol/sdk@1.29.0`, and `express@5.2.1`.
- `.playwright-cli/` is pre-existing untracked output and is excluded from all
  commits.
- This evidence does not authorize deployment, a 7676/8787 restart, panel or
  tunnel changes, credential access, or writes to `%USERPROFILE%\.workbuddy`.

## Monitor behavior

- Scope is fixed to `MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE`.
- Exact bytes, characters, calls, and duration remain distinct from estimated
  `o200k_base` tokens. Unknown or partial coverage is never converted to zero.
- The Python worker uses `disallowed_special=()`, so reserved-token-looking
  text is counted as ordinary model-visible text.
- Coverage epoch is `mcp-visible-v3`. Earlier incomplete history remains
  `PARTIAL`; it is not backfilled.
- Tokenizer startup, exit, protocol, encode, timeout, and circuit-open faults
  use fixed categories. Circuit opening terminalizes queued work, and a later
  successful count proves recovery.
- The optional telemetry sink is disabled by default and receives only bounded,
  low-cardinality metadata. Handler exceptions now report response coverage as
  `UNKNOWN_RESPONSE`, not `AVAILABLE`.
- Privacy acceptance covers the monitor SQLite database, usage APIs, usage
  HTML, and monitor-specific logs. Pre-existing general DevSpace logs remain
  an explicitly out-of-scope risk.

## Mechanical verification

Local Windows checks completed successfully after a clean dependency install:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run test:usage-runtime`
- `npm run benchmark:usage`
- `npm pack --dry-run --json`
- `git diff --check`

The final local 1,000-pair benchmark added 0.5922 ms at p95, a 3.9419%
regression against the 15 ms fixture, within the 5% gate.

GitHub Actions run
[`39530330898`](https://github.com/Yunfeng488/devspace/actions/runs/39530330898)
passed on `ubuntu-latest`, `windows-latest`, and `macos-15-intel`. On all three
jobs, Typecheck, Test, Build, Usage runtime release gate, Package dry run,
Usage monitor performance gate, and Doctor completed successfully. Ubuntu also
installed the Pi sandbox dependencies and ran the Linux-only native artifact
test; the Windows/macOS sandbox-install skip is intentional.

The built runtime manifest declares `mcp-visible-v3` and
`INTEGRITY_INVENTORY_REQUIRES_DEVSPACE_PACKAGE`. Its tokenizer worker SHA-256
is `2e839561ce79105575ecbb7799b5a5d5b120483f45a21a992b017770da9039de`.

## Supply-chain result

- `npm audit signatures --ignore-scripts` now succeeds: 384 packages have
  verified registry signatures and 71 have verified attestations. This is a
  real change from earlier evidence and supersedes the previous ETARGET note.
- `npm audit --omit=dev --ignore-scripts --json` fails with 17 findings:
  1 critical, 7 high, 8 moderate, and 1 low. The critical finding is
  `proxy-addr`; high findings include the restored v1.0.8 chains through
  `node-forge`, the MCP SDK, `brace-expansion`, `fast-uri`, `ip-address`, and
  `undici`.
- These findings are a consequence of restoring the exact v1.0.8 dependency
  graph. They are broader than the Owner's earlier temporary exception for the
  two `node-forge` highs and signature failure. They are not accepted, waived,
  or described as fixed.

## Disposition

`DEPLOYMENT_BLOCKED` despite green functional CI. The candidate is a verified
v1.0.8-same-source monitor implementation, but the newly exposed critical/high
dependency set requires a separate Owner decision or an independently scoped,
supported dependency-remediation plan. Deployment and restart remain outside
the current authorization.

## Historical note

An earlier candidate was activated on 2026-10-20 after a backup and later
showed tokenizer failures on reserved marker text. The present branch repairs
that behavior but has not been deployed or used to restart 7676/8787 in this
release cycle. Historical activation evidence must not be read as deployment
evidence for the current commit.
