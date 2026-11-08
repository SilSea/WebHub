# Security review — F-003 — round 2

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 1aaf6b4 |
| Reviewer | fresh agent; probes: in-process daemon, real `dist/daemon.js`, headless Chrome via CDP, socket flood, port squat |

**Verdict: FAIL** — critical 1 (L1), major 0, minor 2, info 3.

## Findings
| ID | Sev | Location | Issue | Exploit scenario | Suggested fix |
|---|---|---|---|---|---|
| L1 | **critical** (verified, headless Chrome) | auth.ts `sessionHosts` / `sessionCookie`; "Known limit" comment; spec §3.2 | K1 class still open on named hosts: cookies ignore port and `*.localhost` → loopback on every port, so any listener on `127.0.0.1:Q` is reachable as `http://hub.localhost:Q` and receives the `hub.localhost` cookie. SameSite=Strict only blocks the first cross-site navigation; the next same-origin request carries the cookie. The attacker can force the navigation — no user action needed | project dev server on Q; page at `app.localhost` does `location="http://hub.localhost:Q/grab"` → `fetch("/steal")` arrives with `webhub_session` → replay with `Host: hub.localhost`, `Origin: http://hub.localhost` → **200 /api/v1/status**; full dashboard session up to 7 d; also cookie tossing (DoS) | cookie must not suffice alone: origin-scoped second secret (login → `/#k=<secret>`, JS keeps it in port-scoped storage, sends `X-Webhub-Session` on every API call incl. GET); session = cookie + header + Origin; drop `Max-Age`; shorter idle; `/_auth` (F-026) needs own design or explicit CR; fix the comment; test |
| L2 | minor (verified) | api.ts `HEADERS_TIMEOUT_MS` | real close at 30.0 s (idle / partial / drip), 60 s slow body — Node checks every `connectionsCheckingInterval` (30 s); test checks property only | local slowloris holds sockets 3–6× longer than spec | `connectionsCheckingInterval` ≈ 1 s and/or `connectionTimeout`; timing test (= review-2 J1) |
| L3 | minor (verified) | api.ts `MAX_CONNECTIONS` 256 | any local user holds 300 idle sockets, reconnects → CLI gets `DAEMON_UNREACHABLE/ECONNRESET` 6/6 over 25 s; daemon stays alive | other OS user blocks webhub control (DoS only) | not fully fixable on loopback TCP; L2 shortens hold; document as residual risk in §6, or later move CLI to named pipe with user-only ACL |
| L4 | info (future F-009 / F-026, unverified) | `/_auth` design | when the daemon is down any user can squat 7400 (CLI refuses: `DAEMON_IMPOSTOR`, token never sent — verified), but nginx would forward `/_auth` + dashboard to the impostor → 204 bypass / phishing | other user squats 7400 before start | F-009 / F-026 spec: nginx fails closed; nginx→daemon link authenticates the daemon |
| L5 | info (verified) | api.ts `clientError` | valid request pipelined with garbage: raw 400 written first, pending 200 out of order / lost; static bodies, no reflection | attacker harms only own connection; matters if a proxy reuses upstream connections | optional: destroy socket when a response is pending |
| L6 | info | auth.ts `normaliseHost` | `hub.localhost.` accepted; browsers treat it as another cookie host | harmless | none |

## Round-1 status
K1 closed for `127.0.0.1` (all IP / X-Forwarded-Host variants → 401), open on named hosts (L1) · K2 closed (hard kill leaves auth.json — harmless, handshake protects token) · K3 open, deferred to F-004 · K4 partial (L2, L3) · K5 closed · K6 duplicate cookie closed; tossing via `hub.localhost:<other port>` (L1) · K7, K8 closed · K9–K12 unchanged OK.

## Probes
`probe1.mjs` (login-link / redeem / XFH variants, cookie replay on 9 Hosts, `/_auth` matrix, CSRF, shutdown variants, TE+CL, JSON parser poisoning, target forms, 11 Host tricks, obs-fold, 431, pipelining, log contents), `probe-browser.mjs` (L1), `probe-dos.mjs` (L2, L3), `probe-proc.mjs` (real daemon: keep-alive shutdown → 503 + exit 0, stale auth.json + impostor, squatted port → exit 4, exit 3, restart token), `probe-hijack.mjs` (SO_REUSEADDR on 127.0.0.1:P refused; 0.0.0.0:P bind loses to specific bind — inferred).

Not tested: real Windows signals; `uncaughtException` path (no unauthenticated request crashed the daemon); WebSocket (`checkUpgrade` not wired yet); Firefox / Edge for L1 (expected same — cookies port-agnostic); cross-user port hijack.
