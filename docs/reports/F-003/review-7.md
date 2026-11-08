# Code review — F-003 — round 7

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 80b9c42 |
| Reviewer | fresh agent round 7 |
| Checks run | build, typecheck and lint are clean. `pnpm test:full` (Node 24.20): 238 passed, 1 failed (the F-001 `store.test.ts:106` lock race — see V5), 5 skipped. F-003 suites on Node 22.12: 66/66. |
| Probes | Run against `dist/`: keep-alive stress, idle cut and an early reply followed by a stalled body. |

## Findings
| ID | Severity | file:line | Problem | Concrete failure scenario | Suggested fix |
|---|---|---|---|---|---|
| V1 | minor | test/integration/api-socket.test.ts:238 | The "never reads a large answer" test does not exercise the idle timeout. On Windows loopback the unread body fits in the kernel buffers, so the 5 s keep-alive timeout closes the socket (about 7 s) before the 15 s idle cut. | Removing `connectionTimeout` or the `timeout` handler still passes the test, so a U3 regression goes unnoticed. The real case is a handler that stays silent for more than 15 s. Measured: `slow?ms=20000` is cut at 15.0 s. | Add a test: `slow?ms=20000` → connection count = 0 between about 14 and 17 s. |
| V2 | minor | test/integration/api-socket.test.ts (no test) | Nothing guards against a legitimate keep-alive client being falsely treated as pipelining. That is the main risk of `refusePipelining`, because `busy` is cleared only on `finish`/`close`. | A future change that delays `finish` (streams, hooks, Node timing) would destroy the CLI's or nginx's sockets, and no test would fail. No false positive exists today. | Add a regression test: a keep-alive Agent sending hundreds of sequential requests with mixed sizes (up to 2 MB) and POST bodies, plus a raw socket that sends the next request the instant the last response byte arrives. Assert 1 connection and 0 errors. |
| V3 | nit | docs/features/F-003-daemon-api-auth.md:166, 227, 228 | Test row 24 and threat-model row S1 still describe the old test (pipelined ×3 → `[200,200,200,400]`). Row 24 is missing its type column, and row 25 has a duplicated `integration` cell. | Readers check the wrong expected values. | Rewrite the rows to match the current tests. |
| V4 | info | src/server/api.ts:279–283 | When a request is answered early (401/413) and its body then stalls, the idle handler skips it (`incomplete`). The socket lives until the 30 s request timeout, and a 408 follows the 401. | Measured: `401,408` at 30.3 s. This is bounded and matches the design (L3). | None needed. Optionally note it in spec §3.4. |
| V5 | info (outside F-003) | test/integration/store.test.ts:106 | The F-001 lock-race test fails under load. It passed 3/3 when run alone. | CI may go red on unrelated merges. It may also be a real race. | Track separately with a CR (F-001 is `done`, R1). First capture the racer outputs to tell flakiness from a real race. |

## Verified OK
- **No false pipelining for legitimate clients.**
  - Stress run: 1 500 sequential requests on a keep-alive Agent with mixed sizes up to 2 MB and POST bodies up to 200 KB, plus a raw socket sending each next request the instant the last response byte arrived.
  - Result on Node 24.20 and 22.12: 1 connection, 0 errors.
  - Why: `finish` comes from the final write callback, which always fires before the peer can read the whole answer and send its next request.
- **The CLI flow is unaffected.** `OneConnectionAgent` sends the request only after the hello response has ended.
- **Wrapping `request` is safe with Fastify 5.12.7.**
  - Fastify registers its handler at construction, and nothing adds a `request` listener later. If something did, the "pipelining is refused" test would fail.
  - `checkContinue` is not registered, so those requests pass through the wrapper. Upgrades without an `upgrade` listener also go through it.
  - `checkExpectation` and `clientError` never touch `busy`. `inject()` bypasses the wrapper (unit tests only).
- **`busy` bookkeeping is correct.**
  - `resOnFinish` runs first.
  - `close` comes on nextTick and never clears the flag of a later request.
  - Objects of a refused request die with the destroyed socket.
- **Existing behaviour still holds.** H10 (`onShutdown` through res `close`), H4 (503 on close) and `closeBounded` work as before.
- **Timeouts behave as documented.**

  | Case | Result |
  |---|---|
  | Keep-alive idle socket | closed at about 6 s |
  | Slow second keep-alive request | cut at 16 s |
  | No bytes sent | 408 at about 10 s |
  | Incomplete request | 408 at 30 s |
  | Silent handler | cut at 15 s (documented) |

- **`clientError` deferral is correct.**
  - At most one response can be pending.
  - Listeners and the 5 s bound are cleared on every path.
  - On `connection: close` it returns early.
  - Nothing depends on `writableFinished` any more.
- **`writeClientError` is correct.** After `resume()` + `end()`, later parser errors return at once, and the backstop is cleared on `close`. The T2 test passes repeatedly.
- **Rest of the feature is unchanged since round 6 and matches the spec and DESIGN §10.3.** This covers `daemon.ts`, `client.ts` and the hook order.
- **Docs.** Spec §3.4/§6 and PLAN F-004/F-027 match the round-7 behaviour, except V3.

## Status
critical 0 · major 0 · minor 2 (V1, V2) · nit 1 (V3) · info 2 (V4, V5 — V5 outside F-003)
