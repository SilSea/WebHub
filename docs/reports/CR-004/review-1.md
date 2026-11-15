# Review — CR-004 — round 1 (code + security)

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `924e140` (`fix/CR-004-flaky-f004-tests` vs `develop`) |
| Scope | `test/unit/cli-stop.test.ts` (H1 test), `test/integration/cli.test.ts` (impostor test), CR-004 docs |
| Run | `pnpm -s build` then `pnpm -s vitest run test/unit/cli-stop.test.ts test/integration/cli.test.ts` → 48/48 (109 s) |

## Verdict: **PASS** (0 critical, 0 major, 1 minor, 2 nit)

## What the tests still prove
- **H1:** look 1 = `ownerOfAuth` in `daemonStatusChecked`, look 2 = `ownerOfAuth` in `startDaemonProcess`, look 3 only from `waitDead` (`daemon-control.ts:262-276`). Without the wait the error is `DAEMON_NOT_ANSWERING`, not `DAEMON_START_FAILED`, so `calls >= 3` + the code still need the wait. 30 s test timeout > 15 s wait + spawn: a hang is still a clear failure.
- **Impostor:** `status` is a fair baseline. With `auth.json` naming a dead PID and a squatter on the port, `status` and `stop --force` both do `daemonStatus` (IMPOSTOR) → `ownerOfAuth` ("gone") → `daemonStatus` (IMPOSTOR, throws) → `explainImpostor` → `portOwners`, plus one CLI spawn. A regression with the 10 s `STOP_TIMEOUT_MS` wait gives ≈ `statusMs + 10 s` > `statusMs + 8 s`.
- **Security (R6):** the token check is unchanged (`seen.length > 0`, no `authorization` on any request, both commands). No `src/` change, no new attack surface. The deterministic unit counterpart (`cli-stop.test.ts:225-239`) is untouched.

## Findings
### M1 — minor — `test/integration/cli.test.ts:191`: ~2 s margin against a 10 s wait, depends on equal load
- Scenario: `status` during a load spike (6 s), `stop` on an idle machine (1 s of work). A regressed `stop` (~11 s) passes `< 6 + 8 = 14 s`. CR §1 says the regression is always caught; true only under similar load.
- Impact: limited; the unit test at `cli-stop.test.ts:225` (fake platform, < 3 s) is the deterministic guard.
- Fix options: (a) `statusMs + 6_000`; (b) baseline = max/avg of `status` before and after `stop`; (c) accept and correct CR §1/§3 wording.

### N1 — nit — CR-004 §1/§3: name the unit-level guard (`cli-stop.test.ts:225`) as why loosening the integration bound is acceptable.

### N2 — nit — `test/unit/cli-stop.test.ts:236`: `< 3_000` wall-clock bound may flake the same way under load (out of CR scope). If it does: count `process.info` calls via `f.setOnInfo` instead of wall-clock.

## Checklist
- Inside CR-004 §5: yes. `src/` untouched (R1): yes. Comments reference CR-004: yes. Docs (R4): PLAN, F-004 log, features README; `reports/README.md` at done.
