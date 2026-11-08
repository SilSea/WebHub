# Test report — F-003 — round 7

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit) — fixes for review-6 and security-6 |
| User decisions | U1 + T1: "no pipelining + idle timeout". U2: "time-bound the wait + write a requirement". Minor/nit: "แก้ทั้งหมด". |
| Environment | Windows 11 Pro 26200, Node 24.20.0 (full suite) and Node 22.12.0 (F-003 suites), pnpm 12.9.1, fastify 5.12.7. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 – F-003), Node 24.20 | 239 | 0 | 5 |
| F-003 (`api-socket`, `daemon`, `server`), Node 22.12 | 66 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

**Note on the F-001 lock test.** The F-001 test "4 processes taking over the same stale lock" timed out at 15 s in two full-suite runs. Both runs used the first, heavier version of the new socket tests (50 sockets × 5 000 requests, 2 MB × 5, 8 MB body). It passes when run alone. With the tests made lighter (20 × 2 000, 2 MB × 3, 4 MB), the full suite passes. F-001 is `done`, so its timeout was not changed (R1).

## Changes and tests per finding
| Finding | Change | Test | Fails without the change |
|---|---|---|---|
| U1 (critical) + T1 (major) | `refusePipelining`: a request that arrives while the previous response on the same socket is unfinished destroys the socket, and Fastify never sees it. The `clientError` deferral now waits for one response only (no chain) and no longer checks `writableFinished`. | (1) Pipelined ×3: the handler runs at most once and the connection count drops to 0. (2) 20 non-reading sockets × 2 000 tiny requests: the sockets are cut, the connection count reaches 0, there are fewer than 200 log lines, and the API still answers. (3) The suites pass on Node 22.12. | yes, (1) and (2) |
| U1 / U3 (idle) | `connectionTimeout` 15 s (`CONNECTION_IDLE_MS`). A server `timeout` handler destroys idle sockets and leaves a request that is still being received to the 408 timeout (M1 still passes). | A client that never reads a 4 MB answer is cut within 22 s. M1 still gets its 408. | — |
| U2 (major, latent) | The deferral is bounded: an unref'd 5 s timer (`CLIENT_ERROR_DEFER_MS`) destroys the socket. Requirement added to the spec and to PLAN F-004: streaming routes must send keep-alive bytes. | 12 s route + garbage + FIN, ×3: connection count = 0 within 7 s. | yes |
| T2 (minor) | `writeClientError` calls `resume()` then `end()` (no destroy after flush), keeping the 2 s backstop. | 2 MB header ×3: a 431 every time, and the connection count reaches 0. | yes |
| S1 (round 5) still covered | — | Request + garbage ×5: `[200,400]`, connection count = 0, `app.close()` under 500 ms. | — |
| T3 / U3 (docs) | Spec §3.4 and §6 (U1, U2, L3 wording), test row 25. | — | — |
| U4 (info) | PLAN F-004 requirement: rotate or cap the daemon log, or merge repeated 4xx lines. | — | — |

## Not run
- Linux and macOS (the sync-write path).
- Real SIGINT, SIGBREAK and SIGHUP on Windows.
- Browser and nginx (F-009, F-027).
