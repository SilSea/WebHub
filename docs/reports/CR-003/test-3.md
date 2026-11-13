# Test report — CR-003 — round 3

| | |
|---|---|
| Date | 2026-11-13 |
| Commit | (this commit) — fixes for review-2 B1–B7 |
| User decision | "แก้ทั้งหมดแล้ว merge" (no review round 3) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (CR-003 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 300 | 0 | 6 |
| `log-file` (unit) + `daemon` (integration), Node 22.12 | 66 | 0 | 1 |

Lint, typecheck, build and `pnpm audit` (high) pass. The skip is the file-symlink test (no symlink privilege on this machine).

## Changes and tests per finding
| Finding | Change | Test |
|---|---|---|
| B1 (minor) | `cut` changes only after a write attempt whose result is known; a throwing write keeps it | Short write → failing write → good write: the cut piece stays on its own line, the next line parses |
| B2 (nit) | The cap check counts the newline prefix after a cut | 120 rounds of normal + short writes with a 300 B cap: the file never exceeds 300 B |
| B3 (nit) | — | Rename-fail test also asserts that more than one line is kept and that they are contiguous. Mutation M10 (`size = st.size` after a truncate) still survives: the next open re-reads the size, so it only over-counts by one line — equivalent in effect |
| B4 (info, security) | After every open: `logs/` must be the same directory (dev + ino) and the path must name the same file as the handle, not a link; otherwise the handle is closed and nothing is written | Existing link tests still pass; the race itself was not reproduced (timing) |
| B5, B7 (info) | CR-003 §1: exact directory comparison (fails safe), exit 2 for any `--log-file` check error | — |

**Found while testing:** on Node 22.12 for Windows, `lstat` returns `dev = 0` while `fstat` returns the real value (Node 24 returns it from both). The first version of the B4 check compared `dev` and refused every open on Node 22, so 12 tests failed. `dev` is now compared only when both sides are non-zero; `ino` (the NTFS file id) is always compared.

## Not run
- Linux and macOS (`O_NOFOLLOW`, FIFO).
