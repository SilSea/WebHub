# Code review — CR-003 — round 1

| | |
|---|---|
| Date | 2026-11-13 |
| Scope | uncommitted diff on `fix/CR-003-daemon-log-file` (`src/daemon.ts` `main()` + `parseDaemonArgs`, new `src/server/log-file.ts`, tests) |
| Reviewer | separate agent (read-only); typecheck, lint, unit test run |
| Verdict | **FAIL** — 1 major (Z1), 0 critical |

Scope is clean: only allowed files changed; without the flag `startDaemon` gets no `log` and falls back to stdout (old behaviour). Extra arguments now exit 2 (intended by the CR).

## Findings
| ID | Severity | Where | Problem | Fix |
|---|---|---|---|---|
| Z1 | major | `test/unit/log-file.test.ts` | CR §6 row 6 missing: no test makes `writeSync` fail after a successful open. Removing the try/catch around `writeSync` survives all tests — the core "write errors never throw" guarantee is unverified | Inject / mock `writeSync` to throw; assert no throw, line dropped, re-open after 1 s |
| Z2 | minor | `src/daemon.ts` `main()` | Invalid `WEBHUB_HOME` → exit 2 and no hint with the flag, exit 1 + hint without. F-004 always passes the flag | Resolve home outside the argument catch; same `describe` + `exitCodeFor` path |
| Z3 | minor | `log-file.ts` `open()` | Re-check before open covers only the leaf; a parent dir under `logs/` swapped for a junction later → writes outside home (needs write access to home) | Require the file to be a direct child of `logs/`, or re-check every component |
| Z4 | minor | `log-file.test.ts` "junction planted after start-up" | Cannot fail: a junction to a directory fails `openSync` anyway; removing the re-check survives | Plant a file symlink (skip without Developer Mode) or a parent junction |
| Z5 | minor | `resolveLogFile` | `logs/sub/x.log` with a missing `sub` passes; every open fails silently → no log at all, no signal | Direct child of `logs/` only (with Z3), or one stderr line on first open failure |
| Z6 | minor | `log-file.ts` | Retry gate uses wall clock; clock stepping back → no re-open for hours | Monotonic `performance.now()` or treat negative elapsed as "retry now" |
| Z7 | minor | `write()` | `writeSync` return ignored; short write → split line, next line glued on | Treat a short write as failure (close + `failedAt`) |
| Z8 | minor | CR-003 §1 vs code | CR says retry "at the next rotate", code re-opens after 1 s; CR §9 doc checklist not done yet | Align CR text; finish docs before merge |
| Z9 | nit | `write()` rotation condition | Mutations survive: `>` → `>=`; dropping `size > 0 &&` (oversize line on empty file renames an empty file over `.1`); `LOG_FILE_MAX_BYTES` value untested | Boundary test, oversize-line test, constant test |
| Z10 | nit | retry test | `<` → `<=` survives (test jumps 500 → 1 500 ms) | Assert at 999 and 1 000 |
| Z11 | nit | `parseDaemonArgs` | Duplicate check re-scans raw argv separately from `parseArgs` | `parseArgs({ tokens: true })` and count option tokens |
| Z12 | info | `parseArgs` edge cases | `--`, `--log-file -x`, `--LOG-FILE`, `" "` all handled correctly | — |
| Z13 | info | Windows rename | Reader without delete sharing → truncate instead of rotate (history lost, cap holds); libuv readers share delete | Document |
