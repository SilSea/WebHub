# Code review — F-002 (+ CR-001) — round 3

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 3474911 |
| Reviewer | fresh agent, read-only + build/test + probes (no UAC) — 47/47 tests of the 3 files |

## Findings
| ID | Sev | Location | Problem | Scenario | Suggested fix |
|---|---|---|---|---|---|
| E1 | minor (test validity, verified) | integration volatile-env test | accepted names include `USERNAME`, which HKLM env already has → test passes even if volatile keys are not read | T2 regression undetected | assert volatile-only names (LOGONSERVER/APPDATA/LOCALAPPDATA; SESSIONNAME for subkey) |
| E2 | minor (portability, verified) | load-trace test | `module.registerHooks` since Node 22.15; engines `>=22.12` | test fails on 22.12–22.14 | skip when missing |
| E3 | minor (test validity) | load-trace test | `every` on empty array true; exit 0 also when entry never runs | hook silently not firing passes | assert exactly 1 LOAD = script; bad token → exit 2 |
| E4 | minor | elevated.mts isMain / elevateOutcome | success = exit 0 = default when isMain false | MVP-2 task reports success while nothing ran | distinct success exit code |
| E5 | minor (test vs spec) | parity test | only validator ⊆ zod checked; spec says equal | new zod kind missing in validator passes CI | assert reverse direction per schema option |
| E6 | minor (security robustness) | win32.ts realPath | falls back to link path on any error | EPERM on link chain → T4 reopened | fall back only on ENOENT; else refuse |
| E7 | nit | elevate | token > 8192 not checked before UAC | approve UAC then exit 2 | check length before prompt |
| E8 | nit (verified) | listening cache | older overlapping query can overwrite newer cache | stale data ≤ 2 s | `at` = start; write only if newer |
| E9 | nit (verified) | elevated.mts top-level await | async module graph → `require()` throws `ERR_REQUIRE_ASYNC_MODULE` | CJS consumers | `.then()` instead of TLA |
| E10 | nit (unverified) | process.env backstop | pnpm shims set `NODE_PATH` → always UNSAFE when launched via shim | false refusal | mention in hint/spec |

## Previous findings
Verified OK: D1/T1, D2/T2 (code; test → E1), D3, D4 (moot), D5, D7, D8, D9, D10, D11 (→ E8), D13, D14, T3 (test → E2/E3), T4 (→ E6), T5, T6 (documented).

## CR-001
OK — `.mts`→`.mjs(.map)`, `.ts`→`.js(.map)`, `.d.ts`/`.d.mts` skipped, scope = that one function.

## Status
critical 0, major 0. Minor E1–E6, nit E7–E10.
