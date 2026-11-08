# Security review — F-003 — round 3

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | d00c28e |
| Reviewer | fresh agent; probes: in-process daemon (real sockets), headless Chrome via CDP (clobber / toss / none), raw request lines |

**Verdict: FAIL** — critical 1, major 1, minor 1, info 3.

## Findings
| ID | Sev | Location | Issue | Exploit scenario | Suggested fix |
|---|---|---|---|---|---|
| N1 | **critical** (verified at API level; live once anything opens the link, e.g. F-004 `webhub ui`) | api.ts `POST /api/v1/login-links` → `http://hub.<suffix>[:httpPort]/_webhub/login?t=`, `/_webhub/login`; spec §3.3 | The one-time code goes to whatever listens on httpPort (default 80); nothing proves it is webhub's nginx. The receiver redeems the code at `127.0.0.1:7400` (Host `hub.localhost`, or `webhub.internal` + XFH) → 303 gives cookie id **and** key. Before F-009 nothing of webhub owns :80; later nginx can be down; Docker / IIS / another OS user (no privileged ports on Windows) can hold it | squatter on httpPort stand-in receives `/_webhub/login?t=<code>`, redeems → 303 + `#k=` → `/api/v1/status` **200**; can also 302 the user to a fake dashboard. Same class as K1, inverse of L4 | code useless without proof of nginx (proxy secret header added by nginx, config written with user-only ACL; daemon redeems only with it); F-004 checks httpPort owner PID = webhub nginx before opening; login-links refused while F-009 absent; spec §3.3 / §6 + tests |
| N2 | **major** (verified) | client.ts `DaemonClient` (`#verified` cached, `agent:false` = new TCP connection per request) | Proof is per client object, not per connection: after one verify, later connections carry the bearer without re-proof; reset only after an error / 401 (token already sent). Contradicts §6 "CLI never sends the token to an impostor" for reused clients | `request(status)` → `request(shutdown)` → daemon exits → impostor binds the port → `request(status)` → impostor gets `Authorization: Bearer <token>` (verified). Another OS user can race the bind after any stop / crash | bind the proof to the connection (hello + request on the same keep-alive socket; bearer never on an unproven socket), or at minimum re-prove before every request (~1 ms); test |
| N3 | minor (verified, Chrome) | auth.ts `readCookies` / cookie design; spec claim "tossing cannot log out" | `hub.localhost:Q` answers `Set-Cookie: webhub_session=attacker; Path=/` → **overwrites** the hub cookie (same name / host / path; ports ignored). Also ≥ 9 values → all rejected | project page navigates to `hub.localhost:Q` → jar = attacker value → dashboard call with valid key 200 → **401** (forced logout). DoS only; no fixation without N1 | not preventable with plain-http host cookies; fix the spec claim, accept as residual risk; revisit with HTTPS + `__Host-` |
| N4 | info | spec "no Max-Age = gone when the browser closes" | Chrome "continue where you left off" restores session cookies + sessionStorage; URL with `#k=` lands in history before `replaceState` | persistence up to the 24 h cap; same-user profile only | document |
| N5 | info (requirement F-009 / F-027 / F-026) | `303 /#k=` | (a) fragment carries over redirects — if `/` on hub. ever redirects the key follows; (b) any script on hub./db. reads sessionStorage — DB Studio renders untrusted DB content → XSS = key theft | — | F-027: `/` never redirects, move key + clear first thing; strict CSP on hub. and db.; nginx serves only daemon content there |
| N6 | info | api.ts `frameworkErrors` | logs `status: 400` even when answering 421 | log accuracy | log the real status |

## Earlier findings
K1 closed · K2 closed · K3 open → F-004 (widened by N1) · K4 closed (with L2; not re-timed) · K5 closed · K6 superseded by N3 · K7, K8 closed · K9 accepted (24 h) · K10–K12 OK · **L1 closed for theft** (Chrome: listener on `hub.localhost:Q` gets only the cookie id, empty sessionStorage, Referer null; cookie only / key only / swapped → 401) · L2 closed · L3 accepted · L4 open → F-009 / F-026 (N1 = inverse) · L5 closed · L6 info.

## Tested
Session model (cookie+key 200; cookie only / key only / swapped / duplicate key header / quoted → 401; 2 Cookie headers junk first → 200; 8 values 200, 9 → 401; host binding). CSRF with session (no / foreign / `null` / duplicate Origin, `same-site`, duplicate Sec-Fetch-Site → 403). Login flow (HEAD 404 no burn; XFH wrong port 401; `t` array 401). `checkUpgrade` (two key subprotocols 401; bad header key beats valid subprotocol 401; Origin missing / other port 403). Raw (bad encoding 400/421; no Host HTTP/1.0 + 1.1 → 421; userinfo / `:80` / `webhub.internal:port` → 421; CONNECT dropped; TE+CL 400; 15 KB key header 401; garbage socket closed in 3 ms). Logs without token / key / id / code. Client reload: only re-reads user-ACL auth.json + re-proves — not abusable.

Not tested: real Windows signals (SIGHUP ~5 s console-close window vs 5 s grace); remote `uncaughtException`; Firefox / Edge; real :80 squat / Docker; nginx; slowloris re-timing.
