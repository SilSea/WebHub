# Code review — F-004 — round 1

| | |
|---|---|
| Date | 2026-11-13 |
| Scope | commit `d8ca148` (`src/cli.ts`, `src/cli/*`, tests, fixture) |
| Reviewer | separate agent (read-only; ran `dist/cli.js` against temp homes) |
| Verdict | **FAIL** — 0 critical, 2 major (C1, C2), 8 minor, 2 nit, 1 info |

## Findings
| ID | Severity | Where | Problem / scenario | Fix |
|---|---|---|---|---|
| C1 | major | `daemon-control.ts` `stopDaemon` | Not idempotent while a stop is in progress. **Ran**: 4 concurrent `stop` on a real daemon → 1 × exit 0, 3 × exit 1 "could not talk to the webhub daemon – ECONNRESET", then `status` = not running. Reasoned: the daemon starts closing between status and `POST /shutdown` → hello gets 503 → IMPOSTOR, not caught → reported as "another program on the port". Spec §3.1 / §3.4 say exit 0 and wait | When `ownDaemonAlive` is false: auth.json gone or PID dead → "stopped"; IMPOSTOR / UNREACHABLE on the shutdown request → wait loop; test with concurrent stops |
| C2 | major (test strength, R6) | `test/integration/cli.test.ts` | "--force with a lock file of another PID" accepts success and never checks the daemon is alive; impostor test checks only exit 1. Surviving mutations: force path kills with the process's real start time; `ownDaemonAlive` → `true`; `alive()` without the start-time check. Spec §8 #10 (unit test, mock platform) missing; test-1 row 10 overclaims | Unit tests with a fake `Platform`; assert `DAEMON_FORCE_REFUSED` + daemon still alive; impostor asserts message + fast return |
| C3 | minor | `readStartError` + `errorLines` | Daemon detail / hint lines keep their `  - ` / `  hint:` prefix → printed as `  -   - PID …`, `  -   hint: …` (**ran**, busy port). `fail-2` fixture prints a format the daemon never produces | Strip `- ` prefix, map `hint:` to the hint; fixture prints exactly what `describe()` prints |
| C4 | minor | start timeout | `process.info` failed right after spawn → `startedAt` undefined → no kill, half-started daemon left; temp stderr deleted unseen on timeout | Retry `info`, kill only a child of this CLI; put start-error lines into the timeout error |
| C5 | minor | `--force` | Every `killTree` failure reported as "not the daemon that holds the lock" (also access denied / tool failure) | Switch on `PlatformError.code` |
| C6 | minor | `--force` | `rmSync(auth.json)` without checking it still names the killed PID → a daemon started at that moment loses its auth.json | Remove only if auth.json names the killed PID (= security D3) |
| C7 | minor | `alive` / `ownDaemonAlive` | `process.info` error = "dead" / "not ours"; a hard-killed daemon leaves auth.json → stop waits 10 s then "did not stop" although the process is gone | Info error = unknown; dead PID → stopped, remove its stale auth.json |
| C8 | minor | start polling | `daemonStatus().catch(() => undefined)` swallows every error (HOME / ACL / config) → 20 s wait, kill, generic timeout; exit-3 path loses the daemon's "already running" line | Swallow only NOT_RUNNING / IMPOSTOR / UNREACHABLE; include start-error lines |
| C9 | minor | `daemon-logs.ts` | `readSync` errors (EBUSY / EPERM from antivirus) end `logs -f` with "internal error"; `tailLogs` reads whole files (a pre-existing oversized `.1` can be huge) | Catch per poll; tail by reading the last bytes only |
| C10 | minor | docs | PLAN / features README still `planned`; spec §9 empty, §10 unticked; §3.3 still names `daemon-start.err` and `auth.pid`; test-1 row 10 overclaims | Align |
| C11 | nit | `cli.ts` SIGINT | Ctrl+C during start exits without `finally` → temp stderr file stays; after 1 h the next start deletes it while a daemon may still write to it | Sync cleanup in the handler, or skip files of a live CLI PID |
| C12 | nit | output | JSON error message keeps `webhub: ` and drops details / hint; `--json daemon` prints text usage; uptime can be `NaN`; `logs -f \| head` → EPIPE stack; `run()` without `.catch`; `--version --bogus` now exits 1 (was 0) — undocumented | Small fixes + document |
| C13 | info | Windows | Checked fine: detached + hidden, cwd, FILE_SHARE_DELETE rename of the open err file, ino for rotation, `wx`, readiness on proven `status.pid`, every loop bounded | — |
