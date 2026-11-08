# Code review — F-003 — round 1

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 33810ce |
| Reviewer | fresh agent; build + lint + 24/24 F-003 tests; probes against a real `createApi` server and spawned `dist/daemon.js` (temp home, free ports) |

Verified OK: duplicate / missing Host → 421 on the real server; HEAD routes keep route config (auth / scope); security headers on 421/401/404/405/HEAD; 415 for none/text/multipart, `APPLICATION/JSON` accepted; exit 2 for bad `WEBHUB_API_PORT` / invalid config / invalid JSON; shutdown with idle keep-alive + half-sent request → 202, exit 0 after grace, auth.json + lock removed; start-up errors release the lock and only remove our auth.json.

## Findings
| ID | Sev | Location | Problem | Scenario | Suggested fix |
|---|---|---|---|---|---|
| H1 | major (= security K1) | api.ts login-links default host; auth.ts | sessions issued for `127.0.0.1:7400`; cookies are not port-scoped → sent to every `127.0.0.1:<port>` | project dev server on `127.0.0.1:3000` gets `webhub_session`, replays it | sessions only on `hub.`/`db.<suffix>`; bearer only on `127.0.0.1:<apiPort>` |
| H2 | minor (verified) | api.ts error handler | 5xx `err.message` logged as-is (token in message → in log) | later features put paths/secrets in errors | log fixed text + error class/code only; test |
| H3 | minor (verified) | api.ts | Fastify framework / client errors bypass Host check + hooks (`/%E0%A4%A` with `Host: evil.com` → 400 echoing path) | default body, no headers, no 421 | `frameworkErrors` (421 if Host bad, else uniform 400) + `clientErrorHandler` |
| H4 | minor (verified) | api.ts `return503OnClosing` | 503 while closing written outside hooks | wrong format, no headers | closing flag → `deny(503, "SHUTTING_DOWN")` in onRequest |
| H5 | minor (unverified race) | daemon.ts main / onShutdown | shutdown before `daemon` assigned → 202 but no stop; library callers without `onShutdownRequest` get 202 and nothing happens | F-004 sends shutdown right after auth.json appears | wire onShutdown to RunningDaemon's own stop (queue if before ready); main awaits it |
| H6 | minor | src/server | spec §1 promised a shared WebSocket upgrade check; none exists | F-027 re-implements checks | export `checkUpgrade` + tests, or descope in spec |
| H7 | minor (unverified) | daemon.ts listen | `EACCES` (Windows excluded port range) → exit 1 raw error | 7400 inside excluded range | map EACCES → DAEMON_PORT_BUSY + hint |
| H8 | minor (unverified) | daemon.ts signals | handlers installed after start; no SIGHUP (console close) | Ctrl+C during start / closing console → stale auth.json + lock | install before start; add SIGHUP |
| H9 | minor | tests | missing: signal stop path, config invalid exit 2, real missing Host, real Set-Cookie flags, CORS on all responses, HEAD / bad URL | regressions unnoticed | add tests (in-process `stop()`, raw socket) |
| H10 | minor | api.ts shutdown | runs only on `finish`; client disconnect → never stops | CLI killed during shutdown | also on `close` / setImmediate, once |
| H11 | nit (verified) | daemon.ts describe | CONFIG_INVALID problems printed twice | — | first line of message when details exist |
| H12 | nit (verified, = K5) | api.ts onResponse | absolute-form target logged with foreign host | — | log pathname |
| H13 | nit | client.ts | `#verified` cached forever; socket idle timeout not total; hello pid not compared | slow-drip server stalls client | re-verify after connection error; overall deadline; compare pid |
| H14 | nit | daemon.ts start error path | `lock.release()` throwing hides original error (exit code) | rare | try/catch, rethrow original |
| H15 | nit | api.ts | 405 without `Allow`; 303 → `/` is 404 until F-027; logout with JSON content-type + empty body → 400 | browser fetch to logout | `Allow`; accept empty JSON body |
| H16 | nit | daemon.ts | auth.json written after listen → old auth.json during window → `DAEMON_IMPOSTOR` | client polls during start | document for F-004 (wait for `auth.json.pid` = spawned pid) or write before listen |

Not verified: real SIGINT/SIGBREAK on Windows (H8/H9a), H5 race, H7 on this machine.

## Status
critical 0, major 1 (H1), minor 9 (H2–H10), nit 6 (H11–H16).
