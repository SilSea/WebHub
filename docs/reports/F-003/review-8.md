# Code review — F-003 — round 8

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 64c9326 |
| Reviewer | fresh agent round 8 |
| Checks run | build, typecheck and lint are clean. `pnpm test:full` (Node 24.20): 245 passed, 5 skipped, 0 failed. F-003 suites on Node 22.12: 72/72. Running `api-socket` 3× in parallel alongside `daemon.test.ts` also passed. |
| Probes | Run against `createApi` from `dist/` on a real socket, on Node 24.20 and 22.12. Results were identical on both. |

## Findings
| ID | Severity | file:line | Problem | Concrete failure scenario | Suggested fix |
|---|---|---|---|---|---|
| X1 | minor | test/integration/api-socket.test.ts ("Expect: 100-continue …") | No test covers the `checkContinue` path refusing pipelining. If `admit()` were dropped from `checkContinue` while the listener stayed, every test would still pass. | A refactor reopens the W1 class of bypass and nothing fails. Today's behaviour is correct. | Add a test: pipelined `Expect: 100-continue` (×3 and ×2 000) → `counted ≤ 1`, socket destroyed, connections = 0. |
| X2 | minor | docs/PLAN.md F-009, F-027; src/server/api.ts:95–99 | `MAX_CONNECTIONS` 64 is a budget shared by the CLI, browsers, nginx upstream connections and WebSockets. The PLAN rows of the features that will use it do not mention it. | F-027 opens one WebSocket per stream, or F-009 sets up a large keepalive pool → the cap is reached and the CLI gets `DAEMON_UNREACHABLE`. Probe: the 71st socket got `ECONNRESET`. | F-009: keep the upstream keepalive pool well below 64. F-027: one multiplexed WebSocket per tab. Note this in spec §3.4. |
| X3 | nit | src/server/api.ts:1–10 header comment; spec §3.4 | The 417 reply comes before the Host check, the 503 and the log. The file header still says every request passes Host first, and its list of steps is missing the 404. | A future feature might rely on "Host first for every request" or "every request is logged". | Update the header comment (put the 404 step in the order and list the exceptions: parser errors and the 417). In spec §3.4, state that the 417 comes before Host and is not logged. |
| X4 | nit | api-socket tests: 100-continue (`wait(200)`); W2 (literal 60) | The 100-continue test sleeps a fixed time. The W2 test opens a literal 60 sockets instead of using `MAX_CONNECTIONS`. | Rare flake on slow CI; coverage is lost if the constant is lowered. | Wait for the first `data` event; open `MAX_CONNECTIONS - 4` sockets and assert none get ECONNRESET. |
| X5 | info | src/server/api.ts:347 | The 404 in `onRequest` means a scoped `setNotFoundHandler` can never run, for example an SPA fallback. | F-027 deep links get a JSON 404. | Add to PLAN F-027: the SPA fallback must be an explicit wildcard route. |
| X6 | info | src/server/api.ts:249–253 | `100 Continue` is sent before the Host, auth and route checks. This is Node's default and is unchanged. | Costs bandwidth and CPU only; the body is drained, not parsed. | Optional: call `writeContinue()` from a `preParsing` hook instead. |

## Verified OK
- **`checkContinue` / `checkExpectation`.** Both go through `admit()`, and `busy` is cleared on every path. When a listener exists, Node emits only `checkContinue`, so `run()` sees each request exactly once. Identical on Node 22 and 24. Probes:

  | Case | Result |
  |---|---|
  | Slow request + pipelined `Expect: x` | destroyed, 0 responses |
  | `Expect: x` ×2 000 | ≤ 1 × 417 |
  | POST with a body + `Expect: x` | 417, then close |
  | HTTP/1.0 + `Expect: x` | 200 |
  | Any 417 | carries the security headers and `connection: close` |

- **404 in `onRequest` (W3).** Behaviour is unchanged apart from the body no longer being parsed (`is404` already returned before the scope and auth checks). Probes:

  | Request | Result |
  |---|---|
  | HEAD to an unknown path | 404, logged |
  | OPTIONS to an unknown path | 405 |
  | Unknown Host | 421 |
  | `webhub.internal` + unknown path | 404 |
  | Known path, wrong method | 404 |
  | `HEAD /_webhub/login` | 404 |

  An unread body is drained, and the next keep-alive request gets 200. 2 000 pipelined POSTs → 1 response, then destroyed.
- **`MAX_CONNECTIONS` 64.** Excess sockets are dropped and service resumes once slots free up. The client maps ECONNRESET to `DAEMON_UNREACHABLE` (not NOT_RUNNING).
- **The new tests are meaningful.** W1 ×2 000 and W3 fail without the changes. V1 exercises the real 15 s idle cut. V2 is sound. No flakes in 3 parallel runs plus 2 full-suite runs.
- **Docs.** Spec §3.4/§6, the residual policy, test row 26, rounds table row 8, PLAN §0/§5: consistent, except X3.
- **Whole feature.** Unchanged since round 7 and matches the spec and DESIGN §10.3:
  - Hook order: Host → 503 → origin-form → OPTIONS → 404 → scope → auth → CSRF.
  - Sessions, login links, the `clientError` deferral, timeouts and `closeBounded`.
  - The daemon lifecycle and the client proof.
- **Not raised again.** The accepted residuals and the deferred items.

## Status
critical 0 · major 0 · minor 2 (X1, X2) · nit 2 (X3, X4) · info 2 (X5, X6)
