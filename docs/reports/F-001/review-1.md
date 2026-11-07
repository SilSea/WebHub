# Code review — F-001 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 2e3d5db (`git diff develop...HEAD`) |
| Reviewer | fresh reviewer agent (no prior context); findings reproduced with scripts against `dist/` |

## Findings
| ID | Severity | Location | Problem | Failure scenario | Fix |
|---|---|---|---|---|---|
| R1 | major | src/store/lock.ts:93-112 | Stale-lock takeover not atomic: read → slow `isStale` → `rm` without re-check; a just-created empty lock reads as stale | Reproduced: 2 concurrent `acquireLock` on a stale lock → 2 holders (1/5 runs). Crash + autostart daemon + manual start → two writers | Rename stale lock atomically and verify token; write lock content via temp + `link()`; treat young empty lock as live; concurrency test |
| R2 | major | src/store/lock.ts:45-51, 76-81 | `processStartTime` returns `undefined` for live-but-inaccessible processes or PowerShell failure → treated as dead | Reproduced: PID 4 / lsass → `undefined`. Elevated daemon + non-elevated second instance → live lock taken over | Tri-state alive/dead/unknown; unknown = still locked |
| R3 | major | src/store/secrets.ts:130-150 | Lost update on concurrent `set`/`delete` | Reproduced: two parallel `set` → file keeps only one key; memory says 2 → secret lost after restart | Serialize mutations |
| R4 | major | src/proc/exec.ts:21-39 | No `error` listener on `child.stdin` → EOF/EPIPE becomes uncaught exception | Reproduced: child exits before reading 70 KB / 300 KB input → process crash instead of `SECRET_BACKEND` | Handle stdin errors; rely on exit code |
| R5 | minor | src/proc/exec.ts:50 | Fallback `C:Windows` is drive-relative | `SystemRoot` unset → tools resolved relative to C: cwd | `C:\\Windows`, accept `windir` |
| R6 | minor | src/store/json-store.ts:103-111 | UTF-8 BOM not stripped; no line number in parse error | PS 5.1 `Set-Content -Encoding utf8` adds BOM → webhub refuses to start with unreadable message | Strip BOM; compute line/col |
| R7 | minor | src/store/secrets.ts:50-52 | DPAPI error detail is always `#< CLIXML` | No usable reason for user/doctor | try/catch in script, emit message with marker |
| R8 | minor | src/store/json-store.ts:81-84 | Config errors omit received value (spec §3.4) | `maxDepth: Too big…` without `99` | Append received value (not for secrets) |
| R9 | minor | src/fs/safe-path.ts:8 | `startsWith("..")` rejects names like `..cache` | `data/..cache` → PATH_OUTSIDE_HOME | compare `..` / `..` + sep |
| R10 | minor | src/config/config.ts:63 | All `stat` errors become "does not exist yet" | EACCES scan root reported as harmless warning | warning only on ENOENT |
| R11 | minor | tests | Gaps: leftover tmp, concurrency (R1–R3), unknown PID, secret not in error; integration lock test uses `dist/` | R1–R4 pass the suite | Add tests |
| R12 | nit | src/store/secrets.ts | `get` validates key, `has` does not | inconsistent API | validate both |
| R13 | nit | test/unit/home-fs.test.ts | ACL test runs `icacls` via PATH | contradicts §3.7 | use `systemExe` |

Verified OK: errors.ts, resolveHome/pathsFor, migrations + newer-version refusal, atomic write/.bak/rename retry, schema defaults/strictness, checkConfig overlap (case-insensitive on Windows).

## Result
critical 0 · major 4 · minor 7 · nit 2 → not ready; fix R1–R4 (+ tests), round 2.
