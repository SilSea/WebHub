# Test report — CR-003 — round 1

| | |
|---|---|
| Date | 2026-11-13 |
| Commit | (uncommitted on `fix/CR-003-daemon-log-file`, base `691e686`) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (CR-003 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite (unit + integration), Node 24.20 | 274 | 0 | 5 |
| `log-file` (unit) + `daemon` (integration), Node 22.12 | 40 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## Tests added
| CR §6 row | Test |
|---|---|
| 1 | Existing F-003 suites unchanged and passing (no flag = stdout) |
| 2 | `--log-file` → "ready", the request line and "stopped" are in the file; stdout and stderr are empty |
| 3 | 500 lines with a 4 KB cap → `daemon.log` ≤ cap, `.1` ≤ cap, line numbers contiguous across both files; an existing file's size is counted on open; `.1` is a directory → truncate, cap holds |
| 4 | `logs/` itself, outside home, another home dir, `..` escape → `PATH_OUTSIDE_HOME`; directory → `HOME_INVALID`; junction on the way → `SYMLINK_REFUSED`; integration: outside `logs/` → exit 2, no lock, no auth.json, nothing written |
| 5 | `parseDaemonArgs`: missing value, empty value, given twice (both forms), unknown flag, positional → refused; integration: exit 2 before lock / auth.json |
| 6 | Only a failed **open** is covered (line dropped, retry after 1 s). A failed **write** is not — review-1 Z1 |
| 7 | Unit level only (rotation); security-1 ran a 40 000-request flood against the real daemon (max 6.1 MB total) |
| 8 | Node 22.12 run above |

## Not run
- Linux and macOS (`O_NOFOLLOW`, FIFO — security-1 AA2).
