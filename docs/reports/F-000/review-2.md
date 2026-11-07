# Code review — F-000 — round 2

| | |
|---|---|
| Date | 2026-11-07 |
| Diff | `develop..09b8e92` (fix commit `09b8e92`) |
| Reviewer | fresh agent; verified by Claude |

## Round-1 findings
| # | Verdict |
|---|---|
| 1 audit level | fixed |
| 2 pack false pass | fixed |
| 3 silent symlink pass | fixed |
| 4 temp dir leak | fixed in code (see N2) |
| 5 mode not hashed | fixed for files; dir mode added in round 3 |
| 6 built binary untested | fixed |
| 7 docs drift | partial → N4 |
| 8 engines | fixed |
| 9 tautological test | fixed |

## New findings
| # | Severity | File | Problem | Fix | Status |
|---|---|---|---|---|---|
| N2 | nit | `test/unit/fixture-harness.test.ts` | Test name claims "no temp dir leak" but asserts only the error | Renamed; now counts `webhub-fx-*` dirs before/after | fixed (round 3) |
| N3 | nit | `docs/reports/F-000/test-2.md` | Counts say unit 25 / harness 19; actual 24 / 18 (total 28 correct) | Corrected in test-3 (reports are append-only) | fixed (round 3) |
| N4 | nit | spec §9/§10, `reports/README.md` | Round-2 rows / checkboxes not updated | Updated at round close | fixed (round 3) |

Summary: critical 0, major 0 (N1 is in security-2), nit 3.
