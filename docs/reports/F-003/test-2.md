# Test report — F-003 — round 2

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit — fixes for review-1 / security-1; user chose "แก้ทั้งหมด") |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1, fastify 5.12.7 (CI blocked — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 – F-003) | 206 | 0 | 5 |
| — F-003 (`test/unit/server.test.ts` + `test/integration/daemon.test.ts`) | 33 | 0 | 0 |

Other checks: lint, typecheck, build, `pnpm audit` (high) — pass.

## Changes + tests per finding
| Finding | Change | Test |
|---|---|---|
| K1 / H1 (critical) | sessions only on `hub.`/`db.<suffix>` (`sessionHosts`); login links default to `hub.`; `/_webhub/login`, `/_auth`, forwarded host limited to session hosts; IP host = bearer only | unit: link for IP → 400; code redeemed on IP → 401 no cookie; hub cookie with IP Host → 401 |
| K6 | duplicate cookie = no session | unit: tossed duplicate → 401 |
| K2 / H8 | signal handlers before start (+ SIGHUP), abort → stop once ready; `exit` hook removes auth.json sync; `uncaughtException` → stop + exit 1; stdout/stderr EPIPE ignored | integration (in-process): abort before / after ready |
| H5 / H10 | shutdown wired to the daemon's own stop (queued before ready); fires on `finish` or `close`; `stopped` promise | integration: API shutdown → `stopped`, files gone |
| H16 | auth.json written before listen, removed if listen fails | integration: busy port → no auth.json (existing test) |
| H7 | `EACCES` → `DAEMON_PORT_BUSY` (exit 4) + excluded-range hint | (code) |
| H14 | start-up cleanup never hides the original error | (code) |
| H11 | problems printed once | integration: invalid config → exit 2, `mode` once |
| H2 | 5xx log = error class / code only | unit: log has `"error":"Error"`, no token / message |
| H3 / K8 | `frameworkErrors` (421 if Host bad, else uniform 400 + headers); `clientErrorHandler` uniform raw reply | unit: `/%E0%A4%A` good Host → 400 uniform, bad Host → 421 |
| H4 | own 503 `SHUTTING_DOWN` via `preClose` flag (`return503OnClosing: false`) | (code) |
| K5 / H12 | absolute-form target → 400, logged as `(invalid target)` | integration raw socket: 400, host not in log |
| K4 | `headersTimeout` 10 s, `maxConnections` 256 | unit: server values |
| K7 | hello returns `{ proof }` only | unit |
| H13 | overall 10 s deadline; re-verify after connection error / 401 | (code) |
| H15 | `Allow` on 405; empty JSON body accepted | unit |
| H6 | `checkUpgrade()` exported | unit: bearer, session + Origin, missing / bad Origin, IP host cookie, bad Host, internal, bad token, duplicate Host |
| H9 | missing tests added | integration: missing Host (raw HTTP/1.0) → 421, config invalid exit 2, in-process stop paths; unit: real Set-Cookie, headers on all responses, HEAD, bad URL |
| K3 / K11 | spec requirements for F-004 / note | (docs) |

## Not run
- Real SIGINT / SIGBREAK / SIGHUP delivery on Windows (tested through the in-process abort path instead).
- Linux / Node 22.
