# Test report — F-006 — round 4 (after review-3 fixes)

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `feat/F-006-scanner` (fixes on top of `ef569fa`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0 + Node 22.12.0, pnpm 12.9.1 |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| F-006 suites | 49 | 0 | 0 |
| F-006 suites on Node 22.12 | 49 | 0 | 0 |
| Full suite | 502 | 0 | 6 |

Lint, typecheck and build pass.

## Fixes and their tests
| Finding | Fix | Test |
|---|---|---|
| Q1 major: the C11 size check used compact JSON | `fitToStore` measures the store's own serialization (`JSON.stringify(v, null, 2)\n`) against `MAX_FILE_BYTES − 256 KB` | `scanner` "fitToStore measures what the store writes": the compact size fits, the pretty size does not, so candidates are cut |
| R3 (user chose: fix) | A compose file that fails to parse is not listed; service names from the parent and the children are deduped | `scanner` "parent + child compose" |
| R4 (user chose: fix) | Same or nested scan roots → status `inside-root`, walked once | `scanner` "same / nested scan roots are walked once" (also with the inner root listed first) |
| R5 (user chose: docs) | Spec: `truncated` holds the first limit hit | — |
| Q2 | When a lean poll sees another scan running, the CLI reads the full state once before reporting `SCAN_LOST` | No test: a race between two clients; the code path is short |
| Q3 | Any candidate hides the non-site folders inside it; only a `site` hides sites | `scanner` "non-web projects hide the non-web folders inside them" (Unity + Packages) |
| Q4 | Corrected the comment; the F-015 row in PLAN says hints never go into a command line | — |
