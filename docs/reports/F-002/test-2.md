# Test report — F-002 — round 2

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-1 / security-1) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI blocked by GitHub billing lock — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 + F-001 + F-002) | 159 | 0 | 5 |
| — F-002 (`test/unit/platform.test.ts` + `test/integration/platform.test.ts`) | 38 | 0 | 0 |
| regression F-000 + F-001 | 121 | 0 | 5 |

Other checks: lint (Biome), typecheck, build, `pnpm audit` (high) — pass.

## New / changed tests per finding
| Finding | Test |
|---|---|
| C1 | `canBind` false while another process listens on `::1`, `0.0.0.0`, `::` (3 cases); `findFree` skips a foreign IPv6 listener |
| C2 | killTree finishes < 10 s (deadline 5 s + one CIM call) |
| C3 / S4 | `elevateOutcome`: only `DENIED` (Win32 1223) → `ELEVATION_DENIED`; `FAIL:Win32Exception 2`, `EXIT:2` → `ELEVATION_FAILED` |
| C4 | `notifyVia` with fake runner: script identical for every input and contains no input text; input lines are `f:<base64>` only; elevate script fixed + fields decode back |
| C5 / S7 | empty body survives as a field |
| C6 | `elevatedCommand().script` = `dist/platform/elevated.js` also under vitest (source) |
| C7 | (code path) unreadable start time → `PLATFORM_TOOL` |
| C8 | unsupported stub: `listening()` returns a rejecting Promise (no sync throw); `capabilities()` throws |
| C9 / S3 | token expiry: `decodeTask` at max age ok, +1 ms → `ELEVATION_EXPIRED`, future iat → expired; `elevatedMain` exit 3; timeout (`code -1`) → `ELEVATION_FAILED` |
| C10 | notify failure logged through `setPlatformLog` (FAIL line and spawn error) |
| C13 | integration children / grandchild killed in `afterEach`; foreign-process listeners; excluded-range skip (when machine has one) |
| C14 / S11 | `listening()` result mutation does not affect next call; `fresh` replaces 2.1 s sleeps |
| C15 | `PID_INVALID` for 0 / 1.5 / negative before any tool runs |
| C16 / S10 | `cleanText` removes U+FFFF and lone surrogates; emoji cut by code point |
| S1 | `trustTargets` (files + ancestors), `nodeEnvProblems`; integration: notepad.exe trusted, user temp folder → owner problem, missing file → `missing`; this dev checkout → `ELEVATION_UNSAFE` without any UAC prompt |
| S5 | `descendants`: child older than parent (PID reuse) and unknown start time excluded; children first |
| S8 | manual probe: Thai folder name returned correctly from PowerShell (UTF-8 output) |
| S2 | code: `WorkingDirectory = [Environment]::SystemDirectory` (review) |

## Not run
- #10 real UAC elevation (manual). On this machine the guard refuses (Node and the checkout are under `E:\`, writable by Authenticated Users), so a manual UAC test needs Node + webhub installed under `C:\Program Files`. Pending.
