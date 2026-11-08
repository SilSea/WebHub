# Test report — F-003 — round 3

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit — fixes for review-2 / security-2; user: L1 = cookie + header key in sessionStorage, L3 = residual risk, minor/nit "แก้ทั้งหมด") |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1, fastify 5.12.7 (CI blocked — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 – F-003) | 219 | 0 | 5 |
| — F-003 (`server.test.ts`, `daemon.test.ts`, `api-socket.test.ts`) | 46 | 0 | 0 |

Other checks: lint, typecheck, build, `pnpm audit` (high) — pass.

## Changes + tests per finding
| Finding | Change | Test |
|---|---|---|
| L1 (critical) | session = cookie + `X-Webhub-Session` key (separate 32-byte secret) of the same session; key delivered as `303 Location: /#k=<key>`; cookie without Max-Age; idle 2 h / max 24 h; WebSocket key via subprotocol `webhub-key.<key>`; several cookie values tried (≤ 8) so tossing neither fixes nor logs out; `/_auth` removed (→ F-026) | unit: cookie only → 401; other session's key → 401; bad key → 401; tossed / other cookie first → 200; Location `#k=`; no Max-Age; checkUpgrade header + subprotocol + no key → 401; key not in logs |
| L2 / J1 (minor) | `http: { headersTimeout, requestTimeout, connectionsCheckingInterval: 1000 }` | integration (real socket): partial headers → 408 in 9–12.5 s, with security headers |
| J3 (minor) | `requireHostHeader: false` → hook answers 421 | integration: raw HTTP/1.1 without Host → 421 (api-socket + spawned daemon) |
| J2 (minor) | stop catches close errors, logs class only, never rejects; `stopped` → `{ clean }`; `main()` exits 1 when not clean | integration: throwing onClose hook → `{clean:false}`, no unhandled rejection, files + lock gone |
| L3 (minor) | accepted residual risk (spec §6); L2 shortens socket hold | (docs) |
| J4 | `exposeHeadRoute: false` on `/_webhub/login` | unit: HEAD → 404, no cookie, GET still works |
| J5 | `frameworkErrors` logs `(invalid target)` | unit: 2 log lines, no target |
| J6 | `onAuthFile` remover; `exit` / `uncaughtException` hooks before start | integration: remover deletes our file |
| J7 | client re-reads auth.json once when the proof fails (new token → retry; file gone → `DAEMON_NOT_RUNNING`) | unit: restart → 401 then OK with new token; file gone → NOT_RUNNING |
| J8 | missing tests | 503 while closing, shutdown on disconnect, client deadline (`sendRaw` timeout param), login-links empty body / `__proto__` / `constructor` |
| L5 | parser error while a response is pending → destroy socket | integration: garbage after a valid request — never a 400 before the 200 |
| L4 | requirement for F-009 / F-026 (spec §3.3, PLAN) | (docs) |

## Not run
- Real SIGINT / SIGBREAK / SIGHUP delivery on Windows; EACCES on an excluded port (H7).
- Browser check of L1 fix (needs the dashboard F-027 / nginx F-009); verified at API level.
- Linux / Node 22.
