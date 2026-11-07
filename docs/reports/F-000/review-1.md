# Code review — F-000 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Diff | `develop..bb0fba1` |
| Reviewer | fresh agent (did not see author reasoning); findings spot-checked by Claude |

## Summary
| critical | major | minor | nit |
|---|---|---|---|
| 0 | 0 | 7 | 2 |

## Findings
| # | Severity | File:line | Problem | Consequence | Fix | Status |
|---|---|---|---|---|---|---|
| 1 | minor | `.github/workflows/ci.yml` (audit step) | `pnpm audit` runs the built-in command, not the `audit` script with `--audit-level high` | CI fails on low/moderate advisories; differs from spec | `pnpm run audit` | open |
| 2 | minor | `test/integration/pack.test.ts` | Passes when `dist/` is missing | Package whose `bin` target is absent passes (false pass, spec test #7) | Assert `dist/cli.js` present; build before pack in test | open |
| 3 | minor | `test/unit/fixture-harness.test.ts` (symlink test) | Bare `return` when symlink not permitted | Reports pass with zero assertions | `ctx.skip()` | open |
| 4 | minor | `test/helpers/fixture.ts` `copyFixture` | Temp dir leaks if `cp` throws | Orphan `webhub-fx-*` dirs | Clean up on failure; check source exists first | open |
| 5 | minor | `test/helpers/fixture.ts` `hashTree` | File mode not recorded | Permission change passes Zero-touch check | Include mode bits in entry | open |
| 6 | minor | `src/cli.ts` `isMain` | Built binary / shebang untested; `node dist/cli` (no ext) silently no-ops | Regression in entry detection undetected | Integration test running `dist/cli.js` | open |
| 7 | minor (R4) | `docs/features/F-000-scaffolding.md`, `docs/features/README.md`, `docs/reports/README.md` | Status/report links not updated | Docs drift | Update in branch | fixed (R4 mandatory, same round) |
| 8 | nit | `package.json` engines | `>=22.12` vs spec `>=22` | Spec mismatch | Amend spec (Vitest requires 22.12) | open |
| 9 | nit | `test/unit/fixture-harness.test.ts` "untouched copy passes" | Compares map with its own copy, never re-hashes | Tautological test | Re-hash the copy | open |

## Checked
- [x] Matches spec (except #8)
- [x] No files outside scope
- [x] No `done` features affected (none exist)
- [ ] Docs match code (#7)
