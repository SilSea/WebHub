# Test report — F-003 — round 5

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit — fixes for review-4 / security-4; user: Q1 = requirements for F-009 / F-004, Q3 = one reply per socket + stop reading, minor/nit "แก้ทั้งหมด") |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1, fastify 5.12.7 (CI blocked — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 – F-003) | 232 | 0 | 5 |
| — F-003 (`server.test.ts`, `daemon.test.ts`, `api-socket.test.ts`) | 59 | 0 | 0 |

Other checks: lint, typecheck, build, `pnpm audit` (high) — pass.

## Changes + tests per finding
| Finding | Change | Test |
|---|---|---|
| Q1 (major, latent) | requirements (spec §3.3, §6, DESIGN §10.3, PLAN F-004 / F-009): nginx binds `127.0.0.1` and `[::1]`, every listener on the http port must be webhub's nginx before `browserLogin` and before every link; residual race documented in F-009. No code — login stays off (503) | (docs; tests belong to F-009 / F-004) |
| Q3 / P2 (major latent / minor) | `clientError`: one deferral per socket (`WeakSet`), `socket.pause()`, reply written by `writeClientError` once the earlier response finished; later errors on that socket ignored | integration: slow route + 60 one-byte garbage chunks → `["200","400"]`, no `MaxListenersExceededWarning`, ends < 2 s |
| Q2 (minor) | client `send()` settles once; `close` without a result → ECONNRESET; `upgrade` → socket destroyed + EUPGRADE | integration: raw server answering 101 → `DAEMON_UNREACHABLE` < 3 s |
| Q4 / P1 (minor) | `closeBounded()` for stop and start-up errors: after grace + 1 s force `server.close()` + `closeAllConnections()` (port released); lock released only after that; `main()` exits (unref'd 1 s timer) when not clean | integration: hanging `preClose` → `{clean:false}`, not listening, a new daemon starts on the same port, lock gone |
| P3 | L5 test → `toEqual(["200","400"])`; spec §3.4 wording | integration |
| P4 | spec §3.5 / client wording: token only ever written to the proven connection | (docs) |
| P5 | spec: `(invalid target)` lines have the real status, no `ms` (no start time) | (docs) |
| Q5 / Q6 | requirements for F-009 (never log headers, secret only to the daemon) and F-027 (`delay`, target, echo `protocol`) | (docs) |

## Not run
- Real SIGINT / SIGBREAK / SIGHUP on Windows; EACCES on an excluded port.
- `main()` forced exit after a hung `preClose` in a spawned process (in-process port release tested).
- Browser / nginx (F-009, F-027); Linux / Node 22.
