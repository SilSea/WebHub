# Security review (R6) — CR-002 — round 1

| | |
|---|---|
| Date | 2026-11-08 |
| Branch | `fix/CR-002-lock-race-test` (base `develop`) |
| Commit | 94c395b |
| Reviewer | fresh agent round 1 |

## Findings
| ID | Severity | File:line | Problem | Scenario | Fix |
|---|---|---|---|---|---|
| D1 | minor | test/integration/store.test.ts:82-103 | This test is the main guard against a lock bypass (two daemons writing `data/`). It catches any steal that overlaps the measured hold, as both mutations show. It misses a steal in the few ms between `released` and the unlink, and it does not check that the lock file is still the winner's own (same as C1). | A future refactor of `takeOver`/`removeIf` that only fails around release slips through, and `data/` could then be corrupted. Unlikely: the window is narrow. | `await lock.verify()` at the end of the hold. |
| D2 | nit | store.test.ts:117-122 | Fail-fast `LOCKED` is no longer asserted (C2). That is availability, not exclusion: a daemon that waits does not gain write access. | — | Covered by C2. |

## Verified OK
- **No runtime change.** `src/` is unchanged, so the attack surface and F-001's threat model are unchanged (CR §7).
- **Racers are spawned safely.**
  - They use `process.execPath` with no shell.
  - Every value interpolated into the script goes through `JSON.stringify`.
  - There is no external input, no network and no secrets.
- **Zero-touch (R0).** The fake lock is written only inside the temp home; no real home or project is touched.
- **A real bypass (two holders at once) is still caught.** Both mutations failed the test.
- **No dependencies changed.**

**Status: PASS** — critical 0 · major 0 · minor 1 (D1) · nit 1 (D2)
