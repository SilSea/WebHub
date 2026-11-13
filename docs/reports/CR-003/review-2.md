# Code review + security review — CR-003 — round 2

| | |
|---|---|
| Date | 2026-11-13 |
| Scope | commit `473ab45` (base `691e686`): `src/daemon.ts` `main()` / `parseDaemonArgs`, `src/server/log-file.ts`, tests |
| Reviewer | separate agent (read-only; mutation runs on a scratch copy) |
| Verdict | **Code review PASS** — 0 critical/major; 1 minor (B1), 2 nit (B2, B3), info B5–B7. **Security PASS** — 0 critical/major; info B4. |

## Round-1 findings
| ID | Status |
|---|---|
| Z1, Z2, Z3, Z5, Z6, Z9, Z10, Z11, AA1, AA3, AA4, AA6 | fixed (tests present; mutations killed where applicable) |
| Z4 | fixed in effect: file-symlink test skips without Developer Mode, but "logs/ swapped for a junction" kills the re-check mutation |
| Z7 | fixed with a residual → B1 |
| Z8 | CR text fixed; CR §9 doc checklist (DESIGN §12, PLAN, features/README, reports/README) still to do before merge |
| AA2 | fixed on POSIX (`O_NOFOLLOW \| O_NONBLOCK` + `fstat`); directory-level race → B4 |
| Z12, Z13, AA5, AA7 | documented / nothing to fix |

Name check ran: `CONIN$`, `CONOUT$`, `CLOCK$`, `COM¹`, `AUX.log`, `Con.tar.gz`, `lpt0`, `"COM1 "`, `nul.`, `:` → refused.

## New findings
| ID | Severity | Where | Scenario | Fix |
|---|---|---|---|---|
| B1 | minor | `write()` | `cut = false` runs before the write. Short write → after 1 s the re-opened write of `"\n"+line` throws → `cut` already false → next line glued to the cut piece. **Ran**: file had `{"t":{"t":"…","msg":"two"}` | Clear `cut` only after a full write (`cut = n !== buf.length`), keep it in the catch |
| B2 | nit | `write()` rotate check | Check uses `byteLength(line)` but writes `"\n"+line` after a cut → file 1 byte over `maxBytes` (**ran**: 135 vs 134) | Build `buf` first, test `size + buf.length` |
| B3 | nit | rename-fail test | Mutation M10 survives (after truncate `size` keeps the old value → every write rotates, only last line kept) | Assert more than one line remains |
| B4 | info (security) | `open()` | Remaining check-then-open races, same user + write access to `logs/` + exact timing: Windows `"a"` follows a symlink swapped in after `lstat` (needs symlink privilege); `logs/` swapped for a junction between check and open → `O_CREAT` outside home. Reasoned | Optional: compare handle `fstat` dev/ino with pre-open `lstat` (file and dir) |
| B5 | info | `resolveLogFile` | `dirname(abs) !== resolve(paths.logs)` is case/form-sensitive (`c:\` vs `C:\`, `LOGS`, `\\?\`, 8.3) → refused with exit 2 (fails safe; F-004 builds the path from `paths.logs`) | Document |
| B6 | info | `truncateChecked` | Verified on NTFS: bigint `ino`/`dev` equal for both handles of one file; `ftruncate` on the append handle → EPERM (second handle needed); if the check throws, nothing is written and the cap holds | — |
| B7 | info | `main()` | Any `resolveLogFile` error (also EACCES from `lstat`) exits 2; `HOME_INVALID` for a bad file name exits 2 while a bad home exits 1 | Document |

Surviving mutants other than M10 are equivalent or race-only (dev/ino check, post-open `fstat`, `size += buf.length`, `failedAt` reset, prefix on an empty file, rotate-always-truncate, `assertSafePath` on `.1`).
