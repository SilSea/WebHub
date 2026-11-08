# Security review — F-003 — round 8

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 64c9326 (fixes under review: W1 `checkExpectation`/`checkContinue`, W2 `MAX_CONNECTIONS` 64, W3 404 in `onRequest`) |
| Reviewer | fresh agent round 8 |
| Setup | Real `dist/daemon.js` on Node 22.12.0, with a temp `WEBHUB_HOME` and a 2 GB heap, then a 1 GB heap. A wrapper logged the heap (also after GC) and the live sockets. The attackers were separate processes with no token. |

**Verdict: PASS** — 0 critical, 0 major, 1 minor, 4 info.

W1, W2 and W3 hold against the real daemon. No unauthenticated local client caused unbounded memory, a crash or a permanent hang through the HTTP surface.

## Findings
| ID | Severity | Location | Issue | Attack scenario / PoC result | Fix |
|---|---|---|---|---|---|
| Y1 | **minor** (latent until F-004 writes logs to a file; exploitable now only if a user redirects stdout to a file) | `src/server/api.ts` `onResponse` → `ctx.log({ path })` | The logged path has no length cap, even for 421 and 404 with no auth. A request line can be about 16 KB, so one log line can be about 16 KB. That is about 170× more bytes than U4 estimated. | 32 keep-alive sockets × `GET /aaaa…(15 000)` + `Host: evil`: 34 794 requests in 10 s, **525 MB written to stdout (about 52 MB/s)**. The daemon stayed healthy, but a redirected log fills the disk. | Cap the logged path (200 chars + `…(+N)`). For 421, log `(foreign host)`. Extend the F-004 requirement to a size cap. Test: a 15 KB path → log line under 512 B. |
| Y2 | info, latent (F-004) | `jsonLog` → `process.stdout.write` | On Windows, writes to a stdout pipe are synchronous. If the pipe's reader is still alive but stops reading, the next log line blocks the event loop forever (API, timers and shutdown all stop). Every unauthenticated request writes a log line. | A child writes 2 000 × 16 KB lines into a pipe that is never read: its ticker stopped, and its 5 s exit timer never fired. | PLAN F-004: spawn the daemon with stdout/stderr going to a file fd or `ignore`, never a pipe that the CLI keeps open. Alternative: an async log with a bounded queue that drops lines. |
| Y3 | info (accepted residual; the doc understates it) | spec §6 residual "DoS ทาง CPU" | A **continuous** reconnect flood keeps all 64 slots full, so legitimate clients get ECONNRESET for as long as it lasts. The spec only says "slow in waves of 2–3 s". | 128 or 64 workers: health 0/19. 16 workers: health 19/19, worst 1.6 s. Heap after GC stayed at 14 MB; no crash. | Doc only: a sustained flood makes the API unavailable for its duration (same class as L3), with bounded memory and immediate recovery. |
| Y4 | info, latent | `refusePipelining(app.server)`, `maxConnections`, the `timeout` handler | The guards are attached only to `app.server`. (1) If the daemon ever listened on a name that resolves to several addresses, Fastify would create secondary servers without any guard, bringing back U1. (2) A plugin that adds its own `server.on("request")` would bypass the guard. | Not exploitable now: the daemon always listens on the literal `127.0.0.1`. | Add a comment and a test asserting that `app.server` is the only binding. State in the spec that new listeners must go through `admit`. |
| Y5 | info, latent (F-027) | no `upgrade` listener today | Once F-027 adds an `upgrade` listener: (a) Node emits `upgrade` instead of `request`, so that handler must go through `admit` + `checkUpgrade`; (b) WebSocket sockets leave the http timeouts but still count toward the 64. | Today: an Upgrade request goes through the guard, and the socket is cut by the timeouts within 12–34 s. | PLAN F-027: the upgrade handler goes through the busy check; set a WebSocket idle/ping timeout; cap WebSockets per host below `MAX_CONNECTIONS`. |

## Checked, no issue
- **W1:**
  - `Expect: x` gets one 417 with every security header and `connection: close`.
  - Pipelined ×2 000: one 417, then the socket is destroyed.
  - `100-continue` pipelined ×2 000: one 100, then destroyed.
  - Flood of 250 sockets × 40 000 requests: 64 accepted, peak 226 MB, the API still answers. Round 7 measured 1.15 GB.
- **W2:** 250 × 4 000 tiny GETs: 64 accepted, peak 226 MB, immediate recovery. Heap after GC: 14–15 MB. With a 1 GB heap: no OOM.
- **W3:** invalid JSON to an unknown path gets 404. GET routes never parse a body. No unauthenticated body-parse path remains.
- **Other paths:**

  | Path | Result |
  |---|---|
  | CONNECT | destroyed |
  | `OPTIONS *` / HEAD / unknown path / foreign Host, pipelined | destroyed after at most one response |
  | `dropRequest` | not reachable |
  | Never-read sequential requests | cut once the send buffer fills; heap stays at 18 MB |

- **Chunked / smuggling:**
  - 60 KB of trailers or chunk extensions: 401, then close.
  - An endless chunked body: cut at 35 s.
  - CL+TE, `TE: chunked, identity`, a space before the colon, obs-fold, bare LF and a duplicate Content-Length all get 400 + close.
- **No permanent hang:** with held upgrade sockets present, `POST /shutdown` still gives exit 0 after 5 s, with auth.json and the lock removed.
- **Host allowlist:**
  - These get 421: duplicate Host, trailing dot, `user@host`, `[::1]`, integer IP.
  - Case differences are normalised and accepted.
  - The regex runs in linear time.
- **CSRF:**
  - Bearer + `Origin: evil` gets 403, and bearer + `Sec-Fetch-Site: cross-site` gets 403.
  - OPTIONS gets 405.
  - `text/plain` and form bodies get 415.
  - Duplicate headers do not match.
- **Sessions:**
  - The IP host gets 401.
  - A session from another host is rejected.
  - At most 8 cookies are read, and the key is compared in constant time.
  - Logout needs session + Origin.
- **Login codes / proxy secret:**
  - No proxy header gets 401 and the code is not used up.
  - A `t` array is rejected.
  - `X-Forwarded-Host` must be a single session host.
  - login-links gets 503, and HEAD on the login route gets 404.
- **Bearer / hello:**
  - Lowercase `bearer` gets 401.
  - With a duplicate Authorization header, Node keeps the first.
  - `/status` on internal gets 404.
  - The HMAC is domain-separated.
  - The client binds the proof to one connection, caps responses at 5 MB, has a deadline, and treats 101 as an error.
- **Logs:**
  - No token in stdout or stderr.
  - The query is stripped.
  - 5xx logs only the class name.
  - The only gap is Y1.
- **auth.json:**
  - Written with tmp + rename under the user-only home.
  - Removed only when it holds our token.
- **Residual risks:** N3, L3 and the W2 CPU residual are unchanged, apart from the doc note in Y3.

## Not tested
- An attacker running as another Windows user.
- A machine with under 8 GB of RAM (simulated with a 1 GB heap); Linux.
- Real nginx and browsers; `pnpm audit`.
- Console (TTY) writes under the Y1 flood.
- WebSocket (there is no upgrade listener in F-003 yet).
