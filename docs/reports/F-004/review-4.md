# Code + security review — F-004 — round 4 (focused)

| | |
|---|---|
| Date | 2026-11-14 |
| Scope | `git diff 95f10f0 0e07f01` (fixes for review-3 G1–G5) |
| Reviewer | separate agent; unit suites 85/85 on a scratch copy, mutation run (`f004-review4/mutate.mjs`), live pipe runs against `dist/`; no repo edits |
| Verdict | **PASS** — 0 critical, 0 major; 2 minor (H1, H2), 2 nit (H3, H4) |

## Findings
| ID | Severity | Where | Problem / scenario | Evidence | Fix |
|---|---|---|---|---|---|
| H1 | minor (tests) | `cli-stop.test.ts` "start waits for our stopping daemon" | `ensureHome` takes ~2.5 s, so the 300 ms timer has already removed the PID and closed the squatter before the first status: the wait branch never runs; M7 survives; `>= 250 ms` holds because of `ensureHome` | **ran** (trace on copy) | Make the old daemon leave on an event (after N `info` calls), assert `info` was polled while alive |
| H2 | minor | `stopImpl` no-auth.json `--force` | After `forceKill` no `removeAuthOf`: auth.json written by the hung daemon (G1 window) stays with a dead PID → later `status` may blame another program on that port until the next start | **ran** probe: `forced: true`, `authLeft true` | `removeAuthOf(paths, lock.pid, undefined)` after the kill |
| H3 | nit (tests) | re-ask status, start wait timeout | Survivors: N2 (re-ask accepts any PID — near-equivalent), N3 (start wait ignores `opts.timeoutMs` — tests only), N5 (re-ask swallows all errors, e.g. `DAEMON_BAD_STATUS`) | ran | Test: non-transient error during the re-ask is rethrown |
| H4 | nit | re-entry at depth 1 | Fresh 10 s deadline on re-entry → a stop that waits through a start can take ~20 s; depth guard now redundant (M17 near-equivalent) | reasoned | Pass the remaining deadline through |

## Answers
- New `--force` cannot kill a foreign process: lock + live PID + known start time equal to `lock.startedAt`; `killTree` re-checks (N4 killed); unknown start time → "not running" (M9 killed). Accepted side effect: a healthy start slower than 10 s hit by a concurrent `stop --force` is killed.
- Per-poll re-ask never sends the token before proof (`#withProof`); squatter → IMPOSTOR swallowed, keeps polling with 100 ms sleeps; bounded by the deadline + one request.
- `cli.ts`: Ctrl+C unchanged (exits 130); `ctx.signal` only ends `followLogs`; writes after a destroyed stream dropped; exit codes kept (`status | head` → 3). **Ran**: `logs -n 10000 | head -1` → 0 (3/3); `logs -f -n 1 | head -2` ends on the next write (exit 0). Inherent: `logs -f | head` with no further append keeps polling (same as `tail -f | head`).
- `vi.mock` of `readDoc` is file-scoped, counters reset in `beforeEach`; M3 killed.

## G1–G5 status
| ID | Status |
|---|---|
| G1 | fixed (M4, M4b killed) |
| G2 | fixed (N1, N4 killed); leftover H2 |
| G3 | partly: 12 / 13 killed; M7 survives (H1), M17 near-equivalent (H4) |
| G4 | fixed |
| G5 | fixed (live pipe runs; non-EPIPE case reasoned) |

Previously killed M2, M5, M10, M11, M12: still killed.
