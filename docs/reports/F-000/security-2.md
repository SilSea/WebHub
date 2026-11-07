# Security review — F-000 — round 2

| | |
|---|---|
| Date | 2026-11-07 |
| Diff | `develop..09b8e92` |
| Reviewer | fresh agent; verified by Claude |

## Round-1 findings
| # | Verdict |
|---|---|
| 1 audit level | fixed |
| 2 stale dist published | fixed (clean before build; pack allows only dist files backed by src) |
| 3 broken source maps | fixed (`inlineSources`) |
| 4 fixture symlinks | partial → N1 |

## New findings
| # | Severity | File | Issue | Fix | Status |
|---|---|---|---|---|---|
| N1 | **major** (reviewer said minor; raised per WORKFLOW §8: missing defense-in-depth on a checklist item — Zero-touch) | `test/helpers/fixture.ts` `copyFixture` | A fixture dir that is itself a symlink/junction is copied as a link → tests would write to the real fixture while the before/after hash of the "copy" stays equal → Zero-touch check passes falsely | `lstat` the fixture dir and reject links; require `realpath(src)` inside `realpath(root)`; test with a junction as fixture dir | fixed (round 3) |

Checklist re-check: Dependencies, Input, Secrets, Zero-touch — pass after N1 fix. CI permissions/pinning unchanged.
