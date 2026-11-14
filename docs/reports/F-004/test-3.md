# Test report — F-004 — round 3

| | |
|---|---|
| Date | 2026-11-14 |
| Commit | fixes for review-2 on `feat/F-004-cli-client` (after `933f1f9`) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-004 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 377 | 0 | 6 |
| `cli`, `cli-daemon`, `cli-stop` (unit) + `cli` (integration), Node 22.12 | 83 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## New tests (per finding)
| Finding | Test |
|---|---|
| E1 | fake daemon that proves itself and answers `POST /shutdown` with 503 `SHUTTING_DOWN` → waited for, stopped, one shutdown sent; `authVanished` (`ENOENT` → not running, `EACCES` not) and `isStopping` mapping. The in-process `ENOENT` race itself is not reproduced in a test (reasoned: every connect / status path maps it) |
| E2 | same `ENOENT` mapping in the start poll (reasoned; the port-busy integration test still exits 4) |
| E3 | no auth.json, lock names a live PID with its start time → `stop` waits until it is gone (≥ 250 ms), nothing killed; stale lock (dead PID / other start time) → "not running" at once; integration: 4 concurrent stops all exit 0, then `start` right after exits 0 |
| E4a | process table fails while waiting → `DAEMON_STOP_TIMEOUT`, auth.json kept, nothing killed |
| E4b | our daemon gone, a new proven daemon answers meanwhile → the new one gets the shutdown and is waited for |
| E4c | three 40 000-byte lines, `n = 2` → both last lines whole (fails with `newlines < n`) |
| E4d | proven daemon, lock names another PID, `--force` → `DAEMON_FORCE_REFUSED`, nothing killed |
| E4e | PID alive without a known start time → `DAEMON_IMPOSTOR`, nothing killed |
| E5 | same PID, new token written while waiting → auth.json kept |
| E6 | follow: unterminated last line of the old file printed at rotation; tail: current file cut by the 8 MB cap → `.1` not joined |
| E7 | docs only |

Mutations were not executed (reasoned against the tests above).

## Not run
- Linux and macOS.
- A real Ctrl+C on a terminal; stdout errors other than EPIPE (reasoned).
