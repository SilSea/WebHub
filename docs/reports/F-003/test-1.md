# Test report — F-003 — round 1

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit — first implementation) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1, fastify 5.12.7 (CI blocked by GitHub billing lock — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 – F-003) | 197 | 0 | 5 |
| — F-003 unit (`test/unit/server.test.ts`) | 20 | 0 | 0 |
| — F-003 integration (`test/integration/daemon.test.ts`) | 4 | 0 | 0 |

Other checks: lint (Biome), typecheck, build, `pnpm audit` (high) — pass. Pack test (F-000) accepts the new `dist/daemon.js`, `dist/server/*.js`.

## Spec test plan coverage
| # | Case | Result |
|---|---|---|
| 1 | Host allowlist (exact, case, trailing dot, `localhost:7400`, suffix tricks, IPv6, duplicates) → 421 | pass |
| 2 | bearer good / bad / missing / malformed | pass |
| 3 | CSRF: cookie POST w/o Origin, other Origin, `cross-site`, `same-site` → 403; `text/plain`, form → 415; OPTIONS → 405; no `Access-Control-*` | pass |
| 4 | login link: single use, 60 s, host-bound, flags, no `Domain`, `no-store` / `no-referrer` | pass |
| 5 | sessions: host-bound, idle + absolute expiry, logout | pass |
| 6 | `webhub.internal`: only `/_auth` + `/_webhub/login`; forwarded host must be allowed, no lists | pass |
| 7 | handshake: impostor (fake + real HTTP server) never sees the token | pass |
| 8 | lifecycle: auth.json (ACL: SYSTEM + user only), status, shutdown → auth.json + lock removed; 2nd daemon exit 3; busy port exit 4 naming the owning PID | pass |
| 9 | restart → new token, old token 401, stale client → `DAEMON_IMPOSTOR` | pass |
| 10 | log lines: no token / code / cookie / query | pass |
| 11 | body > 1 MB → 413; errors without stack / paths / token | pass |
| 12 | registrar routes authenticated by default | pass |
| 13 | regression F-000 – F-002 | pass |

## Not run
- Linux / Node 22 (CI blocked).
