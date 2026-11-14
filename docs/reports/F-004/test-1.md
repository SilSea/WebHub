# Test report — F-004 — round 1

| | |
|---|---|
| Date | 2026-11-13 |
| Commit | (this commit) on `feat/F-004-cli-client`, base `develop` after CR-003 |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-004 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 346 | 0 | 6 |
| `cli`, `cli-daemon` (unit) + `cli` (integration), Node 22.12 | 52 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## Spec §8 coverage
| # | Test |
|---|---|
| 1 | `--help`, `-h`, no args, `--version`, `-v`, unknown command → 1 (F-000 tests, now `await`); unknown global option → 1; `daemon --help` / `-h` / `status --help` → 0; `daemon` alone → usage + 2 |
| 2 | `daemon bogus`, unknown option, positional, `start --force`, `-n 0`, `-n abc`, `-n 10001`, `-n -5`, `-n 1e3` → 2 |
| 3 | Real daemon via `dist/cli.js`: start → status `--json` (PID = auth.pid, port) from a new CLI process → logs → stop → auth.json gone, PID gone → status 3; stop again → 0 "not running" |
| 4 | start twice → second `alreadyRunning`, same PID |
| 5 | two starts at once → both 0, same PID, one daemon |
| 6 | API port held by another socket → start exit 4, message names the port |
| 7 | auth.json kept + squatter on the port → status / stop exit 1 ("not the webhub daemon"); the squatter never received an `authorization` header |
| 8 | daemon never ready (`never-ready` entry, 3 s timeout) → `DAEMON_START_TIMEOUT`, the spawned PID is gone |
| 9 | hanging close (`hang-close` entry): stop without `--force` → `DAEMON_STOP_TIMEOUT` + hint; `--force` → process gone well before the daemon's own 7 s exit |
| 10 | `--force` with a lock file whose start time differs → `DAEMON_FORCE_REFUSED`, nothing killed |
| 11 | spawn plan: `NODE_OPTIONS` dropped in any case, stdio `["ignore","ignore",fd]` (no pipe), detached, hidden, cwd = home, args = `--log-file <logs>/daemon.log`, no `shell`; real child (`report` entry): no `NODE_OPTIONS`, empty `execArgv`, cwd = home |
| 12 | covered by 3 (status from a new CLI process after the starting CLI exited) |
| 13–14 | CR-003 |
| 15 | `tailLogs` across `.1` + current, CRLF; follow: new lines, a line split across polls, rotation (rest of `.1` first), truncation, a UTF-8 character split across writes |
| 16 | `sanitize`: ESC/OSC/BEL, 8-bit CSI, CR/LF, DEL, NUL, U+2028/2029, bidi → `?`; tab, Thai, emoji kept; error lines and echoed sub-command sanitised |
| 17 | `ensureDaemon`: `noStart` → exit 3, nothing started; auto-start → proven client |
| 18 | `--json` error = one JSON line on stderr with `code` |
| 19 | Node 22.12 run above |
| — | daemon exits 2 at start (`fail-2` entry) → CLI exit 2 with the daemon's message and details, temp stderr file removed |
| — | relative `WEBHUB_HOME` → exit 2 with the hint |

## Not run
- Linux and macOS.
- A real Ctrl+C on a terminal (SIGINT handling of `logs -f`).
