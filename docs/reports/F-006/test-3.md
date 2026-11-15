# Test report — F-006 — round 3 (after review-2 fixes + chosen minors)

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `feat/F-006-scanner` (fixes on top of `cd99cdb`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0 + Node 22.12.0, pnpm 12.9.1 |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| F-006 suites (`scanner`, `scanner-fixtures`, `scan`) | 45 | 0 | 0 |
| F-006 suites on Node 22.12 | 45 | 0 | 0 |
| Full suite | 498 | 0 | 6 |

Lint, typecheck and build pass. The machine load was lower in this run, and the pre-existing timing failures from test-1 / test-2 did not occur.

## Fixes and their tests
| Finding | Fix | Test |
|---|---|---|
| R1 major (regression): the per-root share cut scans that fit the limit | The share was removed. Roots are walked round robin, one folder each in turn. Truncation happens only at the global limit. `truncated.root` was removed. | `scanner` "missing roots next to a big root do not cut it" |
| R2 major: an earlier root starved the later ones (candidates / bytes) | Round-robin walk plus round-robin detection across roots. The fingerprint no longer reads lockfiles. | `scanner` "a hostile first root cannot use up candidates / bytes of the next" (candidates: 20; bytes: 20 000) |
| C5 | Done in round 2: the original must be a shown candidate that is not itself a duplicate | `scanner-fixtures` "a copy inside …" |
| C6 | Only a `site` hides the folders under it | `scanner` "a non-web folder above does not hide projects" |
| C9 / S7a | Sub-folder listings in the view are filtered with `badName` | No test: Windows refuses those names (same limit as test-1); the code path is the same as the walk |
| C11 / S7d | A result over 4 MB drops candidates from the end + `truncated: candidates` | No test: needs about 2000 long paths; noted for CI |
| C12 | `loadLast` is single-flight; a scan that finishes during the read wins | Covered indirectly by `scan` (integration) |
| C13 | `DELETE ?scanId=` (the CLI always sends it); after a 409 for a scan that already ended, the CLI POSTs again (≤ 3) | `scan` "DELETE of another scanId cancels nothing" |
| C14 | `GET ?result=0` → `last: null` while a scan runs; the CLI polls with it | `scan` "`?result=0` while a scan runs" |
| S4 | A monorepo merge happens only inside the same scan root (`dirname`) | `scanner` "merges stay inside roots" |
| S5 | The compose port text is rebuilt from the numbers | `scanner` "port text is rebuilt from numbers" |
| S6 | Hints must match the version grammar; `packageManager` must be `name@x.y.z` | `scanner` "runtime hints refuse shell characters" |
| C19 | Spec: file names, depth, DELETE during the write | — |

Remaining minors → follow-up in `docs/PLAN.md` (C7 part, C8, C10/S7b, C15, C16, C17, C18 part, S7c). Round-2 minors R3, R4 and R5 are waiting for the user's decision.
