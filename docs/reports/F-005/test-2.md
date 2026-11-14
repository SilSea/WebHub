# Test report — F-005 — round 2

| | |
|---|---|
| Date | 2026-11-14 |
| Commit | `ba99faa` (fixes for review-1 K1–K12, security-1 S1–S8) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-005 suites + `cli`). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 (run 3 of 3) | 447 | 0 | 6 |
| `profiles`, `profiles-fixtures` (unit), `profiles` (integration), `cli` (unit), Node 22.12 | 77 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## New tests (per finding)
| Finding | Test |
|---|---|
| K1 | built-in dir of hard links (store) loads |
| K2, K4 | `fastapi`: pyproject-only, Django + uvicorn, uvicorn alone → no match; requirements with fastapi → match |
| K3, S2 | `data/profiles` junction → fixed relative message, no absolute path in the result |
| K5 | Vite 4.5 / 5.4 / 6 → `hostRewrite`; Next 12 / 14 keep Host |
| K6 | `static` not chosen with package.json / go.mod / Cargo.toml / requirements.txt / manage.py; `docs/index.html` alone still static |
| K7, S3 | U+202E, U+0085, U+009B, NBSP, fullwidth `＂ ＆`, zero-width, tab → refused; quotes inside / around part of an argument → refused |
| K8 | `*.py` with 41 files: same result in both directory orders (sorted) |
| K9 | two variants valid alone but not together → error on the second; `env: null` switches `via env` → `fixed` |
| K12 | Elysia + Vite in one folder: vite wins without a tie |
| S1 | 256 KB block (28k keys) and flow (22k keys) maps refused in < 2 s; duplicates still found (also `1` vs `"1"`) |
| S4 | `namesNonLoopback` cases; `--host 0.0.0.0` in cmd, var `0.0.0.0`, `{HOST}` = `0.0.0.0` refused |
| S5 | `port.env` PATHEXT / PATH / NODE_OPTIONS / ComSpec / LD_PRELOAD / lowercase refused; PORT / SERVER_PORT / BACKEND_PORT accepted |
| S6 | 16 rules × 8 wildcard alternatives → exactly 64 reads |
| S7 | `--json` output: a key with ESC + 8-bit CSI (U+009B) printed as `?` |

## Flaky (F-004, not changed)
- `cli-stop` "start waits for our stopping daemon to leave (review-4 H1)" hit the 5 s default test timeout in 2 of 4 full-suite runs today (5040 / 5104 ms); passes alone (4/4). One full run also timed out once in F-004 integration "an impostor on the port" (27 s) and did not recur. Cause: machine load during the full suite (`ensureHome` + spawn), the test has no explicit timeout. F-004 is `done` (R1): a fix needs a short test-only CR.
