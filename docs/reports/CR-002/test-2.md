# Test report — CR-002 — round 2

| | |
|---|---|
| Date | 2026-11-08 |
| Branch | `fix/CR-002-lock-race-test` |
| Change | Fixes for review-1 / security-1. User decision: "แก้ทั้งหมด + ขยาย scope". |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 |

## Changes
| Finding | Change |
|---|---|
| C1 / D1 | Before releasing, `racer()` calls `lock.verify()`. If the lock file is no longer the racer's own, it prints `ERR NOT_LOCKED` and the test fails, whatever the timing or clock. |
| C2 / D2 | The "lock across processes" test now also checks that a live lock is rejected with `LOCKED` in under 5 s (fail fast). The CR scope was widened for this. |
| C3 / C4 / C6 | CR text corrected: pros/cons, test plan and approval history. |
| C5 | `features/README.md` (F-001 → CR-002, CR row) and `reports/README.md` updated. The §9 checklist is ticked. |

## Results
| Case | Result |
|---|---|
| `store.test.ts` alone | 4/4 pass, about 31 s |
| `pnpm test:full` ×2 | 173 passed, 5 skipped, 0 failed each time |
| Mutation C2: `dist/store/lock.js` retries on a live lock (sleep 100 ms + continue, instead of throwing `LOCKED` at once) | "second process gets LOCKED…" **fails** (18.7 s) |
| Mutations of round 1 (`isStale` → true; `takeOver` skipping `judged`) | Fail (test-1, review-1) |
| lint, typecheck, build, `pnpm audit` | pass |

`src/` is unchanged.
