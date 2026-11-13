# Security review — F-004 — round 1

| | |
|---|---|
| Date | 2026-11-13 |
| Scope | commit `d8ca148` against F-004 §6 and F-003 §6 |
| Reviewer | separate agent; spikes in the session scratchpad `f004-security1/` (real daemon via `dist/cli.js`, squatter, request flood) |
| Verdict | **FAIL** — 1 critical (D1), 0 major, 2 minor (D2, D3), 4 info (D4–D7) |

## Findings
| ID | Severity | Where | Scenario | Evidence | Fix |
|---|---|---|---|---|---|
| D1 | **critical** (unbounded disk, per policy) | `daemonEnv` + `daemon.err` | `NODE_DEBUG` (common developer setting) reaches the daemon; Node then writes debug lines to stderr for every connection, and any website can send no-cors requests to `127.0.0.1:7400` → `daemon.err` grows without limit, bypassing the CR-003 cap. Spec §3.3 ("stderr stays small") is wrong | **Ran**: `NODE_DEBUG=http,net,fs`, 200 requests → `daemon.err` 17 789 → 133 389 B (~578 B / request; flood ~6.5 k req/s ≈ 13 GB / hour). Token not in `daemon.err` / `daemon.log` | Drop every `NODE_*` except `NODE_ENV` (case-insensitive); bound `daemon.err` as defence in depth; test + spec §3.3 / §6 |
| D2 | minor | `daemonEnv` | `OPENSSL_CONF` (can load a provider DLL), `SSL_CERT_*`, `UV_*`, `NODE_PATH`, TLS knobs reach the long-lived token holder. Same user's own env → no privilege boundary crossed | reasoned | Same denylist, or document what is kept on purpose |
| D3 | minor | `stop --force` | `rmSync(auth.json)` unconditional → a daemon started in the same instant loses its auth.json (availability only) (= review C6) | reasoned | Remove only if it still names the killed PID |
| D4 | info | `status --json` | Daemon strings via `JSON.stringify` keep C1 / bidi characters; source is the proven daemon | reasoned | Validate the status shape / sanitize |
| D5 | info | `sanitize` | U+200E / U+200F / U+061C and zero-width characters pass (cannot reorder text); every printed path is covered | read all output paths | Optional |
| D6 | info | kill safety | Holds: start-timeout kill uses our child's start time; `--force` needs auth.json PID = lock PID + lock start time; nothing is ever killed from impostor data (**ran**: the squatter survived `stop --force`). Pre-existing millisecond race in `win32.ts` between process table and `taskkill` (same user only) | ran + reasoned | — |
| D7 | info | `stop` polling | `process.info` spawns PowerShell (~1 s) per poll → ~10 per `stop`, bounded | reasoned | Optional |

## Verified (ran)
- Token never in the daemon's argv / env or in any CLI output; the squatter received only `/api/v1/hello?n=…` with no `Authorization` (0 occurrences); every command exited 1 naming the port owner.
- Spawn: absolute `process.execPath`, `daemon.js` from `import.meta.url`, no `execArgv`, `NODE_OPTIONS` stripped in any case, cwd = home, no shell, stdio `["ignore","ignore",fd]`, detached (no console Ctrl+C).
- Start-error file: `wx` = CREATE_NEW (planted link / file → fails); rename over `daemon.err` never writes through a link.
- `logs`: `-n` 1–10 000; follow with ~260 k requests and a stalled pipe reader kept the CLI at ~71 MB (Windows pipe writes block); ~11.8 MB in 10 s with a normal reader.
