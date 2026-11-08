# Security review — F-003 — round 4

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 299c6d2 |
| Reviewer | fresh agent; raw sockets vs in-process `createApi` (built from HEAD), headless Chrome 156 (dual-stack relay), spawned client / daemon processes, event-loop lag from a separate process, Windows bind matrix |

**Verdict: FAIL** — critical 0, major 2, minor 2, info 2. N2 holds; N1 holds only while nginx is absent.

## Findings
| ID | Sev | Location | Issue | Exploit scenario | Suggested fix |
|---|---|---|---|---|---|
| Q1 | **major** (verified, Chrome; latent — **critical** once F-009 enables `browserLogin` under the current requirements) | api.ts `/_webhub/login` proxy check; spec §3.3 N1 requirements; §6 | `X-Webhub-Proxy` proves the request passed through nginx, not that the user's browser sent it. Windows lets another socket bind the same http port on another loopback address (`[::1]:S` next to nginx on `127.0.0.1:S`, or `127.0.0.1:S` next to `0.0.0.0:S`); Chrome resolves `hub.localhost` to `[::1]` first | A: nginx on 127.0.0.1:S, squatter on [::1]:S → Chrome sends the link to the squatter → relays `?t=` to 127.0.0.1:S → nginx adds the secret → 303 cookie + `#k=` → `/api/v1/status` 200 (via nginx and direct); user sees a fake dashboard. B: nginx on 0.0.0.0, squatter on 127.0.0.1, relay via 127.0.0.2 → same. Squatter stays a MITM of the hub origin | F-009: nginx binds every address `hub.<suffix>` resolves to (`127.0.0.1:S` **and** `[::1]:S`), never only a wildcard; before enabling `browserLogin` and before every login link (F-004) the daemon checks that **every** listener on port S (v4/v6, wildcard + specific) is webhub's nginx, else 503; document the residual race; §6 rows + tests |
| Q2 | minor (verified) | client.ts `send()` (`close` clears the deadline, no `upgrade` handler) | hello answered with `101` + `Upgrade` → Node destroys the socket without `response` / `error`; the deadline is cleared → promise never settles | impostor on 7400 answers 101 → `verify()` / `request()` pending > 25 s; CLI event loop empties → **exit 0, nothing printed** (`webhub daemon stop` "succeeds"). No token sent | `settled` flag, reject on `close` without result; `upgrade` handler destroys + rejects; test |
| Q3 | **major** (verified, latent — F-003 routes cap the window at ~50 ms) | api.ts `clientError` deferral | every unparsable chunk while a response is pending adds a `once` pair; no cap per socket → linear memory, then O(n²) synchronous listener removal on finish | one unauthenticated connection: slow route + 1-byte garbage writes — 500 ms route → 26k listeners → 3.0 s event-loop freeze; 1 s → 55k → 21.5 s; 3 s → 147k, ~150 MB. F-003 wrong-bearer window (50 ms) → 2.4k, 22 ms. A later slow route (e.g. F-013 `/_wake`) = one-connection daemon freeze; `maxConnections` does not help | defer at most once per socket and stop reading after the first parser error, or destroy the socket when a response is pending; test listener count ≤ 1 |
| Q4 | minor (verified) | daemon.ts `main()` after `stopped {clean:false}`; lock released after the race | close timeout → auth.json removed, **lock released, process keeps running**; with a hung `preClose` the port stays open (503) | later feature's never-resolving hook → after 12 s still alive; **a second daemon starts on the same home** while the first runs (single-writer broken); preClose case → restart exit 4. Not attacker-triggerable in F-003 | `main()`: `process.exit(1)` when not clean; or release the lock only after a real close / in the exit path; spawned-process test |
| Q5 | info | `/_webhub/login`; F-009 | proxy secret fixed for the daemon's life, travels on every forwarded request; an impostor on 7400 (L4) learns it (useless after restart) | — | F-009: never log request headers; forward only to the daemon; later: per-request HMAC (method + path + nonce) |
| Q6 | info | auth.ts `checkUpgrade` | `delay` advisory; target / method / `Sec-WebSocket-Version` not checked | — | F-027: apply delay, reject absolute-form, echo only `protocol`; test when wired |

## N1 / N2 attack matrix
- N1 (`probe-n1.mjs`): 401 and code not burned for no / wrong / other-token header, hello-HMAC as secret, duplicate headers both orders, `webhub.internal` + XFH without secret, IP host + fake secret, XFH / XFF on api host, TE chunked smuggling, `%6c` path; HEAD / `/login/` / upper-case → 404; obs-fold → 400; afterwards a valid secret still redeems (303). Secret not derivable from hello, not in responses or logs; constant-time. Real daemon: login-links → 503.
- N2 (`probe-n2.mjs`, server knowing the token): proof + FIN with a second listener racing, `Connection: close`, HTTP/1.0, `Keep-Alive: timeout=1` + RST, 100-continue, pipelined extra response, chunked + garbage, 302 on hello, 3 s slow proof, next-tick destroy, short body — 1 connection each; bearer only on the proven socket or not at all. 101 = Q2 (hang, not leak).

## Status of earlier findings
K1 closed · K2 closed · K3 open → F-004 · K4 closed · K5 closed · K6 superseded by N3 · K7 closed · K8 closed · K9 accepted · K10–K12 OK · L1 closed · L2 closed · L3 accepted · L4 open → F-009 / F-026 (widened by Q1) · L5 closed for ordering (deferral → Q3) · L6 info · N1 partly (absent nginx OK; open by design with nginx — Q1; not live) · N2 closed · N3 accepted · N4 / N5 documented → F-027 · N6 closed.

Not tested: cross-user binding next to a wildcard nginx (the `[::1]` variant does not depend on it); real nginx; Firefox / Edge address preference; real Windows signals; remote `uncaughtException`; Linux / Node 22.
