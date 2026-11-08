# Code review — F-003 — round 6

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 38c7649 |
| Reviewer | fresh agent round 6 |

**Checks.** `pnpm build`, `typecheck` and `lint` are clean. `pnpm test:full` on Node 24.20 gave 234 passed and 1 failed. The failure is the F-001 `store.test.ts` lock race, which ran while probes loaded the machine. It passed 4/4 when run alone, so it is load flakiness, not an F-003 issue.

**Node 22.** The F-003 suites and probes were also run under the official Node v22.12.0 win-x64 binary (`engines: >=22.12`; CI matrix `[22, 24]`).

**Probes.** Raw-socket pipelining against an in-process `createApi`. A Duplex with synchronous writes simulated Linux/macOS `uv_try_write`. Patched copies of `dist/` in the scratchpad were used to check the suggested fixes.

## Findings
| ID | Severity | file:line | Problem | Concrete failure scenario | Suggested fix |
|---|---|---|---|---|---|
| T1 | **major** (verified; the R2/S2 fix and its test fail on Node 22, which the project supports and CI runs) | src/server/api.ts:147, :174 (`writableFinished !== true`) | On Node 22.12, `writableFinished` is a computed getter (`finished && outputSize === 0 && socket.writableLength === 0`). When `resOnFinish(res1)` hands the socket to the queued `res2` and flushes it, `res2` already reads as finished, even though its `finish` has not fired and `res3` is still queued. `onFinish` then writes the 400 right away, and `res3` is lost. The check at :147 has the same race. | Node 22.12, real TCP: the test "(R1 / S1)" fails 3/3 runs with `['200','200','400']`, so the Node 22 CI job goes red. `slow?ms=300` + fast ×2 + garbage → `200,200,400`. A sync-write Duplex fails the same way, so Linux/macOS are affected too. Node 24 is correct. | Do not use `writableFinished`. A response that is still `_httpMessage` has not emitted `finish` (Node's `resOnFinish` runs first and detaches it). At :145-148, drop that condition; at :174, use `next && next !== pending`. Verified on Node 22 and 24, with real sockets and the Duplex. Add a test: `slow?ms=300`, `slow?ms=0` ×2, garbage → `[200,200,200,400]`. |
| T2 | minor (verified) | src/server/api.ts:206-209 | `writeClientError` now destroys the socket as soon as the reply is flushed, also on the immediate path where the socket is still reading. A client that is still sending (oversized header → 431, or a body still streaming) gets an RST and loses the reply. Before 38c7649 the immediate path only called `end()`. | Node 24, Windows: a 2 MB header in one write → 3/10 connections got `ECONNRESET` instead of a 431. With end + backstop only, 10/10 got the 431. The CLI never does this. Not a security issue: the backstop still bounds the socket. | Linger: call `socket.resume()` before `socket.end(payload)`, so the socket keeps reading and discarding and sees the FIN. Keep the 2 s backstop. Later chunks return at once (`deferred` / `!writable`), so Q3 does not come back. Verified: 431 delivered 10/10, pipelining gives `200,200,200,400`, connections = 0. Test: 2 MB header in one write → 431. |
| T3 | nit | docs/features/F-003-daemon-api-auth.md §3.4, §8 row 24 | The spec says the 400 comes "after every pending response" (true only on Node 24) and "destroy when the flush is done" (the T2 behaviour). | The docs contradict the Node 22 lane. | Update with the T1/T2 fixes. |

## Verified OK
- **`waitForResponses` listeners.** One `finish`/`close` pair per socket at a time; each handler removes its sibling. No `MaxListenersExceededWarning`. The `deferred` WeakSet still gives one deferral per socket (Q3).
- **Pending response that closes without `finish`.** `onClose` destroys the socket.
- **`Connection: close` response.** `destroySoon` is called, so `writeClientError` returns on `!writable` and the socket still closes.
- **Backstop.** 2 s, unref'd, cleared on `close`, and armed only after the earlier responses finished. Never more than one per socket.
- **R1/S1 leak fix.** On Node 24 and 22, 5 clients × (3 pipelined requests + garbage) → `getConnections()` = 0 and `app.close()` is fast.
- **R3 test.** Asserts `EUPGRADE`.
- **R4 test.** Passes on Node 24 and 22, taking about 7 s against a 10 s limit. That is tight on a slow CI runner.
- **Node 22.12 suites.** `daemon.test.ts` and `server.test.ts` pass. In `api-socket.test.ts` only the R1/S1 test fails (T1).
- **Unchanged and still fine.**
  - Host allowlist, origin-form check, OPTIONS, scope, CSRF.
  - Sessions, login code and proxy secret, the `browserLogin` 503.
  - `OneConnectionAgent`, reload-once, `send()`, `closeBounded`, exit codes, `main()`.
- **Not re-raised.** The accepted residual risks (N3, L3) and the requirements deferred to later features.

## Status
critical 0 · major 1 (T1) · minor 1 (T2) · nit 1 (T3)
