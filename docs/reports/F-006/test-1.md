# Test report — F-006 — round 1

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `2fb0673` (`feat/F-006-scanner`) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-006 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. During the runs the machine had heavy external CPU load: a game, two Unreal Editor instances, Discord and Edge (load 40–77 %). |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| `scanner` (unit) | 17 | 0 | 0 |
| `scanner-fixtures` (unit) | 14 | 0 | 0 |
| `scan` (integration: API + CLI) | 4 | 0 | 0 |
| F-006 suites on Node 22.12 | 35 | 0 | 0 |
| Full suite, run 3 (branch) | 479 | 9 (pre-existing, timing — below) | 6 |
| Full suite, `develop` `d6023c2`, same load (worktree) | 449 | 4 (same tests) | 6 |

Lint, typecheck and build pass.

## Failures not caused by F-006
The 9 failures in the branch's full run are existing tests that hit time limits (F-001 lock, F-002 tasks, F-003 flood/daemon, F-004 stop, F-005 >200 files). `develop` without F-006, run at the same time under the same external load, failed 4 of the same tests:
- "more than 200 files"
- "our daemon stopping (503)"
- "second process gets LOCKED"
- "4 processes taking over the same stale lock"

Every F-006 test passed in every run. The F-006 tests got explicit timeouts (30–60 s; lock hook 60 s), following the CR-004 lesson.

## Coverage of spec §8
| # | Case | Test |
|---|---|---|
| 1 | 7 existing fixtures → profile / runner / port / publicDir; Zero-touch hash before = after | `scanner-fixtures` "single-project fixtures" |
| 2 | monorepo, compose build, compose hybrid (anchors), duplicate, not-web ×4, `.env` | `scanner-fixtures` "multi-folder fixtures" |
| 3 | junction outside root → `skipped: link`, target content never in the result; folder outside root → `changed` | `scanner` "listDir", "scan: links …" |
| 4 | limits: depth (config `maxDepth`), `ignore`, entries per folder, folders, bytes, time (fake clock), abort | `scanner` "budget", "scan: …" |
| 5 | alias bomb / forbidden key / broken compose; odd names (control, C1, bidi, lone surrogate, reserved); ReDoS input for the vite regex | `scanner` "compose", "names", "hints" |
| 6 | `.env` with secrets → only the port number in the result | `scanner-fixtures` ".env" |
| 7 | API 401 (GET / POST / DELETE), 202, 409 + scanId, progress, cancel → nothing saved, close aborts a hung scan < 5 s | `scan` "/api/v1/scan" |
| 8 | CLI `scan`, `--json`, `--last`, missing root, bad option | `scan` "webhub scan" |
| 9 | deps parsers: package.json shapes, requirements, pyproject (PEP 621 + poetry), caps | `scanner` "deps" |
| 10 | port parsers: script flags, vite literal / non-literal, EXPOSE, compose forms | `scanner` "hints", "compose" |
| 11 | Node 22.12 | above |

## Found and fixed while testing
- A scan cancelled while it waited for the config never ended, so DELETE and daemon close hung. The test found it. Fixed: the wait is now abortable.
- The slug kept combining marks as separators (`ü` → `u-`). Fixed: marks are removed after NFKD.

## Not covered on this machine
- A folder name with ESC / C1 characters cannot be created on Windows (NTFS refuses 0x01–0x1F). That test returns early here and needs Linux CI. The `badName` unit test covers the check itself.
