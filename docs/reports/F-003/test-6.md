# Test report — F-003 — round 6

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit — fixes for review-5 / security-5; user: S1 = "end then destroy + backstop timer", minor/nit "แก้ทั้งหมด") |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1, fastify 5.12.7 (CI blocked — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 – F-003) | 235 | 0 | 5 |

Other checks: lint, typecheck, build and `pnpm audit` (high) all pass.

## Changes and tests per finding
| Finding | Change | Test | Fails without the change |
|---|---|---|---|
| S1 / R1 (critical / major) | `writeClientError`: `socket.end(reply, () => socket.destroy())` plus a 2 s unref'd backstop destroy (`CLIENT_ERROR_CLOSE_MS`), cleared on `close` | 5 clients, each sending health ×3 pipelined + garbage → `[200,200,200,400]`, the server closes the socket, `getConnections()` = 0 within 1 s, `app.close()` < 500 ms | yes (verified with the old `api.ts`) |
| R2 / S2 (minor / info) | `waitForResponses`: after each `finish`, if Node handed the socket to another unfinished pipelined response, wait for that one too (one `finish` / `close` pair per socket at a time); the 400 comes last | slow 200 ms + slow 600 ms + garbage → `[200,200,400]`, both bodies present | yes |
| R3 (nit) | — | 101 → `DAEMON_UNREACHABLE` with `details = ["EUPGRADE"]` | — |
| R4 (nit) | — | spawned daemon with `--import test/fixtures/hang-close-daemon.mjs` (every `close()` hangs + a ref'd timer), `POST /shutdown` → exit 1 within 10 s, auth.json and lock gone | yes (exit timer removed from `dist` → test fails) |

## Not run
- Real SIGINT / SIGBREAK / SIGHUP on Windows.
- Browser / nginx (F-009, F-027); Linux / Node 22.
