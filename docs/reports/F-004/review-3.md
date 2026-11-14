# Code + security review — F-004 — round 3

| | |
|---|---|
| Date | 2026-11-14 |
| Scope | `git diff 933f1f9 95f10f0` (fixes for review-2 E1–E7) |
| Reviewer | separate agent; ran unit 47/47, integration 13/13, live race runs against `dist/` from HEAD, 18 mutations on a scratch copy (session scratchpad `f004-review3/`) |
| Verdict | **PASS** — 0 critical, 0 major; 3 minor (G1–G3), 2 nit (G4, G5), 1 info (G6) |

## Findings
| ID | Severity | Where | Problem / scenario | Evidence | Fix |
|---|---|---|---|---|---|
| G1 | minor | `stopImpl` no-auth.json branch (`depth`) | Re-enters once as soon as auth.json names `lock.pid`; if the daemon has not called `listen()` yet → connection refused → depth 1 lands in the same branch, never asks status again → `DAEMON_STOP_TIMEOUT` after 10 s, the new daemon keeps running | **Ran** fake-platform probe (auth.json at 150 ms, listen at 450 ms → timeout, daemon alive). Real window auth.json → listen ≈ 5 ms; 4 live stops at that moment all worked | Loop: while auth.json names `lock.pid`, ask status every poll until the deadline |
| G2 | minor | same branch | Ignores `--force` but its hint says "run `stop --force`": a daemon hung in start-up holding the lock without auth.json cannot be stopped from the CLI | **Ran** probe: `force: true` → timeout, 0 kills | With `--force`: `killTree(lock.pid, lock.startedAt)` (lock + start time = same proof as "ours"), or drop the hint |
| G3 | minor (tests) | `cli-stop.test.ts`, `cli-daemon.test.ts` | New wiring untested. **Ran** 18 mutations: killed M2, M5, M10, M11, M12; survived M1 / M3 / M8 (ENOENT mapping in `daemonStatus`, shutdown catch, start poll), M4 / M17 (depth recursion / guard), M6 / M15 (`daemonStatusChecked` ours / gone), M7 (start waits for a stopping daemon), M13 (`ensureDaemon` swallows all), M9 / M18 (no-auth branch: start time unknown, "unknown" as dead), M14 (`isStopping` ignores 503), M16 (`readTail` open failure → `.1` not read) | ran | One test per survivor (fake platform + fake daemon; inject ENOENT) |
| G4 | nit | spec §3.4 | A losing `stop` can print "not running" ~10 ms before exit (port / lock already released); a `stop` before the lock is taken (first ~5 s of a start) returns "not running" and the daemon runs | **Ran** 3 × 4 CLI stops; stop at 0–4500 ms after start | Reword the spec |
| G5 | nit | `cli.ts` stream handler, `startDaemonProcess` | EPIPE before `run()` resolves exits 0 (e.g. status 3 → 0); non-EPIPE error during start skips `abandonStart`; the wait for a stopping daemon ignores `opts.timeoutMs` | reasoned | Small cleanups |
| G6 | info (security) | — | No new kill path; 503 after proof only waits, re-queries go through the handshake (**ran** 8 × 40 concurrent stops + squatter: 0 failures); token only compared, never printed; `removeAuthOf` needs PID + first-seen token (M5 killed); `readAuthIdentity` skips F-001's link / size checks — matters only to someone who can already write `data/` | ran + reasoned | — |

## Round-2 status
| ID | Status | Evidence |
|---|---|---|
| E1 | fixed | **Ran** 8 × 40 in-process `stopDaemon` staggered 0–30 ms on a real daemon: 0 failures; 5 × 6 CLI stops + immediate start: all exit 0. Wiring untested (G3) |
| E2 | fixed | **Ran** 12 busy-port starts: all exit 4. M8 survives (G3) |
| E3 | fixed, leftovers | start after stops, `ensureDaemon` during a stop, `status` during a stop (397 samples) never blames another program. G1, G2, G4 |
| E4 | partly | round-2 mutations a–e tested; new code untested (G3) |
| E5 | fixed | M5 killed |
| E6 | fixed | M11, M12 killed |
| E7 | fixed | — |

Note: the reviewer's temporary webhub homes went to `%TEMP%\whr3*-` (73 folders) instead of the scratchpad; all were deleted.
