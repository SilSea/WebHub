# Security review — F-003 — round 6

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 38c7649 (fixes under review: S1/R1, R2) |
| Reviewer | fresh agent round 6. Built HEAD with `pnpm build`. A separate attacker process sent raw sockets to an in-process `createApi` (from `dist/`) and to a real `dist/daemon.js` running with a temp `WEBHUB_HOME`. `api-socket.test.ts` + `server.test.ts`: 48/48 pass. |

**Verdict: FAIL.** 1 critical (availability only), 1 major (latent), 1 minor, 1 info.

## Findings
| ID | Severity | Location | Issue | Attack scenario / PoC result | Fix |
|---|---|---|---|---|---|
| U1 | **critical** under R6. Exploitable now by a local process with no auth. Availability only; would be major without R6. | `src/server/api.ts` `createApi`. Present since round 1. | No limit on pipelined requests in flight per socket, and no socket idle timeout (`connectionTimeout` = 0). Node parses every pipelined request in a chunk and builds `IncomingMessage` + `ServerResponse` + Fastify request/reply for each one. When the client never reads, all of this stays in memory: about 25–55 KB per request, 10–20 MB per connection. `MAX_CONNECTIONS` does not cap memory. The cheapest request is 26 bytes (`GET / HTTP/1.1\r\nHost:x\r\n\r\n` → 421), with no auth and no valid host. | 256 sockets × 40 000 tiny pipelined requests, never read. **Real daemon, 2 GB heap:** `JavaScript heap out of memory` (exit 134) in about 12 s. `health` gets no answer during the attack. auth.json and the lock are left behind. **Default 4.5 GB heap:** survived at 2.5 GB. In-process with 201 connections: 3.9 GB, event loop stalled about 20 s. **20 slow readers:** 190 MB held. This goes beyond L3: the daemon dies or freezes, and the API port is left free for an impostor (the hello proof still protects the token). | Cap in-flight requests per socket before Fastify runs: wrap the server's `request` listener with a `WeakMap<Socket, count>`. When a socket goes over N (e.g. 8), `destroy()` it and drop its later requests. Decrement on `res` `close`. Add an idle timeout of 15–30 s. **PoC with cap 8 + timeout 15 s:** amp ×256 → sockets closed at once, peak 377 MB, back to 13 MB; slow readers cut; S1 scenario still OK. Weaker alternative: `maxRequestsPerSocket = 32` + timeout (peak about 1 GB). Tests: heap bound, idle cut, pipelining up to N still works. Add a row to §6. |
| U2 | **major, latent** (becomes critical under R6 once a long-running route exists) | `clientError` deferral (`socket.pause()` + `waitForResponses`) | While the 400 is deferred, the socket is paused and never sees the client's FIN. If the pending response is long-running (stream, long-poll, SSE), the socket is held until that handler ends, possibly forever. Without garbage, Node reads the FIN, aborts the request and frees the socket. | Registrar route that waits 1 h. 20 clients each send `wait` + health + garbage, then `end()` and exit → 20 sockets still held after 25 s. The same requests without garbage → 0 held. Not exploitable on HEAD: every F-003 route finishes in ≤ 50 ms. DESIGN plans `webhub logs -f`. | Time-bound the deferral: an unref'd timer (a few seconds, ≤ `REQUEST_TIMEOUT_MS`) destroys the socket; clear it in `writeClientError`. Alternatives: destroy without a 400, or keep reading and discard instead of pausing. Test: long route + garbage + FIN → connections = 0 within the bound. Add a requirement for streaming routes to spec/PLAN. |
| U3 | minor (docs, R4) | spec §6 rows "slowloris / open sockets" and L3 | The header/request timeouts cover only requests still being received. A client that sends complete requests and then stops reading is cut by no timer: keep-alive starts only after a flush, and `connectionTimeout` = 0. So the mitigation L3 relies on does not cover a slow reader. | 20 sockets × pipelined health, no reads → held for as long as the attacker holds them. Slot-holding itself falls under the accepted L3; only the stated mitigation is wrong. | Fix the §6 text; fixed together with U1 (idle timeout). |
| U4 | info, latent (F-004) | `src/daemon.ts` / `ctx.log`: one line per request, unauthenticated requests included | A local flood writes about 3 000 lines per second to stdout (38 721 lines in about 12 s). Once F-004 writes stdout to a file without rotation, this can fill the disk. | Seen in the U1 PoC. | F-004: rotate or cap the log, or aggregate repeated 4xx lines. U1's cap helps too. |

## Checked, no issue
- **S1 fix:** 50 connections × (health ×3 + garbage), then the attacker exits → connections = 0 within ≤ 6 s. The backstop is unref'd and cleared on `close`. `end(…, destroy)` closes even a paused socket.
- **Slow reader + garbage, then the attacker exits:** all sockets are freed (RST via the pending write), and the heap returns to 15 MB.
- **R2 chain / ordering:** `401,401,200,401` + garbage → the 400 comes last and nothing is lost. `Connection: close` in the middle → closes cleanly. HTTP/1.0 + garbage → OK. Only one pair of listeners is attached at a time.
- **Q3:** the `WeakSet` stops repeated parser errors and repeated timeouts while deferred. Listeners do not pile up.
- **TE + CL smuggling** on `POST /shutdown` → 400, no shutdown.
- **CONNECT / Upgrade without a listener:** Node handles these, and the client's `EUPGRADE` is asserted.
- **Unchanged and still fine:** Host allowlist, origin-form check, OPTIONS, scope, CSRF, sessions, login-links 503, proxy secret, error bodies and logs, `closeBounded`.
- **Residual risks:** N3 and L3 are unchanged; U1 is not covered by L3. Q1, L4, N4, N5 and Q6 are deferred to later features and are not findings here.

## Not tested
- A real 8 GB machine (simulated with `--max-old-space-size=2048`); Linux / Node 22.
- An attacker running as a different Windows user (loopback TCP is reachable the same way).
- Real nginx / browsers (browsers cannot pipeline, so U1/U2 need a local process); `pnpm audit` (no network).
