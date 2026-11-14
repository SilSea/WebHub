# Test report — F-004 — round 4

| | |
|---|---|
| Date | 2026-11-14 |
| Commit | fixes for review-3 on `feat/F-004-cli-client` (after `95f10f0`) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-004 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 392 | 0 | 6 |
| `cli`, `cli-daemon`, `cli-stop` (unit) + `cli` (integration), Node 22.12 | 98 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## New tests (per finding / surviving mutation of review-3)
| Finding | Test |
|---|---|
| G1 (M4, M17) | no auth.json, lock held; auth.json written at 150 ms, daemon listens at 450 ms → status asked again until it answers, one shutdown, stopped |
| G2 | hung while starting + `--force` → `killTree(lock pid, lock startedAt)`, `forced: true`; without `--force` → `DAEMON_STOP_TIMEOUT` with the `--force` hint, nothing killed |
| G3 M9 | lock PID alive, start time unknown → "not running" at once |
| G3 M18 | process table fails while waiting on the lock PID → timeout, not "stopped" |
| G3 M6 / M15 | `daemonStatusChecked`: ours not answering → `DAEMON_NOT_ANSWERING`; ours gone + new proven daemon → its status; ours gone + squatter → `DAEMON_IMPOSTOR` |
| G3 M7 | `startDaemonProcess` with our daemon stopping: waits (≥ 250 ms) until it leaves, then spawns (fixture exits 2 → `DAEMON_START_FAILED`) |
| G3 M13 | `ensureDaemon` with another program on the port → `DAEMON_IMPOSTOR`, `onStart` never called |
| G3 M1 / M3 | `readDoc` mocked to throw `ENOENT` once: during `daemonStatus` → not running; on the shutdown connect → waited for, stopped |
| G3 M8 | `transientAsUndefined(ENOENT)` → undefined; other errors rethrown |
| G3 M14 | `isStopping` with status 500 → false |
| G3 M16 | only `.1` exists → its lines |
| G4 | docs only |
| G5 | reasoned (output errors no longer exit mid-command; exit code kept, non-EPIPE turns 0 into 1) |

Mutations were not re-run here; the review checks them.

## Not run
- Linux and macOS; a real Ctrl+C on a terminal; real stdout errors (reasoned).
