# Code + security review — F-004 — round 2

| | |
|---|---|
| Date | 2026-11-14 |
| Scope | `git diff d8ca148 933f1f9` (fixes for review-1 / security-1) |
| Reviewer | separate agent; ran unit 35/35, integration 13/13, live runs against `dist/` from HEAD in the session scratchpad `f004-review2/` |
| Verdict | **FAIL** — 0 critical, 1 major (E1), 3 minor (E2–E4), 3 nit (E5–E7), 1 info (E8) |

## Findings
| ID | Severity | Where | Problem / scenario | Evidence | Fix |
|---|---|---|---|---|---|
| E1 | major | `stopDaemon` (connect before shutdown, first status) | C1 partly open: `connectDaemon` → F-001 `readDoc` does `lstat` then `readFile`; the daemon removes auth.json in between → raw `ENOENT` → "internal error (Error)", exit 1. Also: hello passes, then the daemon starts closing → `POST /shutdown` gets 503 `SHUTTING_DOWN` → `API_ERROR` rethrown | **Ran**: 40 staggered in-process `stopDaemon` × 8 rounds → 0–11 `ENOENT` failures per round. CLI-level parallel stops all exit 0 (narrow window → integration test can flake) | `ENOENT` on auth.json → `DAEMON_NOT_RUNNING` (wrapper for status / stop / start poll); `API_ERROR` 503 `SHUTTING_DOWN` → wait loop; unit tests |
| E2 | minor | `transientAsUndefined` | Regression of the C8 fix: daemon exits 4 on a busy port and removes auth.json; the poll hits the same `ENOENT` window → thrown → child killed, "internal error", exit 1 instead of 4 | reasoned (15 live port-busy starts all exit 4) | Same mapping as E1 |
| E3 | minor | `stopDaemon` "gone" branch; `status`; `ensureDaemon` | A losing concurrent `stop` returns in 7–18 ms while the process is still exiting (winner ~700 ms) → an immediate `start` can get child exit 3 and a 20 s timeout. `status` / `ensureDaemon` still call a closing daemon (503) "another program" | ran (timings) + reasoned | auth.json gone but lock names a live PID with its start time → wait on it; `ownerOfAuth` before blaming another program in status / ensureDaemon |
| E4 | minor (tests) | `test/unit/cli-stop.test.ts`, `cli-daemon.test.ts` | Surviving mutations: (a) `procState` info error → "dead"; (b) "new daemon started meanwhile" branch → return; (c) `readLastLines` `newlines <= n` → `< n` (100-byte lines always over-read); (d) force path without `lock.pid !== pid`; (e) `ownerOfAuth` start-time compare → `true` (`startedAt` undefined) | reasoned | One test each with the fake Platform; long lines (~CHUNK / n) for (c) |
| E5 | nit | `removeAuthOf` | Read-then-delete keyed on PID only; a new auth.json written in between / PID reuse loses its file (availability) | reasoned | Compare token / startedAt of the first read |
| E6 | nit | logs / signals | Follow drops the unterminated last line of the old file at rotation; tail cut by the 8 MB cap joins `.1` with a gap (only with a pre-existing > 8 MB file); non-EPIPE stdout errors swallowed → `logs -f` polls with a dead stdout; Ctrl+C on a start whose child lost the lock replaces the winner's `daemon.err` | reasoned | Small fixes |
| E7 | nit | spec §8 row 3 | Still says "pid = auth.pid" | read | Align |
| E8 | info (security) | — | No kill of an unproven process; no token to an unproven server (**ran** `NODE_DEBUG=http,net,http2,tls,stream` on the CLI: token / "authorization" 0 times in output); D1 fixed (**ran** `NODE_DEBUG=http,net,fs,tls` + `node_debug_native`, 300 requests → `daemon.err` 0 B, `daemon.log` 25 KB); not byte-capping `daemon.err` is sound — runtime deps (fastify 5.12.7, pino, avvio 9.3.1, process-warning) read no `DEBUG` / `NODE_DEBUG`; revisit if a dependency adds the `debug` package (`DEBUG` is not on the denylist) | ran + reasoned | — |

## Round-1 status
| ID | Status | Note |
|---|---|---|
| C1 | partly | E1 |
| C2 | fixed | gaps E4 |
| C3, C4, C5, C6, C9, C11, C12 | fixed | C11 / C9 leftovers in E6 |
| C7 | fixed in code | untested in the wait loop (E4a) |
| C8 | fixed, with regression | E2 |
| C10 | mostly | E7 |
| D1, D2, D3, D4, D5 | fixed | D1 ran: `daemon.err` 0 B |
| D6 | holds | — |
| D7 | unchanged | accepted as info |
