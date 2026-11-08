# Test report — F-003 — round 4

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit — fixes for review-3 / security-3 after 3 loops; user: N1 = proxy secret + login off until F-009, N2 = proof bound to the connection, minor/nit "แก้ทั้งหมด") |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1, fastify 5.12.7 (CI blocked — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 – F-003) | 229 | 0 | 5 |
| — F-003 (`server.test.ts`, `daemon.test.ts`, `api-socket.test.ts`) | 56 | 0 | 0 |

Other checks: lint, typecheck, build, `pnpm audit` (high) — pass.

## Changes + tests per finding
| Finding | Change | Test |
|---|---|---|
| N1 (critical) | `/_webhub/login` redeems only with `X-Webhub-Proxy: proxySecretFor(token)` (checked before the code is touched); `POST /api/v1/login-links` → 503 `LOGIN_UNAVAILABLE` unless `browserLogin` (off by default; F-009 turns it on); requirements for F-009 (header, strip client copy, ACL, rewrite per start) and F-004 (check http-port owner) | unit: no / wrong / other-token proxy header (direct + internal) → 401, no cookie, code still redeemable via nginx → 303; `browserLogin` off → 503 |
| N2 (major) | `OneConnectionAgent` (one keep-alive connection, a second open fails before writing); every `request()` = new connection → hello → bearer on the same connection; no proof cache | unit: hello before every request, one agent per request; integration: server answers a real proof then closes → `DAEMON_UNREACHABLE`, token never sent; real API: proof + request = 1 connection, next request = new one |
| M1 (minor) | `clientError` writes 400 / 408 at once when the error belongs to the request being parsed; when an earlier response is pending it writes after that response finished (destroys if it never does) | integration: bad chunk → 400, incomplete body → 408 (< 33 s); pipelined garbage → 200 first, then 400 only (strict — this test caught a first, too narrow fix) |
| M2 / N3 (minor) | `readCookies` keeps the first 8; spec / comment / test: logout by tossing / overwrite = accepted residual | unit: 7 junk + real → 200; 8 junk + real → 401 (documented) |
| M3 (minor) | `close()` raced against 6 s → `clean:false`, cleanup anyway; 2nd signal → exit 1 (exit hook removes auth.json) | integration: never-resolving onClose → stopped `{clean:false}` < 9 s, files + lock gone |
| M4 (minor) | `process.on("uncaughtException")` + re-entry guard; `errorClass()` (handles `throw null`) | integration (spawned daemon + `--import` fixture): two Errors → exit 1, no message / stack; `throw null` → exit 1; files + lock gone |
| M5 / N6 | `frameworkErrors` logs the real status | unit: log lines 400 and 421 |
| M6 / J7 | proof failure → reload auth.json → prove again → first call after a restart succeeds; old token never re-sent | unit |
| M7 | only "file gone" → `DAEMON_NOT_RUNNING`; other read errors surface | unit: reload throws → that error |
| M8 | subprotocol key needs `webhub.v1` next to it; `checkUpgrade` returns `protocol`; wrong bearer → `delay: true` | unit: key only → 401; other session's key → 401; tossed cookie → ok; `protocol: "webhub.v1"`; `delay: true` |
| M9 / N4 / N5 | spec wording (history, session restore), requirements for F-009 / F-027 (no redirect on `/`, CSP on hub. + db.) | (docs) |
| M10 | L5 test strict; tossing with 7 / 8 junk; crash path of `main()` in a child process; subprotocol cases; redundant `headersTimeout` assignment removed | as above |

## Not run
- Real SIGINT / SIGBREAK / SIGHUP delivery on Windows; EACCES on an excluded port (H7).
- Browser checks (need nginx F-009 / dashboard F-027).
- Linux / Node 22.
