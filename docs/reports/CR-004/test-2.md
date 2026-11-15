# Test report — CR-004 — round 2

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `fix/CR-004-flaky-f004-tests` (review-1 M1 + N1 fixed) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Run | Pass | Fail | Skip |
|---|---|---|---|
| Impostor test alone | 1 | 0 | 12 |
| Full suite (`test:full`) run 1 | 393 | 0 | 6 |
| Full suite run 2 | 393 | 0 | 6 |

Lint, typecheck and build pass. `src/` unchanged.

## Changes since round 1
- M1: the impostor test measures `status` before and after `stop --force` and bounds `stop` by `max(both) + 6 s` (4 s headroom against the 10 s wait).
- N1: CR §1 / §3 name the unit test "daemon dead, program on the port" as the load-independent guard.
- N2: recorded as a follow-up in PLAN (user's choice).
