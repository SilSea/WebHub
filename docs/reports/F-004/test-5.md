# Test report — F-004 — round 5 (final)

| | |
|---|---|
| Date | 2026-11-14 |
| Commit | fixes for review-4 H1–H4 on `feat/F-004-cli-client` (after `0e07f01`) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-004 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 393 | 0 | 6 |
| `cli`, `cli-daemon`, `cli-stop` (unit) + `cli` (integration), Node 22.12 | 99 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## Changes (per finding)
| Finding | Test |
|---|---|
| H1 | "start waits for our stopping daemon" is event-driven: the old daemon stays alive for the first two `process.info` looks (status check, owner check) and leaves on the third, which only the wait loop makes; asserts ≥ 3 looks and that the start then spawned (`DAEMON_START_FAILED` from the fixture) |
| H2 | hung while starting + `--force`: auth.json written (port with no listener) → killed `(lock pid, lock startedAt)` and auth.json removed |
| H3 | re-asking a starting daemon whose status is invalid → `DAEMON_BAD_STATUS` reported, not swallowed |
| H4 | code: re-entry gets the remaining deadline (reasoned; no timing test) |

User decision: fix H1–H4 and merge without a review round 5.

## Not run
- Linux and macOS; a real Ctrl+C on a terminal; non-EPIPE stdout errors (reasoned).
