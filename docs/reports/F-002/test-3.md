# Test report — F-002 — round 3

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-2 / security-2, with CR-001 merged into the branch) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI blocked by GitHub billing lock — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 + F-001 + F-002 + CR-001) | 164 | 0 | 5 |
| — F-002 platform tests | 43 | 0 | 0 |
| regression F-000 (incl. CR-001 pack test) + F-001 | 121 | 0 | 5 |

Other checks: lint (Biome), typecheck, build, `pnpm audit` (high) — pass.

## New / changed tests per finding
| Finding | Test |
|---|---|
| T1 / D1 | `nodeEnvProblems` flags `OPENSSL_CONF`, `OPENSSL_MODULES`, `SSL_CERT_FILE`, `UV_*`, `NODE_*` (not `NODE_ENV`, `JAVA_HOME`, `Path`); case-insensitive dedupe |
| T2 / D2 | integration: `persistentEnvNames()` includes volatile-only names (USERDOMAIN / SESSIONNAME / LOGONSERVER); elevate also checks `process.env` |
| T3 | unit: `elevated.mts` source imports only `node:*`; parity — hand validator never accepts what zod rejects (incl. `__proto__`, inherited `kind`, arrays); integration: built `dist/platform/elevated.mjs` run with a `registerHooks` load trace exits 0 and loads no module except itself |
| T4 | `elevatedCommand().exe` = `realpathSync.native(process.execPath)`; script = `dist/platform/elevated.mjs` |
| T5 | (code) WriteEA / WriteAttributes in the full mask |
| D3 | excluded-range test merges adjacent reserved ranges and searches past the run |
| D4 | n/a — `node_modules` no longer part of the trust set (T3) |
| D5 | `descendants` returns root first, then parents before children |
| D7 | `C:\Users\Public`: trusted owner + `writable by S-1-…` (exercises ACE mask on a real ACL) |
| D8 | temp-folder assertion = any problem (works when run elevated) |
| D9 | `foreignListener` resolves `undefined` on child exit/error → test skips instead of hanging |
| D10 | (code) fail-fast only on the 2nd poll |
| D11 | (code) fresh caller joins only a query started at/after its call |
| D14 | (code) kill failure details = exit code, no OEM-encoded text |
| CR-001 | pack test passes with `dist/platform/elevated.mjs(.map)`; see CR-001 test-1 for stray-file check |

## Not run
- #10 real UAC elevation (manual) — still pending; requires Node + webhub under `C:\Program Files` on a test machine.
