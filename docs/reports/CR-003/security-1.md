# Security review — CR-003 — round 1

| | |
|---|---|
| Date | 2026-11-13 |
| Scope | `--log-file` (`src/daemon.ts` `main()`, `src/server/log-file.ts`) against the F-003 §6 threat model |
| Reviewer | separate agent; spikes in the session scratchpad `cr003-security/` (`paths.mjs`, `flood.mjs`, `lock.mjs`, `audit.mjs`) against `dist/` |
| Verdict | **PASS** — 0 critical, 0 major; 3 minor (AA1–AA3), 4 info (AA4–AA7) |

## Verified (ran)
- Path escapes refused (`PATH_OUTSIDE_HOME`): `..`, forward slashes, `\\?\` and `\\.\` prefixes, 8.3 name `..\DATA\AUTH~1.JSO`, `logs:stream`, `logs::$INDEX_ALLOCATION\…`; nothing outside home was written.
- Symlinks and junctions refused at start and on every re-open; `.1` is replaced by rename, never followed.
- Cap under the flood residual: real daemon, 40 000 requests in 27 s (one third with 4 KB paths containing encoded U+2028, NUL, `\n`, `"`, `\`) → max `daemon.log` + `.1` = 6.1 MB; every line valid JSON, longest 287 B; the daemon kept answering; stdout 0 B, stderr empty.
- The token was never in the log files; argument errors show only the user's own path.
- `logs/`, `daemon.log` and `.1` inherit SYSTEM + current user only (`icacls`).
- File held by another process (share None / Read / ReadWrite): open fails with EBUSY → line dropped, retry after 1 s; rename fails → truncate, cap holds; logging resumes after release. No buffering → memory bounded.

## Findings
| ID | Severity | Where | Scenario | Fix |
|---|---|---|---|---|
| AA1 | minor | `open()` | A hardlink in `logs/` to another file of the user (e.g. `data/auth.json`) → the daemon appends to it; the truncate fallback can empty it. **Ran**: `auth.json` became `SECRET{"t":…}`. Needs write access to the user-only `logs/` (same user) → defence in depth | After open, `fstat` must show a regular file with `nlink === 1`; check in `resolveLogFile` too |
| AA2 | minor (latent, POSIX) | `open()` | Check-then-open race: a FIFO swapped in → `openSync` blocks the event loop forever; a symlink would be followed. Same user only (home 0700). Reasoned, not run | POSIX: open with `O_WRONLY \| O_APPEND \| O_CREAT \| O_NOFOLLOW \| O_NONBLOCK`, then `fstat` regular + `nlink === 1` |
| AA3 | minor | `resolveLogFile` | Windows-odd names created literally (`\\?\` skips normalisation): `CON`, `NUL`, `COM1`, `CONOUT$`, trailing `.` or space, `daemon.log:evil`, `::$DATA`. Not an escape; Explorer / PowerShell handle them badly. Side note: the F-001 audit may skip such entries silently | Whitelist the basename (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, no trailing `.`, no reserved names) or accept only `daemon.log`; follow-up for the F-001 audit |
| AA4 | info | `write()` | Short write → split line, size off (= review Z7) | Treat a short write as failure |
| AA5 | info | cap | A pre-existing oversized `daemon.log` moves to `.1` as is; a line > cap exceeds it (lines < 512 B); the old daemon logs "stopped" after releasing the lock → two writers briefly (still bounded) | Document; optionally truncate an oversized `.1` at start |
| AA6 | info | docs | CR retry wording vs the 1 s re-open (= review Z8) | Align CR / F-003 spec |
| AA7 | info | Windows rename | AV / indexer / reader without delete sharing → truncate, recent lines lost | Document |
