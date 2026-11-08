# Code review — F-003 — round 4

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 299c6d2 |
| Reviewer | fresh agent; build / typecheck / lint clean, 56/56 F-003 tests; probes: hanging close hooks, pipelining, OneConnectionAgent vs real API + fake server, client across restarts, N1 / M5 / M8, signals in a child daemon |

## Findings
| ID | Sev | Location | Problem | Scenario | Suggested fix |
|---|---|---|---|---|---|
| P1 | minor (verified) | daemon.ts `stopFn` race + `main()` (`process.exitCode`); `startDaemon` catch `await app?.close()` | 6 s bound only helps `onClose` hooks (Fastify closes the server first). A never-resolving **`preClose`** hook → server never closed: `{clean:false}`, auth.json deleted, lock released, but the port keeps answering 503 and the listen handle keeps the process alive forever. Start-up `app.close()` also unbounded. M3 test uses `onClose` only | registrar `preClose: () => new Promise(() => {})` → after 6009 ms still listening, 503, process alive; next start → EADDRINUSE exit 4 against its own leftover | on timeout `server.close()` + `closeAllConnections()`; `main()` → `process.exit(code)` after `stopped`; bound start-up close; test with hanging `preClose` (port released / child exits) |
| P2 | minor (verified) | api.ts `clientError` deferral | after a parse error Node feeds later chunks to the parser and emits `clientError` per chunk → one more `finish` + `close` listener each, unbounded | slow pending response + 30 garbage chunks → 25 emits, `MaxListenersExceededWarning`; wire output still correct; grows with attacker data while a response is pending | handle each socket once (WeakSet / flag); test listener count |
| P3 | nit | api-socket L5 test; spec §3.4 | (a) `slice(1).every(...)` true on empty → passes if the 400 is never sent; (b) spec still says pipelined parse error "ตัด connection" | mutation `socket.destroy()` still passes | `expect(statuses).toEqual(["200","400"])`; fix spec |
| P4 | nit (verified) | spec §3.5 "ล้มก่อนส่ง byte ใด", §6 N2 row; client.ts comment | daemon destroying the proven socket right after hello → pooled socket reused → bearer written on it → ECONNRESET (not EPROOFLOST). Same TCP connection, peer = proven process, server received nothing — not a leak, but wording inaccurate | fake server: proof, then `socket.destroy()` on finish → `DAEMON_UNREACHABLE [ECONNRESET]`, only hello seen | reword: "token only ever written to the proven connection"; optional test |
| P5 | nit | api.ts `frameworkErrors` | status fixed, still no `ms` field | `/%E0%A4%A` + `Host: evil.com` → `{method,path,status:421}` | add `ms` or document |

Checked OK: OneConnectionAgent (70 requests = 70 connections, none left; pooled reuse after hello; cut body / reset → `DAEMON_UNREACHABLE`); proxy check short-circuits before the code; `browserLogin` default off → 503; `checkUpgrade` (key-only 401, `webhub.v1`+key → `protocol`, wrong bearer `delay`, key never returned); `readCookies` first 8; second signal → exit 1, auth.json removed (lock left by design); single signal → exit 0, both removed; stop timers cleared.

## Earlier findings
M1 OK · M2 OK · M3 **partly** (`preClose` → P1) · M4 OK · M5 mostly (P5) · M6 OK · M7 OK · M8 OK · M9 OK · M10 mostly (P3a, P1) · N1 OK at API level (default 503; no / duplicate / upper-cased / other-token header → 401; internal without XFH 401, with XFH + secret 303; IP host + secret 401) · N2 OK (wording P4) · N3 accepted · N4, N5 documented · N6 OK.

Not verified: real Windows signals; EACCES; Linux / Node 22; browser behaviour; nginx wiring.

## Status
critical 0 · major 0 · minor 2 (P1, P2) · nit 3 (P3–P5)
