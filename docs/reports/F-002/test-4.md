# Test report — F-002 — round 4

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-3 / security-3; user chose "Fix + review round 4" and "Fix all") |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI blocked by GitHub billing lock — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 + F-001 + F-002 + CR-001) | 168 | 0 | 5 |

Other checks: lint (Biome), typecheck, build, `pnpm audit` (high) — pass. `require('./dist/platform/index.js')` works (no async module graph — E9).

## New / changed tests per finding
| Finding | Test |
|---|---|
| U1 | `nodeEnvProblems` refuses `ＯPENSSL_CONF`, `OPENŚSL_CONF`, `ŌPENSSL_CONF`, `OPENSSL＿CONF`, a Thai name — all reported as non-ASCII |
| U2 | `ICU_DATA` refused |
| U3 | `elevationFiles` includes `*.dll` / `*.manifest` / `*.local` found in node's folder (case-insensitive), ignores other files; integration uses `nodeDirEntries` |
| U6 | (code) `Test-Path` inside try → `unreadable` |
| E1 | integration asserts a volatile-only name (APPDATA / LOCALAPPDATA / HOMEPATH); unit asserts ENV_PS reads machine, user, volatile + session subkeys |
| E2 | load-trace test skips when `module.registerHooks` is missing (Node < 22.15) |
| E3 | load trace: exit = `EXIT.ok` (10), exactly 1 non-builtin module = elevated.mjs; bad token → exit 2 |
| E4 | `EXIT.ok !== 0`; `elevateOutcome("EXIT:0")` → `ELEVATION_FAILED`; `EXIT:10` → ok |
| E5 | parity both directions on JSON-tripped values (zod accepts an inherited `kind`, JSON drops it — noted); every `ElevatedTaskSchema` option must have a sample accepted by both |
| E6 | (code) realPath falls back only on ENOENT, else `ELEVATION_UNSAFE` |
| E7 | elevated main: token longer than `TOKEN_MAX_LENGTH` → 2; `elevate()` checks length before UAC (code path) |
| E8 | (code) cache `at` = query start; older query never overwrites newer snapshot |
| E9 | `require()` of the dist ESM graph works (manual check above) |
| E10 | hint + spec note on package-manager shims setting `NODE_PATH` |

## Not run
- #10 real UAC elevation (manual) — pending; needs Node + webhub under `C:\Program Files`.
