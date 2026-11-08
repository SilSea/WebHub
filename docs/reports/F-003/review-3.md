# Code review — F-003 — round 3

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | d00c28e |
| Reviewer | fresh agent; build / typecheck / lint / 46 F-003 tests pass; probes: real socket vs `createApi`, in-process `startDaemon` + client restart, child process running `main()` with injected crashes, parser errors in the current request |

## Findings
| ID | Sev | Location | Problem | Scenario | Suggested fix |
|---|---|---|---|---|---|
| M1 | minor (verified) | api.ts `clientError` (L5 change) | destroys the socket whenever `_httpMessage` is set — includes the not-yet-started response of the **current** request → parse errors in its own body and `requestTimeout` get a silent close instead of uniform 400 / 408 | chunked body `zz` → closed after 12 ms, no status; CL 10 with 3 bytes → closed at 30.3 s, no 408 | destroy only when a *previous* response is pending (`_headerSent` / `msg.req !== parser.incoming`); tests: bad chunk → 400, slow body → 408 |
| M2 | minor (verified, API level) | auth.ts `readCookies` / comment; spec §3.3, §6; test name | "tossing cannot log out" is false: > 8 values → all dropped → 401; same name / host / path can be overwritten from any port → 401. Logout DoS only (key still needed) | dev server on Q forces `hub.localhost:Q`, sets `webhub_session=x; Path=/` → dashboard logged out | fix spec / comment / test: logout DoS = residual until `__Host-` / HTTPS; optionally keep first 8 |
| M3 | minor (verified) | daemon.ts `stopFn` | `await running.close()` unbounded: a hanging `preClose` / `onClose` hook → `stopped` never resolves, auth.json + lock stay, process hangs; more signals reuse the same promise. Spec §3.1 "รอ ≤ 5 วิ" | hanging onClose → still waiting after 9 s | race close vs grace + margin → `clean=false`, clean up anyway; second signal → sync cleanup + exit 1 |
| M4 | minor (verified) | daemon.ts `main()` `process.once("uncaughtException")` | (a) `once`: second exception during stop → Node default handler prints message + stack (H2), stop interrupted, lock left; (b) `throw null` → `err.name` TypeError in handler → exit 7, no `exit` hook, auth.json + lock left | probe3 "twice": stderr has `SECRET-MESSAGE` + stack; "null": exit 7, files left | `process.on` + re-entry guard; `err instanceof Error ? err.name : typeof err` |
| M5 | nit (verified) | api.ts `frameworkErrors` | always logs `status: 400` (also when answering 421), no `ms`; J5 test locks in the wrong value | `/%E0%A4%A` + `Host: evil.com` → 421, log 400 | log real status; fix test |
| M6 | nit (verified) | client.ts `request()` | after a restart the first call fails (`API_ERROR 401` same port / `DAEMON_NOT_RUNNING` new port), only the second works — conflicts with "client follows the port via auth.json" | probe2 | on ECONNREFUSED / 401: reload, re-verify, retry once for idempotent methods; or document for F-004 |
| M7 | nit | client.ts `verify()` `reload().catch(() => undefined)` | every `readDoc` error (unsafe path, ACL, corrupt, newer schema) becomes `DAEMON_NOT_RUNNING`, hiding security-relevant errors | auth.json replaced by a junction → "not running" | map only `undefined`; rethrow others |
| M8 | nit | auth.ts `checkUpgrade` | no 50 ms delay after a wrong bearer; result does not say which subprotocol to echo — a client offering only `webhub-key.<key>` invites echoing the key | F-027 wires WebSocket | require a non-key protocol (`webhub.v1`) next to the key, return it as `protocol` |
| M9 | nit (not verified) | spec §6 "key อยู่ใน history ช่วงสั้นๆ" | 303 target `/#k=<key>` likely kept in persistent history / sync; `replaceState` does not delete the visit | history file holds the key (cookie still needed) | fix wording or POST exchange instead of fragment — decide in F-027 |
| M10 | nit (test validity) | api-socket / server / daemon tests | (a) L5 test passes with no response (`?? "200"`), no current-request parse-error test (missed M1); (b) tossing test uses one value (missed M2); (c) J6 test only covers the remover; (d) subprotocol path not tested with another session's key / tossed cookie; (e) EACCES untested; (f) `app.server.headersTimeout =` redundant | regressions unnoticed | add tests per M1 / M2; child-process test of `main()` crash path |

## Earlier findings
J1 OK · J2 OK (hanging close → M3) · J3 OK · J4 OK · J5 partly (M5) · J6 OK (M4 remains) · J7 OK for `verify()` (M6, M7) · J8 mostly (M10) · L1 OK at API level (tossing overclaim → M2) · L2 OK · L3 OK (accepted) · L4 OK (documented) · L5 OK for pipelining, too broad (M1). DESIGN §10.3 and PLAN F-026 / F-027 reflect round 3; spec §10 R4 checklist not ticked.

Not verified: real browser cookie overwrite / history / subprotocol handshake; real Windows signals; EACCES; Linux / Node 22; cross-user flood.

## Status
critical 0 · major 0 · minor 4 (M1–M4) · nit 6 (M5–M10)
