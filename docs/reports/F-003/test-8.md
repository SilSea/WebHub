# Test report — F-003 — round 8

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | (this commit) — fixes for review-7 and security-7 |
| User decisions | W1 + W2: "fix it, and close the DoS round". Minor/nit: "แก้ทั้งหมด". V5: "investigate, then open a CR". |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite) and Node 22.12.0 (F-003 suites). pnpm 12.9.1, fastify 5.12.7. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| All tests (unit + integration, F-000 – F-003), Node 24.20 | 245 | 0 | 5 |
| F-003 (`api-socket`, `daemon`, `server`), Node 22.12 | 72 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) all pass.

## Changes and tests per finding
| Finding | Change | Test | Fails without the change |
|---|---|---|---|
| W1 (major) | `refusePipelining` now also handles `checkContinue` and `checkExpectation`, both through the same busy check. Any `Expect` other than `100-continue` gets a 417 with the security headers and `connection: close`. | (1) `Expect: x` → 417 with nosniff. (2) The same request ×2 000 pipelined → at most one 417, connection count back to 0. (3) `Expect: 100-continue` → 100, then 200. | yes |
| W2 (major) | `MAX_CONNECTIONS` lowered from 256 to 64. The remaining CPU DoS is recorded as a residual risk in spec §6, with the policy the user chose (a local DoS that the daemon survives and recovers from is minor; a crash, unbounded memory or a permanent hang is still critical). | (1) 60 sockets, each sending one chunk of 3 600 tiny requests → all cut, and the API still answers. (2) The `maxConnections` value is 64. | — |
| W3 (minor) | An unknown route is answered with 404 in `onRequest`, before any body is read. | Invalid JSON sent to an unknown path → 404 (not 400). | yes |
| V1 (minor) | New test: a handler that stays silent for 18 s → the socket is cut at 14–17.5 s. The 4 MB test is kept and renamed ("keep-alive or idle"). | Same as the change. | yes (with `connectionTimeout` removed) |
| V2 (minor) | New regression test: a keep-alive Agent makes 150 requests (answers from 0 B to 2 MB, POST bodies up to 200 KB) and they all use 1 connection. A raw socket then sends 150 requests, each one the moment the last answer byte arrives, and none is cut. | Same as the change. | — (guards against future changes) |
| V3 (nit) | Spec §6 row S1 and test rows 24 and 25 corrected; row 26 added. | — | — |
| V5 (info, F-001) | Recorded in PLAN §0 "ติดตามต่อ": after F-003, investigate read-only, then propose a CR (W2). F-001 code is untouched (R1). | — | — |
| W4 / W5 (info) | W4 is mentioned in the residual-risk text. W5 is already a requirement (keep-alive bytes / 202 + poll). | — | — |

## Not run
- Heap measurement against the real daemon with 64 connections (the effect is linear by construction).
- Linux and macOS.
- Real SIGINT, SIGBREAK and SIGHUP on Windows.
- Browser and nginx (F-009, F-027).
