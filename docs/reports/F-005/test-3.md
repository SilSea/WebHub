# Test report — F-005 — round 3

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | fixes for review-2 L1–L6 on `feat/F-005-profiles` (after `a3ab032`) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-005 suites + `cli`). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 452 | 1 (F-004, flaky — below) | 6 |
| `profiles`, `profiles-fixtures` (unit), `profiles` (integration), `cli` (unit), Node 22.12 | 83 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## New tests (per finding)
| Finding | Test |
|---|---|
| L1 | `--host 0.0.0.{Z}` + var `Z: "0"` refused at load; `--host` / `--host=` with `0`, `0x0`, `0.0`, `0.0.0`, `::0`, `0::`, `[::0]`, `0:0:0:0:0:0:0:0`, `0127.0.0.1`, `167772161`, `0177.1`; positional `0.0.0.0:8000`, `[::]:80`, `HOST=0`; render-time assembly refused; loopback / `--workers 0` / `localhost` accepted |
| L2 | variants V0 + V2 without V1 → error on variant 2; 9 variants refused |
| L3 | `none` still excludes after `any` used up its 64 reads |
| L4 | 6000 `{}` items → node cap (maps counted); file limit 64 KB; parse cache: edited file re-parsed, error cached and reported again |
| L5 | `fastapi==0.110.0.1`, `pkg=1.2.3.4-1` not addresses; such an install command loads |
| L6 | docs; `static-spa` `none` list aligned with `static` |

## Flaky (F-004, not changed here)
- `cli-stop` "start waits for our stopping daemon" (5 s default timeout) failed 2 of 2 full runs; F-004 integration "an impostor on the port" (`stop --force` < 8 s) failed 2 of ~7 full runs. Both pass alone. User approved CR-004 (test-only) for both, done before the F-005 merge.
