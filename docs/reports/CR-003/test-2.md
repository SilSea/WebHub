# Test report — CR-003 — round 2

| | |
|---|---|
| Date | 2026-11-13 |
| Commit | `473ab45` — fixes for review-1 and security-1 |
| User decision | "แก้ทั้งหมด" (Z1 + every minor / nit / info) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (CR-003 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 298 | 0 | 6 |
| `log-file` (unit) + `daemon` (integration), Node 22.12 | 64 | 0 | 1 |

The extra skip is "file symlink planted after start-up": creating a file symlink needs Developer Mode / admin on this machine. Lint, typecheck, build and `pnpm audit` (high) pass.

## Changes and tests per finding
| Finding | Change | Test |
|---|---|---|
| Z1 (major) | `openLogFile` takes a `writeSync` hook (tests) | Write throws ENOSPC → no throw, line dropped, no re-open at 500 ms, re-open at 1 000 ms |
| Z2 | `main()`: home errors go through `describe` + `exitCodeFor`, outside the argument catch | Integration: relative `WEBHUB_HOME` with and without the flag → same exit code and same stderr |
| Z3, Z5, AA3 | File must be directly in `logs/`; name `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, no trailing dot, no device name; `logs/` re-checked before every open | Sub-directory → `PATH_OUTSIDE_HOME`; `CON`, `nul.txt`, `COM1.log`, `lpt9`, trailing `.`/space, `:`, leading `-`/`.`, 65 chars → `HOME_INVALID`; `logs/` as a junction (at start and swapped in later) → refused / nothing written outside |
| Z4 | Test replaced | File symlink planted later (skipped here — no privilege); hardlink planted later → target unchanged |
| AA1 | `nlink === 1` before open and on the handle (`fstat`) | Hardlink to a secret file → refused at start; planted later → secret unchanged |
| AA2 | POSIX: `O_WRONLY \| O_APPEND \| O_CREAT \| O_NOFOLLOW \| O_NONBLOCK`; `fstat` regular file | Not run (Linux / macOS) |
| Z6 | Monotonic clock (`performance.now()`); negative elapsed = retry now | Clock stepping back after a failure → next line kept |
| Z7, AA4 | Short write = failure; the next line starts on a new line | Short write of 5 bytes → the cut piece stays on its own line, the next line parses |
| Z8, AA5–AA7, Z13 | CR-003 §1 / §6 rewritten (1 s retry, truncate fallback, pre-existing oversized file, two writers at restart); F-003 spec §3, §6 (2 rows), §8 row 28 | — |
| Z9 | — | Cap constant = 5 MB; a line ending exactly at the cap does not rotate, one more line does; an oversized line on an empty file keeps `.1` |
| Z10 | `REOPEN_AFTER_MS` exported | 999 ms → dropped, 1 000 ms → re-opened |
| Z11 | `parseArgs({ tokens: true })`, count option tokens | Mixed `--log-file a --log-file=a` refused; `--`, `--LOG-FILE`, `-- --log-file=a` covered |

**Found while testing:** on Windows a handle opened for append (`"a"`) cannot be truncated, so the truncate fallback failed and logging stopped for 1 s after every rotation attempt (the "`.1` is a directory" test caught it). Fix: truncate through a second read-write handle, checked to be the same file (`dev` + `ino`, one link).

## Not run
- Linux and macOS (`O_NOFOLLOW`, FIFO).
