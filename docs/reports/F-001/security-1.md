# Security review — F-001 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 2e3d5db (`git diff develop...HEAD`) |
| Reviewer | fresh security reviewer agent; experiments compiled in scratchpad |
| Attacker model | local single-user dev machine + other non-admin local user; same-user malware out of scope (spec §6) |

## Verified OK
Junction/symlink refusal (lstat sees junctions), DPAPI round-trip with secret only on stdin, no secret in errors/inspect, no shell + absolute System32 paths, integer PID before PowerShell, 5 MB limit both ways, config path traversal / home-in-scan-root / drive-root rejected.

## Findings
| ID | Severity | Location | Issue | Attack scenario | Fix |
|---|---|---|---|---|---|
| S1 | major | src/store/lock.ts:99-104, 34-39 | Stale-lock takeover read→rm→wx not atomic; release read→rm not atomic | Reproduced: stale lock + 4 concurrent processes → 2–4 `ACQUIRED` (4/4 trials). Crash/reboot + autostart + CLI → two writers, data corruption | Atomic rename of stale lock + token re-check; verify token before writes; multi-process race test |
| S2 | major | src/config/home.ts:113-131 | No owner check of existing home / parent | Other local user pre-creates `C:\webhub-dev` (Authenticated Users can create in `C:\`), keeps WRITE_DAC as owner, re-opens ACL after webhub restricts it → tamper config, plant junction in `data\` → writes outside home (R0) | Refuse home not owned by current user (POSIX uid); refuse untrusted parent or document |
| S3 | major | src/config/home.ts:135-148 | ACL/chmod applied only to home dir, not children | Reproduced: pre-existing `home\data` with `Everyone:(OI)(CI)F` keeps it after `ensureHome` → `secrets.json`/`auth.json`/lock readable+writable by others | Reset child ACLs to inherited (`/reset /T`); POSIX chmod children; test |
| S4 | minor | src/store/lock.ts:43-50, 76-81 | Inaccessible process reported dead | Elevated webhub holds lock; non-elevated instance takes over | Tri-state; unknown = locked |
| S5 | minor | src/store/json-store.ts:107 | `JSON_PARSE` message includes V8 snippet of file content | Typo next to credential in `defaultEnv` → credential fragment in error/log/doctor | Report line/column only |
| S6 | minor | src/proc/exec.ts:50 | Fallback `C:Windows` drive-relative | `SystemRoot` missing + cwd = cloned repo on C: → repo's `Windows\System32\…powershell.exe` runs | `C:\\Windows` or refuse invalid `SystemRoot` |
| S7 | minor | src/config/config.ts:30-36, 56-60 | Lexical path checks only; `runtimes.dir` may equal home; junction/8.3 scan root not detected | Future "clean runtimes" on `.` wipes home; scanner walks into home via junction | Strictly inside home; realpath compare |
| S8 | nit | src/store/secrets.ts; json-store.ts | Deleted secret remains in `.bak` / migration backups | Same-user recovery of "deleted" secret | No `.bak` for secrets or overwrite |
| S9 | nit | src/store/secrets.ts:50-52 | DPAPI error detail always `#< CLIXML` | diagnostics only | parse CLIXML / fixed codes |

Out of scope: TOCTOU between `assertSafePath` and file ops (needs write access inside home = same user unless S2/S3); `readInfo` without size limit (same).

## Result
critical 0 · major 3 · minor 4 · nit 2 → not ready; fix S1–S3 (S1 = review R1; S4 overlaps review R2).
