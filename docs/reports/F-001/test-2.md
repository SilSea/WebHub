# Test report — F-001 — round 2

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-1 / security-1) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI still blocked by GitHub billing lock) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| unit (F-001 + F-000) | 91 | 0 | 5 |
| integration (pack, built CLI, lock across processes, stale-lock race, zero-touch) | 8 | 0 | 0 |
| — total | 99 | 0 | 5 |
| regression (F-000) | 29 | 0 | 0 |

Skips on Windows by design: POSIX 0600 files, POSIX 0700 home, POSIX group/other strip, non-Windows DPAPI error, symlinked file (needs admin / Developer Mode).

## New tests for round-1 findings
| Finding | Test |
|---|---|
| R1 / S1 stale-lock race | unit: 4 concurrent `acquireLock` × 5 rounds → exactly 1 winner; integration: 4 real processes × 3 rounds → 1 `WON`, 3 `LOST` |
| R1 lock replaced | `verify()` → `NOT_LOCKED`, `held=false`; release keeps the foreign lock |
| R2 / S4 uninspectable process | `processState(4)` (System) never `dead`; bad / missing PID → `dead` |
| R3 concurrent secrets | 8 parallel `set` + mixed `set`/`delete` → nothing lost after reopen; failed write does not block the queue |
| R4 stdin crash | child exits before reading 2 MB stdin → exit code 3, no crash |
| S3 child ACL | pre-existing `data\` with `Everyone:F` (protected) + file → after `ensureHome` no `Everyone` on either; POSIX variant strips group/other |
| S2 owner check | not unit-testable without a second local account; covered by code review (owner/parent SID checked on every `ensureHome`) |
| R13 | ACL test now uses `systemExe("icacls.exe")` |

Other checks: lint, typecheck, build — pass.
