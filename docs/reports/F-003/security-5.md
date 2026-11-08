# Security review — F-003 — round 5

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | f49e1c0 (fixes under review: d0375ec) |
| Reviewer | fresh agent round 5. Probes were raw sockets against an in-process `createApi` and against a real `startDaemon` (temp `WEBHUB_HOME`). The attacker ran as a separate process. The real `connectDaemon` / `DaemonClient` played the legitimate CLI. |

**Verdict: FAIL** — 1 critical (availability only), 0 major, 0 minor, 1 info.

## Findings
| ID | Severity | Location | Issue | Attack scenario / PoC result | Fix |
|---|---|---|---|---|---|
| S1 | **critical** under R6 (exploitable now, no authentication needed, availability only; would be major without R6) | `src/server/api.ts` `clientError` deferral branch (`socket.pause()` + `pending.once("finish")` → `writeClientError` → `socket.end()`), from d0375ec (the Q3 fix) | The paused socket is never resumed or destroyed after `end()`. Node's HTTP server is `allowHalfOpen`, and a paused socket never reads the peer's FIN. When 2 or more pipelined requests sit behind the pending response, the next queued response owns the socket and never finishes. No keep-alive timer and no header/request timeout apply, so the connection holds one of the 256 `MAX_CONNECTIONS` slots forever. | One write per connection: `GET /api/v1/health` ×3 (no auth needed), then `\x00garbage\r\n\r\n`, then the attacker closes and exits. In-process: 20 connections still open after 70 s. Real daemon: still open after 182 s. 256 connections → the real CLI gets `DAEMON_UNREACHABLE ECONNRESET` until the daemon is killed or signalled. Unlike L3, the attacker keeps nothing open and the effect outlives the attacker. Browsers cannot send the malformed bytes, so the attacker is a local process. The existing L5/Q3 tests only check the client side. | Make sure the socket closes after the error is written: `socket.end(resp, () => socket.destroy())` plus an unref'd destroy timer as a backstop. Alternatives: `socket.resume()` before `end()`, or `destroy()` without a 400 when a response is pending. Test: requests ×3 + garbage → `getConnections()` reaches 0 within ~1 s and `app.close()` returns quickly. Add a row to spec §6. |
| S2 | info | same deferral path | Requests pipelined between the pending response and the garbage still run, but their responses are discarded and `onResponse` does not log them. PoC: handlers ran for `a,b,a,b,a`, the client got `slow`, `a` and the 400, and the log shows only `/slow` and `/a`. Only the sender's own requests are affected; there is no privilege gain. | Fixed together with S1 (destroy / stop parsing at the first parser error while a response is pending). Optional test: every executed request is logged. |

## Checked, no issue
- **Q3 fix:** the `WeakSet` stops listener pile-up and only one 400 is written. 401/200/400 come out in the right order. With a single request plus garbage, the 5 s keep-alive timer frees the socket (20/20 freed within 7 s).
- **Client `send()` (Q2):** settles exactly once. A `close` or `upgrade` rejects. The deadline and the 5 MB response cap work.
- **`OneConnectionAgent` / N2:** the bearer is sent only on the connection that passed the proof. A second connection attempt fails with `EPROOFLOST` before any byte is written. The agent is destroyed in `finally`.
- **hello HMAC oracle:** domain-separated (`webhub-hello:` / `webhub-proxy`), so the proxy secret cannot be derived.
- **`closeBounded`:** the forced close does not throw, `closeAllConnections` cuts leaked sockets, and `main()` exits when the close was not clean.
- **Host allowlist:** `hub.localhost:<apiPort>` and `webhub.internal:<port>` get 421. Duplicate Host headers are rejected. Absolute-form targets and `OPTIONS *` get 400.
- **Websites calling `127.0.0.1:7400`:** only side-effect-free GETs work. POSTs need a bearer or session (blocked at preflight). `/_webhub/login` needs the proxy secret.
- **CSRF:** Origin and Sec-Fetch-Site are checked. Only JSON bodies are accepted (others → 415).
- **Login links:** login-links return 503. The proxy secret is checked before the code is used. Codes are single-use, last 60 s and are capped. Sessions are capped, need cookie + key, and are bound to the host.
- **Errors and logs:** no stack traces, tokens, codes or cookies.
- **Daemon start / auth.json / lock:** correct.
- **Residual risks N3 and L3:** unchanged. S1 is a new, cheaper and persistent variant of L3; the L3 acceptance does not cover it.
- **Deferred items (not findings here):** Q1 (F-004/F-009), L4 (F-009/F-026), N4, N5 and Q6 (F-027).

## Not tested
- Cross-user port hijacking on Windows (`SO_REUSEADDR`); the per-connection proof limits the impact.
- `pnpm audit` (no network); real nginx; Linux / Node 22.
