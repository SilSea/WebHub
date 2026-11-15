# Review — CR-005 — round 1 (code + security)

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `80d3a96` (`fix/CR-005-fixture-tempdir-race` vs `develop`) |
| Scope | `test/unit/fixture-harness.test.ts:118-137`; rest of the diff is docs |

## Verdict: **PASS** (0 critical, 0 major, 2 minor, 1 nit)

## Checked
- **Claim still proven:** `copyFixture` (`test/helpers/fixture.ts:40-50`) throws "fixture not found" after `lstat`, before `mkdtemp(join(tmpdir(), …))`; `tmpdir()` is read at call time, so a created dir would land in `own`.
- **`os.tmpdir()` reads env per call** (libuv): Windows `TEMP` → `TMP` → `%SystemRoot%\temp`; POSIX `TMPDIR` → `TMP` → `TEMP` → `/tmp`. All three set → correct on Windows and Linux CI. `toBe(own)` stable (no trailing separator).
- **Meaningful even if default TEMP is the same:** `own` is a new `mkdtemp` dir, never equal to the previous `tmpdir()`.
- **`process.env` mutation safe:** vitest 5.1.0, default `forks` pool, `isolate: true` → per-file child process. No `concurrent` in the file. `finally` restores before `afterEach`. `delete` for `undefined` is correct; Windows env is case-insensitive.
- **Security:** test-only; `own` from `mkdtemp` (random, owner-only on POSIX); `rm` on its own path only. R0 holds.
- **Runs:** file 19/19; `pnpm test` 3× (365/6); `tsc`, `biome` clean.

## Findings
### m1 — minor — `fixture-harness.test.ts:127-129`: passes vacuously if the helper ever caches `tmpdir()`
- Scenario: `const TMP = tmpdir()` at module load + `mkdtemp` moved before the check → leftover lands in the real temp, `own` empty, test passes.
- Fix: positive control while redirected — `copyFixture("vite-basic")` lands inside `own`, then remove it; or document per-call `tmpdir()` in `fixture.ts`.

### m2 — minor (carried over) — `fixture-harness.test.ts:129`: create-then-clean-up is not detected
- Scenario: `mkdtemp` first, `rm` on error → `own` empty, passes. Old count test had the same blind spot.
- Fix: accept and state "no leftover dir" in the CR; or partial `vi.mock("node:fs/promises")` spying `mkdtemp`.

### n1 — nit — `fixture-harness.test.ts:121-134`: relies on per-file process isolation
- Scenario: future `pool: "threads"` + `isolate: false`, or concurrent tests → env leak.
- Fix: comment "relies on forks pool isolation; do not make concurrent", or `vi.stubEnv` + `vi.unstubAllEnvs()`.
