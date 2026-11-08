# Security review — F-003 — round 1

| | |
|---|---|
| Date | 2026-11-08 |
| Commit | 33810ce |
| Reviewer | fresh agent; built daemon on a temp `WEBHUB_HOME` + free port, raw-socket probes (scratchpad only) |

## Verdict
FAIL — 1 critical (K1, verified), 0 major, 5 minor, 6 info.

## Findings
| ID | Sev | Location | Issue | Exploit scenario | Fix |
|---|---|---|---|---|---|
| K1 | **critical** (verified) | api.ts login-links default host, `/_webhub/login` scope, session on any api host; spec §3.2 | sessions issued for `127.0.0.1:<apiPort>`; cookies ignore ports (RFC 6265) and all ports of 127.0.0.1 are same-site → browser sends `webhub_session` to every `http://127.0.0.1:*` | user opens a project dev server at `http://127.0.0.1:3000` → project code receives the cookie, replays it with correct Host/Origin → full dashboard session up to 7 days (verified: status 200, logout 204 with forged Origin); can also toss a duplicate cookie → DoS | never issue/accept cookie sessions on IP hosts; sessions only on `hub.`/`db.<suffix>`; bearer only on `127.0.0.1:<port>`; document the same port-agnostic risk for `hub.localhost:<other port>`; test |
| K2 | minor (verified) | daemon.ts `main()` | crash / killed parent leaves `auth.json` (dead token) | no exposure (handshake), stale "running" state | best-effort cleanup on `uncaughtException`/`exit`/`SIGHUP`, stdout `error`; F-004 treats ECONNREFUSED + file as not running |
| K3 | minor (F-004 design) | login code in URL query | code visible in browser-opener argv / history; anyone holding it can redeem it from a raw socket within 60 s; prefetch can burn it | another local user races the code | F-004: open via user-only temp file / OS opener without argv; or GET page that POSTs the code |
| K4 | minor (verified) | server timeouts | header phase held ~60 s (`headersTimeout` default), no `maxConnections` | local slowloris DoS | `headersTimeout` ~10 s, `maxConnections` ~256 |
| K5 | minor (verified) | api.ts onResponse log | absolute-form target logged with full authority (`http://evil.com/api/v1/status`) | log noise; userinfo would be logged | log pathname / route url only; optionally 400 on absolute-form |
| K6 | minor (unverified) | `*.localhost` cookies | unknown if a browser accepts `Domain=localhost` from `app.localhost` → cookie tossing to hub | DoS only (duplicate check) | keep duplicate check + test; `__Host-` needs Secure (not on http) |
| K7 | info | `/api/v1/hello` | HMAC oracle, domain-separated, not a credential; leaks pid | — | drop `pid` |
| K8 | info | Fastify client errors | 400 (obs-fold) / 408 skip onSend → no security headers | — | `clientErrorHandler` |
| K9 | info | `/_auth` | holder of a session id can keep it alive (cap 7 d) | needs id | accept |
| K10 | info | `safeEqual` | length only, fixed length, 50 ms delay | — | OK |
| K11 | info | `WEBHUB_API_PORT` | same-user env only; allowlist follows port | — | document / dev only |
| K12 | info | auth.json | writeDoc wx 0600 + rename, no .bak; removal checks token under lock; read via readDoc | — | OK |

## Probes
Host variants (`localhost:P`, `0P`, `[::1]`, `2130706433`, `hub.localhost:80`, duplicate, none, absolute-form + bad Host) → 421; obs-fold → 400; `HUB.LOCALHOST.` / tab-padded accepted (correct); absolute-form with good Host → 200 (K5); internal + bearer → 404; duplicate X-Forwarded-Host → 401 (code consumed); OPTIONS 405; cross-site Origin + bearer 403; text/plain / form 415; `__proto__` 400; `n=a&n=b` 400; `bearer` lowercase 401; `%73tatus` still authenticated; session replay (K1); slow headers 408 at ~60 s (K4); shutdown 202 → exit 0, auth.json removed; parent killed → stale auth.json (K2); logs clean.
Not tested: Windows port hijack via `SO_REUSEADDR`; real browser `*.localhost` cookie behaviour (K6).
