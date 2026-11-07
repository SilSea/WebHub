# Test report — F-001 — round 5 (final)

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-4 G1–G3) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI blocked by GitHub billing lock — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| unit (F-001 + F-000) | 113 | 0 | 5 |
| integration | 8 | 0 | 0 |
| — total | 121 | 0 | 5 |
| regression (F-000) | 29 | 0 | 0 |

## New tests
| Finding | Test |
|---|---|
| G1 / G3 | existing folder with foreign content (`notes.txt`) → `HOME_INVALID` listing it; ACL (icacls output / POSIX mode) and contents unchanged — fails if any restrict ran before the read-only checks |
| G1 | existing empty folder / webhub layout (`data/`, `webhub.config.json`) accepted |
| G2 | second audit pass (code path: marker written only when the second pass fixes nothing; else `HOME_INVALID`). Needs a second account to race — not reproducible in tests |

Other checks: lint, typecheck, build, `pnpm run audit` (high) — pass.
