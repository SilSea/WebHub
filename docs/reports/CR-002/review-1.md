# Code review — CR-002 — round 1

| | |
|---|---|
| Date | 2026-11-08 |
| Branch | `fix/CR-002-lock-race-test` (base `develop`) |
| Commit | 94c395b |
| Reviewer | fresh agent round 1 |

## Findings
| ID | Severity | File:line | Problem | Scenario | Fix |
|---|---|---|---|---|---|
| C1 | minor | test/integration/store.test.ts:88-92 | The measured hold `[acquired, released]` lies strictly inside the real hold, so a steal that lands between `released` and the unlink is not seen. The racer also never checks that the lock file is still its own. | A slow racer steals the winner's live lock in the last few ms of its hold and the test still passes. Low risk: the window is milliseconds. Bugs that steal early are caught (2 mutations). | Call `await lock.verify()` in the racer before taking `released`. If it fails the racer prints `ERR` and the test fails. This does not depend on timing or the clock. |
| C2 | minor | test/integration/store.test.ts:117-122 | The test accepts winners in sequence and no longer requires `LOST` for a racer that saw a live lock. A regression that waits/retries on a live lock instead of failing fast with `LOCKED` would pass. The test "lock across processes" only checks that LOCKED comes eventually. | `acquireLock` is changed to retry on a live lock; the racers win in turn and every assertion still holds. F-001's fail-fast quietly gets weaker. | Optional: assert that `acquireLock` rejects in under 1.5 s while the holder is alive. This needs the CR scope widened. |
| C3 | minor | docs/changes/CR-002-lock-race-test.md:28 | The pros row says "catches real bugs better than before". That is wrong: the old test failed on any `ERR` or a second `WON`. The gain is that the test no longer fails falsely; it does not detect more. | A reader believes detection improved. | Reword it, and name C2 as the trade-off. |
| C4 | minor | CR §6 vs test-1 | Plan #1 says 10 solo runs; 3 were done. Plan #2 names the `judged`-skip mutation; `isStale` → true was used instead. | Traceability. | Update to what was actually run. This review ran the `judged`-skip mutation in the scratchpad: it failed 6/6 times with overlapping holds. |
| C5 | minor | docs/features/README.md | CR-002 is not in the CR table, the F-001 "related CR" column says `—`, and the §9 checklist is not ticked (R4). | The docs do not match the work. | Add the row and link it, and tick the items that are done. |
| C6 | nit | PLAN / CR status | The CR went straight to `review`, with no `planned` step in its history (approval is recorded). | Audit trail. | Note "approved + planned 2026-11-08" in the log. |
| C7 | nit | store.test.ts:88,90 | `Date.now()` is wall-clock time; a clock stepped backwards gives a false red. | Rare. | Accept; C1 makes the steal case independent of the clock. |
| C8 | nit | store.test.ts:121 | `?? Number.POSITIVE_INFINITY` is dead code (it is only there for `noUncheckedIndexedAccess`). | — | Fine as it is. |

## Verified OK
- **Scope:** only `racer()` and the race test changed. `src/` is unchanged; the other F-001 tests are unchanged.
- **Sort + start ≥ previous end proves no overlap.** These all fail the test:
  - malformed or NaN output
  - `ERR`
  - a crashed racer
- **`holds.length ≥ 1` proves a stale takeover happened every round.**
- **No false fail by design:** `released` is recorded before the unlink, and the next winner can link only after the unlink.
- **Mutations:**

  | Mutation | Result |
  |---|---|
  | `takeOver` without the `judged` re-check (this review) | 6/6 FAIL |
  | `isStale` → true (test-1) | FAIL |
  | real `dist/` (control) | 4/4 PASS |

- **Runs:** build OK. The store test ×3 is 4/4. `test:full` is 173 pass / 5 skip. Lint and typecheck are clean.
- **Timeout:** 60 s is enough.
- **Docs:** spec row 9, the log, PLAN row 4a and CR §1–§5 are correct.

**Status: PASS** — critical 0 · major 0 · minor 5 (C1–C5) · nit 3 (C6–C8)
