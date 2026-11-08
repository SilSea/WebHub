# Test report — CR-002 — round 1

| | |
|---|---|
| Date | 2026-11-08 |
| Branch | `fix/CR-002-lock-race-test` (from `develop`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 |

## Results
| # | Case | Result |
|---|---|---|
| 1 | `store.test.ts` alone ×3 | 4/4 passed each time |
| 1 | `pnpm test:full` ×3 | 173 passed, 5 skipped, 0 failed each time |
| 2 | Mutation: `dist/store/lock.js` `isStale()` always returns `true`, so a live lock gets taken over | New test **fails**: `expected 1794147542018 to be greater than or equal to 1794147544008` (overlap detected) |
| 3 | Other F-001 tests | unchanged, all pass |

Lint, typecheck and build pass. `src/` was not changed.

## Root cause (spike, outside the repo)
`scratchpad/f001-race/`: 4 racers × 20 rounds against `dist/store/lock.js`, run while `pnpm test:full` was also running.

- 4 rounds had 2 winners.
- In every one of those rounds the second winner took the lock **after** the first released it. The lock was never held by two at once.
- Running 8 rounds with only the CPU kept busy (no suite running) did not reproduce it.

Conclusion: the old test expected "exactly one winner". A racer slowed down by load can correctly take the lock once it is free again, so the test's assumption was wrong — the lock is correct.

## Not run
- Linux / macOS (no CI).
