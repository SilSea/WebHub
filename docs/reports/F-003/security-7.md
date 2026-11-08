# Security review — F-003 — round 7

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 80b9c42 (fixes under review: U1 `refusePipelining` + 15 s idle timeout, U2 5 s defer bound, T2 `resume()`+`end()`) |
| Reviewer | fresh agent round 7 |
| Setup | Real `dist/daemon.js` on Node 22.12.0 with a temp `WEBHUB_HOME` and a 2 GB heap (one run with 1 GB). A wrapper logged memory and the heap after GC. The attackers were separate processes with no token. |

**Verdict: FAIL** — 2 major, 1 minor, 2 info.

W1 is exploitable now and bypasses the U1 control. It also breaks the premise on which L3 was accepted ("memory does not grow"). It affects availability only, and the daemon did not crash. Under a strict reading of R6 it may be raised to critical, as U1 was.

## Findings
| ID | Severity | Location | Issue | Attack scenario / PoC result | Fix |
|---|---|---|---|---|---|
| W1 | **major** (critical under strict R6). Exploitable now with no auth, availability only, memory bounded at about 1.2 GB, no crash. | `src/server/api.ts` `refusePipelining`, which covers only the `request` event; Node `parserOnIncoming` | An `Expect:` header with any value other than `100-continue` bypasses `refusePipelining`. There is no `checkExpectation` listener, so Node answers `417` itself and never emits `request`. Pipelined requests of this kind are never refused. They queue in `state.outgoing` until Node's backpressure pauses the socket after the current 64 KB chunk: about 2 000–2 300 req+res pairs, about 4.5 MB per socket. These 417s also skip the Host allowlist and `SECURITY_HEADERS` (cosmetic only; browsers cannot set `Expect`). | `Expect: x` ×3 → three 417s on one socket. **Flood of 250 sockets, never read:** event loop blocked about 20 s, heap after GC 413 MB. **Held indefinitely** (32-byte requests so each chunk ends on a request boundary, plus a 2 ms read every 4 s so the idle timer never fires): 240–254 sockets for 60–90 s → heap after GC up to 1 146 MB, peak 1 199 MB. 222 sockets were never cut. GC stalls of 2–8 s, and health failed for about 15 s at the start of each wave. With a 1 GB heap: peak 1 043 MB, a 10 s stall, survived. | Register `checkExpectation` and route it through the same busy check: if busy, destroy; otherwise write a raw 417 with `SECURITY_HEADERS` and close. PoC with the listener: every request reaches the guard. Also register `checkContinue` so the path cannot change under a future Node version. Lower `MAX_CONNECTIONS` (W2). Tests: `Expect: x` ×3 → destroyed, ≤ 1 response; flood → heap bounded, connections = 0. Update spec §3.4/§6. |
| W2 | **major** (exploitable now, availability only; memory is transient and the daemon recovers) | `refusePipelining` (`socket.destroy()`) and `MAX_CONNECTIONS = 256` | `destroy()` does not stop the parser. Node's C++ parser still runs over the rest of the current 64 KB chunk. For each remaining request it builds `IncomingMessage` + `ServerResponse` and emits `request`, which the wrapper then drops. Every socket whose chunk arrives in the same poll phase is parsed before any close runs, so all these objects are alive at once. The spec's claim "before Fastify builds anything" is true, but Node builds about 3 600 objects per chunk of 18-byte requests. `parser.pause()` does not help. | 250 sockets × `GET / HTTP/1.1␍␊␍␊` (18 B): heap peak **844 MB**, event loop blocked **13 s** per wave. **Continuous reconnecting (about 117 000 connections in 40 s):** health answered 0 of 39 checks. Part of this is the connect flood itself (listen backlog), which app code cannot prevent. The parse is the amplifier: about 50 ms of CPU per 64 KB. The daemon survives and recovers. | Cost grows linearly with the number of sockets, so lower `MAX_CONNECTIONS` to real need: CLI 1–2 + browser 6/host + nginx. For example 32–64 → peak about 105–210 MB and a 2–3 s stall per wave. Optional: an accept-rate cap in a prepended `connection` listener. Document the residual (a local process can burn daemon CPU) in §6 next to L3. Test: heap bounded under a one-chunk flood × MAX_CONNECTIONS. |
| W3 | minor (CPU only) | `onRequest` hook: `if (req.is404) return;` | An unauthenticated POST to an unknown path has its body read (up to 1 MB) and `JSON.parse`d before the 404. Known routes deny before parsing. | 250 sockets × 1 MB `[{},…]` → about 45 ms of CPU per request, about 11 s stall per wave. Heap stayed at about 21 MB. | Answer 404 directly in `onRequest`. Test: invalid JSON to an unknown path → 404 (not 400). |
| W4 | info | V8 / process | After a flood, RSS stays at 1.1–1.47 GB while the heap is back to 14 MB. | Seen in every run. | No change needed; fixing W1/W2 lowers the peak. |
| W5 | info, latent | server `timeout` handler | It destroys a socket that has been silent for 15 s even while the handler is still running. A future long route (e.g. waiting for Docker) would be cut. This is already a documented requirement (keep-alive bytes, PLAN F-004). | — | Keep the requirement. For long work, answer 202 and let the client poll. |

## Checked, no issue
- **Slow and holding sockets** behave as designed:

  | Case | Result |
  |---|---|
  | Request complete, never read | closed at 6 s |
  | No bytes sent | 408 at 11 s |
  | Headers trickled | 408 at 11 s |
  | Body or chunked body trickled | 408 at 30 s |

  No way was found to keep a request incomplete past the timers.
- **U2 bound:** at most one timer per socket, cleared on every path. Memory returned to the 14 MB baseline after each run.
- **CONNECT and Upgrade:**
  - CONNECT has no listener, so Node destroys the socket.
  - A request with an `Upgrade:` header goes through the wrapper.
  - `Expect: 100-continue` goes through the wrapper.
- **Header size:** a header over 16 KB gets 431.
- **JSON body tricks:** deep nesting and `__proto__` are parsed iteratively, with no stack overflow.
- **Bearer fail delay:** at most one request in flight per socket.
- **Hello / proxy secret:** domain-separated, so the hello oracle cannot produce the proxy secret.
- **Daemon survival:** the daemon survived every run with no OOM. auth.json and the lock stayed correct.
- **Unchanged since round 6:** Host, CSRF, sessions, login-links, proxy secret, logs, `closeBounded`, client proof.
- **Residual risks:**
  - N3 and L3 are unchanged.
  - L3's premise only holds again after W1 and W2 are fixed.
  - Items deferred to later features are not findings here.

## Not tested
- A machine with less than 8 GB of RAM (simulated with a 1 GB heap); Linux.
- An attacker running as another Windows user.
- Real nginx and browsers; `pnpm audit`.
- A lower `MAX_CONNECTIONS` against the real daemon.
