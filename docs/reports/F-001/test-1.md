# Test report — F-001 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — F-001 implementation) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI blocked: GitHub account billing lock — Linux/Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| unit — F-001 (home 8, home-fs 6, json-store 20, lock 8, config 11, secrets 10) | 60 | 0 | 4 |
| unit — F-000 (cli 6, fixture harness 19) | 25 | 0 | 0 |
| integration — F-001 (lock across processes 1, zero-touch 2) | 3 | 0 | 0 |
| integration — F-000 (pack contents 1, built CLI 3) | 4 | 0 | 0 |
| — total | 89 | 0 | 4 |
| regression (F-000) | 29 | 0 | 0 |

Skipped on Windows by design: POSIX 0700 home, POSIX 0600 files, non-Windows DPAPI error, symlinked **file** (creating a file symlink needs admin / Developer Mode; the junction variants of the symlink tests ran).

## Spec test plan coverage
| # | Case | Test |
|---|---|---|
| 1 | resolveHome env/default/relative | `home.test.ts` |
| 2 | home symlink / drive root / inside scan root | `home.test.ts`, `home-fs.test.ts`, `config.test.ts`, `store.test.ts` |
| 3 | ensureHome layout + ACL (2 entries, no inheritance, no Everyone/Users) / POSIX 0700 | `home-fs.test.ts` |
| 4 | config default / valid / invalid lists every key path | `config.test.ts` |
| 5 | relative paths resolve in home; `../` escape rejected | `config.test.ts` |
| 6 | atomic write, `.bak`, no tmp left | `json-store.test.ts` |
| 7 | migration step-by-step, backup first, no write without lock, broken migration leaves file | `json-store.test.ts` |
| 8 | newer schemaVersion → `CONFIG_FROM_NEWER_VERSION`, file unchanged | `json-store.test.ts`, `config.test.ts` |
| 9 | lock: second process `LOCKED` (real child process); dead PID / reused PID / garbage → take over; other host stays locked; release keeps foreign lock | `lock.test.ts`, `store.test.ts` |
| 10 | symlink/junction inside `data/` refused for read + write | `json-store.test.ts`, `home-fs.test.ts` |
| 11 | > 5 MB → `FILE_TOO_LARGE` (read + write) | `json-store.test.ts` |
| 12 | secrets set/get/delete, reopen, no plaintext on disk, inspect/JSON hide values, lock required, key validation, backend mismatch, tampered file; real DPAPI round-trip incl. empty secret | `secrets.test.ts` |
| 13 | generateSecret length/charset/unique/min size | `secrets.test.ts` |
| 14 | zero-touch: fixture copy as scan root unchanged after load/save | `store.test.ts` |
| 15 | F-000 regression | all F-000 suites |

## Bugs found by tests (fixed in this round)
| # | Severity | Bug | Fix |
|---|---|---|---|
| 1 | major (security) | `whoami` / `icacls` / `powershell` / `ps` were resolved through PATH — under Git Bash the coreutils `whoami` ran instead (SID lookup failed); also a binary-planting vector | `systemExe()` — absolute OS paths only (spec §3.7) |
| 2 | major | DPAPI batch dropped empty secrets (empty base64 line filtered) → count mismatch → `SECRET_BACKEND` | every item sent/received as `b:<base64>` |
| 3 | — (test) | F-000 pack test listed only top-level `src/*.ts`, so `dist/` files from subfolders were "unexpected" | read `src/` recursively; intent unchanged (spec §5 Impact) |

Other checks: lint, typecheck, build, `pnpm run audit` (high) — pass. Temp dirs left after run (`webhub-home-*`, `webhub-fx-*`): 0.
