# Test report — CR-004 — round 1

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `fix/CR-004-flaky-f004-tests` (from `develop` `e389f25`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Run | Pass | Fail | Skip |
|---|---|---|---|
| `cli-stop` (unit) + `cli` (integration), alone | 48 | 0 | 0 |
| Full suite (`test:full`) run 1 | 393 | 0 | 6 |
| Full suite run 2 | 393 | 0 | 6 |

Lint, typecheck and build pass. `src/` unchanged (`git diff --stat`: two test files only).

## Before
- H1 test alone: 3081 ms against the 5 s default; failed 4 times under full-suite load (5024–5104 ms), 2 of 2 in the last F-005 runs.
- Impostor test: `stop --force` < 8 s failed 2 of ~7 F-005 full runs (23.7 s and 27 s total test time).

## After the F-005 merge
The F-005 suite (459 tests) is the load that triggered the failures; the full suite after merging both is recorded in the F-005 regression row.
