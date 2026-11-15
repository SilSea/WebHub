# Test report — CR-005 — round 1

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `fix/CR-005-fixture-tempdir-race` (from `develop` `2612fe9`, after the F-005 merge) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Before
On `develop` `2612fe9`, the full suite ran 3 times. Two runs passed (453/6). One run failed `fixture-harness` "rejects a missing fixture before creating any temp dir" after 13 ms. That test counted `webhub-fx-*` in the shared temp dir while `profiles-fixtures` (F-005) was copying fixtures in another worker.

## Summary
| Run | Pass | Fail | Skip |
|---|---|---|---|
| `fixture-harness.test.ts` alone | 19 | 0 | 0 |
| Mutation (temporary `mkdtemp` before the existence check in `test/helpers/fixture.ts`) | — | 1 (expected) | — |
| Full suite run 1 | 453 | 0 | 6 |
| Full suite run 2 | 453 | 0 | 6 |
| Full suite run 3 | 453 | 0 | 6 |

The helper was restored after the mutation; `git status` shows only the test file changed. Lint, typecheck and build pass.
