# Test report — F-006 — round 6 (W1 / W2)

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `feat/F-006-scanner` (on top of `7f6e3c6`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| F-006 suites | 53 | 0 | 0 |

Lint, typecheck and build pass. The full suite runs again after the merge, on `develop`.

## Fixes and their tests
| Finding | Fix | Test |
|---|---|---|
| W1 (user chose: fix) | Compose files are read as docker reads them: the first base file + the first override. Any extra base file is recorded as a problem. With no base file there is no compose; a broken base also means no compose. | `scanner` "compose files as docker reads them": `compose.yaml` + override; `docker-compose.yml` ignored and recorded as a problem; port 3000 comes from the override; an override alone gives `native` |
| W2 (user chose: fix) | `mergeServices` caps the merged list at 200 | `scanner` "more than 200 merged services keep the candidate" |
