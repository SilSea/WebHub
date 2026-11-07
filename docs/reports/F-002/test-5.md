# Test report — F-002 — round 5

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-4 / security-4; user chose "แก้ทั้งหมด" = all minor + nit) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI blocked by GitHub billing lock — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 + F-001 + F-002 + CR-001) | 173 | 0 | 5 |

Other checks: lint (Biome), typecheck, build, `pnpm audit` (high) — pass.

## New / changed tests per finding
| Finding | Change | Test |
|---|---|---|
| V1 | elevated node launched with `--openssl-config=NUL` | unit: ELEVATE_PS contains the flag; integration load trace runs with the flag (exit `EXIT.ok`) |
| V2 / G7 | readdir error other than ENOENT → `ELEVATION_UNSAFE`; DLL/manifest entries checked at their path AND real path | unit: missing folder → `[]`, ENOTDIR → `ELEVATION_UNSAFE` |
| V3 | missing `A` (ancestor) entry reported as `missing` | integration: `["A", <tmp>\gone]` → `missing` |
| V4 / G3 | `EXIT` = 40 ok / 41 failed / 42 invalid / 43 expired; `EXIT:10` → `ELEVATION_FAILED` | unit: codes distinct, in 15–128; `EXIT:10`, `EXIT:1` → FAILED |
| G1 | load-trace test waits for `close` | integration |
| G2 | listening cache + killTree deadline use `performance.now()` | (code; existing cache/kill tests pass) |
| G4 | token encoded right before `runPs` (length checked before guard and again) | (code) |
| G5 | — | unit: valid envelope padded to 6144 bytes = exactly 8192 chars → `EXIT.ok`; 6145 bytes → `EXIT.invalid` |
| G6 / V6 | `*.local` next to node.exe → problem "DLL redirection (.local) present" (`loaderRedirectProblems`) | unit |
| G8 | `realPath` moved to win32-trust.ts, exported, resolver injectable | unit: ENOENT → given path; EACCES / ELOOP / EPERM → `ELEVATION_UNSAFE` |
| G9 | volatile-env test skips when `HKCU\Volatile Environment` is missing | integration |
| V5 | spec note: elevated tasks must not depend on inherited env | (docs) |

## Not run
- #10 real UAC elevation (manual) — pending; needs Node + webhub under `C:\Program Files`.
