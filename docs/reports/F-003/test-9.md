# Test report — F-003 — round 9

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit) — fixes for the minor/nit/info items of review-8 and security-8 |
| User decision | "แก้ทั้งหมดแล้ว merge" (no review round 9) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite) and Node 22.12.0 (F-003 suites). pnpm 12.9.1, fastify 5.12.7. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| F-003 suites (`api-socket`, `daemon`, `server`), Node 22.12 | 75 | 0 | 0 |
| Full suite, Node 24.20 (two runs) | 247 | **1** | 5 |

Lint, typecheck, build and `pnpm audit` (high) pass.

**The one failure is F-001, not F-003.** It is the test "4 processes taking over the same stale lock → exactly one wins" (`test/integration/store.test.ts:106`). It failed in both full-suite runs:

- the failure is an assertion, not a timeout: `expected [ 'WON', 'WON' ] to have a length of 1 but got 2`;
- the test passes when run alone;
- a scratchpad spike (`f001-race/`) ran 8 rounds × 4 racers against `dist/store/lock.js`, with timestamps, while 12 processes burned the CPU. Every round had exactly one winner, so the problem was not reproduced outside the suite.

**Hypothesis (not proven).** The racer holds the lock for only 2 s. Under load, a slow racer's `isStale` call (PowerShell CIM) can take longer than that. The first winner then releases the lock, and the slow racer legitimately takes the now-free lock afterwards. That would be two winners one after the other — a test-design problem, not a mutual-exclusion bug.

**This is the V5 follow-up in PLAN §0.** It needs read-only investigation and then a CR, because F-001 is `done` (R1).

## Changes and tests per finding
| Finding | Change | Test | Fails without the change |
|---|---|---|---|
| Y1 (minor) | `logPath`: the logged path is capped at 200 characters plus a `…(+N)` marker, and a foreign Host (421) is logged as `(foreign host)` | A 15 KB path is logged with `…(+N)`; a foreign Host is logged as `(foreign host)`; every log line is under 512 B | yes |
| X1 (minor) | — | Pipelined `Expect: 100-continue` ×3 and ×2 000 → the handler runs at most once, and the connection count drops to 0 | yes (with `admit` removed from `checkContinue`) |
| X2 (minor) | PLAN F-009: the nginx upstream keepalive pool must stay well below 64. PLAN F-027: one multiplexed WebSocket per tab. Spec §3.4: the 64 connections are a shared quota | — | — |
| X3 (nit) | The `api.ts` header comment now gives the full order (503 and 404 steps) and lists what is answered before Fastify (parser errors, 417). The same is stated in spec §3.4 | — | — |
| X4 (nit) | The 100-continue test now waits for the 100 bytes instead of a fixed time. The W2 test opens `MAX_CONNECTIONS - 4` sockets and checks that all of them were accepted (`connection`) and none were dropped (`drop` = 0) | (in the tests) | — |
| Y4 (info) | Header comment and spec §3.4: one listen address only; every new listener must go through the busy check | `app.addresses()` = 1 (`127.0.0.1`) | — |
| Y2 (info) | PLAN F-004: send the daemon's stdout/stderr to a file or `ignore`, never to a pipe; cap the log size in bytes | — | — |
| Y3 (info) | Spec §6 residual risk: a continuous flood makes the API unusable for as long as it lasts, with memory bounded and recovery as soon as it stops | — | — |
| Y5 / X5 (info) | PLAN F-027: the WebSocket `upgrade` handler goes through the busy check, has an idle/ping timeout and a per-host cap; the SPA fallback must be a wildcard route | — | — |
| X6 (info) | Not changed (Node's default behaviour; costs bandwidth only) | — | — |
