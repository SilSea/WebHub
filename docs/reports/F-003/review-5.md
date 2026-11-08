# Code review — F-003 — round 5

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | f49e1c0 (code as of d0375ec) |
| Reviewer | fresh agent round 5. Typecheck and lint are clean. The F-003 suites (`server.test.ts`, `daemon.test.ts`, `api-socket.test.ts`) pass 63/63 when run alone. Probes: built `src` into a scratch dir, sent raw-socket pipelining and leak probes to an in-process `createApi`, and stress-tested `sendRaw` against a server that closes or RSTs right after it answers. |

Note: one full `pnpm test:full` run failed in `test/integration/store.test.ts` (F-001, "4 processes taking over the same stale lock → exactly one wins", 15 s timeout). The probes were running at the same time, and the test passed when run alone afterwards. This looks like flakiness under load, not an F-003 regression.

## Findings
| ID | Severity | file:line | Problem | Concrete failure scenario | Suggested fix |
|---|---|---|---|---|---|
| R1 | **major** (verified; regression from the Q3 fix) | src/server/api.ts:149 (`socket.pause()`) + :171 (`writeClientError` → `socket.end`) | A deferred socket is paused and never resumed or destroyed. `end()` half-closes it, but a paused socket never reads the client's FIN. If a second pipelined response is still pending, no keep-alive timer is set either. The socket then leaks for good and counts against `MAX_CONNECTIONS`. | No auth needed. Two pipelined requests with a wrong bearer (each held back by `failDelayMs`), then garbage, then disconnect. 20 clients gone for 15 s → `getConnections()` = 20. 450 such connections → 256/256 slots used → health = `ECONNRESET` until the daemon restarts. This breaks the timeout mitigation that the accepted L3 risk relies on. `app.close()` hangs until the 5 s cut. | `socket.end(payload, () => socket.destroy())`. Verified: 0 leaks, close takes 1 ms. Test: two pending pipelined requests + garbage → `getConnections()` drops to 0. |
| R2 | minor (verified) | src/server/api.ts:143-150 | The deferral waits only for the response that currently owns the socket (`_httpMessage`), not for every earlier one. If a later pipelined response is still pending, the 400 takes its place and that response is lost. This breaks the spec §3.4 / L5 "no reordering" claim. | `slow?ms=200`, `slow?ms=600`, garbage → `["200","400"]`. The second 200 is lost. Rare: needs pipelining plus a parse error, and browsers do not pipeline. | In the `finish` callback, if `_httpMessage` is now another unfinished response, attach the same pair to it. Test → `["200","200","400"]`. |
| R3 | nit | test/integration/api-socket.test.ts:227-252 | The Q2 test only asserts `DAEMON_UNREACHABLE`. With the `upgrade` listener deleted, the test still passes via `ECONNRESET`. | Remove `req.on("upgrade")` → the suite stays green. | Also assert `details` = `["EUPGRADE"]`. |
| R4 | nit | src/daemon.ts:351-355; test/integration/daemon.test.ts | The Q4 change to `main()` (`process.exit(1)` when the stop was not clean) has no test in a spawned process. | A regression that drops the timer would not be caught. | Spawned-process test with a fixture that holds a handle → exit 1 within about 8 s, auth.json and lock gone. |

## Verified OK
- Q3: one deferral per socket. 60 garbage chunks → `["200","400"]` with no listener warning. The immediate-400 path (M1) works. In the single-pending case, the keep-alive timer frees the socket within about 5 s.
- Q2 client: `send()` settles exactly once. 2000/2000 calls resolved against a server that ends or RSTs right after answering, with no false `ECONNRESET`. A 101 is rejected in under 3 s.
- Q4/P1 `closeBounded`: a hanging `preClose` → `{clean:false}`, the port is released, and a new daemon starts on it. Timers are cleared on every path. The start-up error path is bounded too.
- Unchanged and still fine: Host allowlist / 421, origin-form check, OPTIONS 405, scope, `access` defaults, CSRF, sessions (cookie + key header, named hosts only), login code single use + proxy secret checked before consuming, `browserLogin` 503 by default, `OneConnectionAgent`, reload-once, auth.json removed only when it holds our token, exit codes.
- Docs: spec §3.4 / §3.5 / §6 and PLAN F-027 match the code, except the "no reordering" claim (R2).

## Status
critical 0 · major 1 (R1) · minor 1 (R2) · nit 2 (R3, R4)
