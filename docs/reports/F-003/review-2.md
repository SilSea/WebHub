# Code review — F-003 — round 2

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 1aaf6b4 |
| Reviewer | fresh agent (no prior context), build + 33 F-003 tests + 3 probe scripts (real `createApi`, in-process `startDaemon`, raw sockets) |

## Findings
| ID | Sev | Location | Problem | Scenario | Suggested fix |
|---|---|---|---|---|---|
| J1 | minor (verified) | api.ts `headersTimeout` | K4 half fixed: Node checks timeouts every `connectionsCheckingInterval` (default 30 s) → slow headers get 408 at ~29 996 ms, not ~10 s | local slowloris holds each socket 30 s | `http: { connectionsCheckingInterval: 1000 }`; timing test (408 < 12 s) |
| J2 | minor (verified) | daemon.ts `stopFn` / `requestStop` / abort listener | `app.close()` rejecting (e.g. a future `onClose` hook throws) → `void stopFn()` = unhandled rejection; `stopped` still resolves, exit code races (0 vs 1) | verified: "UNHANDLED REJECTION: onClose boom" | catch + log in stop; `stopping` never rejects; decide exit code for failed stop |
| J3 | minor (verified) | api.ts (Node `requireHostHeader`) | HTTP/1.1 without Host → Node built-in 400 (no security headers, no JSON) — bypasses hooks; spec §3.2 says 421 | `GET / HTTP/1.1` no Host → `400` chunked empty | `http: { requireHostHeader: false }` → hook returns 421; raw HTTP/1.1 test |
| J4 | nit (verified) | api.ts `/_webhub/login` + `exposeHeadRoutes` | HEAD consumes the login code and creates a session (303 + Set-Cookie); conflicts with §3.4 "GET/HEAD ไม่เปลี่ยนข้อมูล" | link preview / HEAD probe burns the code | `exposeHeadRoutes: false` on this route |
| J5 | nit (verified) | api.ts `frameworkErrors` | bad-URL-encoding 400s never reach `onResponse` → not logged | `/%E0%A4%A` → 400, no log line | log from `frameworkErrors` with `(invalid target)` |
| J6 | nit | daemon.ts `main()` | `uncaughtException` / `exit` hooks installed only after start succeeds → crash mid-start leaves auth.json + lock | rare; F-004 treats file + refused port as not running | install hooks before start |
| J7 | nit | client.ts `verify` / `request` | re-verify after 401 / connection error uses cached old AuthFile → restarted daemon reported as `DAEMON_IMPOSTOR` (misleading) | long-lived client after restart | re-read auth.json on failed re-verify; note for F-004 |
| J8 | nit (test validity) | test/unit/server.test.ts, test/integration/daemon.test.ts | gaps: K4 property-only (missed J1); no test for 503 (H4), shutdown on disconnect (H10), EACCES (H7), cleanup on start error (H14), client deadline / re-verify (H13), proto poisoning, empty body on login-links; missing Host only HTTP/1.0 (missed J3) | regressions unnoticed | raw-socket + timing tests; fake `sendFn` |

Checked, no problem: JSON parser (`__proto__` / `constructor` → 400, empty body variants, content-type variants); shutdown fires once on half-close / destroy; client verify during close → `DAEMON_NOT_RUNNING`; pipelined request during close; absolute-form and `OPTIONS *` → 400; obs-fold → 400 with headers; headersTimeout < requestTimeout; deadline timer cleared; `exit` hook only removes auth.json holding our token; `stopQueued` + abort before/after ready.

## Round-1 findings
H1 OK · H2 OK · H3 OK (missing Host HTTP/1.1 → J3) · H4 OK (code only) · H5 OK · H6 OK · H7 OK by code · H8 OK by code (real Windows signals unverified) · H9 partly (J8) · H10 OK (probe) · H11 OK · H12 OK · H13 OK (see J7) · H14 OK · H15 OK · H16 OK · K1 OK · K2 OK after ready (J6) · K4 **not OK** (J1) · K5 OK · K6 OK · K7 OK · K8 partly (J3).

Not verified: real SIGINT / SIGBREAK / SIGHUP on Windows; EACCES on excluded port; `uncaughtException` in spawned daemon; Linux / Node 22.

## Status
critical 0 · major 0 · minor 3 (J1–J3) · nit 5 (J4–J8)
