# Test report — CR-005 — round 2

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `fix/CR-005-fixture-tempdir-race` (review-1 m1, m2, n1 fixed) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Run | Pass | Fail | Skip |
|---|---|---|---|
| `fixture-harness.test.ts` alone | 19 | 0 | 0 |
| Full suite run 1 | 453 | 0 | 6 |
| Full suite run 2 | 453 | 0 | 6 |
| Full suite run 3 | 453 | 0 | 6 |

Lint, typecheck and build pass. Only `test/unit/fixture-harness.test.ts` changed outside docs.

## Changes since round 1
- m1: positive control. While TEMP is redirected, a real `copyFixture("vite-basic")` must land in the private dir; it is then removed and the dir checked empty again.
- m2: the limit ("no leftover dir" only) is stated in the test comment and CR §3.
- n1: comment that the test relies on per-file process isolation and must stay sequential.
