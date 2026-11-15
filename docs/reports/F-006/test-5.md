# Test report — F-006 — round 5 (after review-4 fixes)

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `feat/F-006-scanner` (fixes on top of `48ac944`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0 + Node 22.12.0, pnpm 12.9.1 |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| F-006 suites | 51 | 0 | 0 |
| F-006 suites on Node 22.12 | 51 | 0 | 0 |
| Full suite | 502 | 2 (pre-existing timing) | 6 |
| Rerun of the 2 failing files | 39 | 0 | 0 |

Lint, typecheck and build pass.

The 2 full-suite failures were "PID reused while waiting" (F-004) and "second process gets LOCKED" (F-001). Both are timing failures already listed in test-1, and `develop` also failed "second process gets LOCKED" under load. Both files passed when rerun on their own.

## Fixes and their tests
| Finding | Fix | Test |
|---|---|---|
| V1 major: a root inside another root was skipped even when the outer walk never reaches it | A duplicate root → `inside-root`, not walked. A nested root → `inside-root` but still walked. A shared `visited` set means each folder is listed once. Findings belong to the outermost root. | `scanner` "same / nested scan roots …": roots deeper than `maxDepth` and inside `vendor/` are found |
| V2 major: compose base + override files were not merged by service | `mergeServices` merges by name in file order, then classifies infra | `scanner` "compose base + override: services merged by name" (`web` stays one app; `db` stays infra → `hybrid`) |
| V3 (user chose: fix) | Unread drafts carry a flag; they are never hidden as non-sites | `scanner` "folders not looked at stay listed": `nested()` tested directly |
