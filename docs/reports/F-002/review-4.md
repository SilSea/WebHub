# Code review — F-002 — round 4

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 84c99a6 |
| Reviewer | fresh agent, build + 51/51 tests of the 3 files + read-only probes (no UAC) |

## Findings
| ID | Sev | Location | Problem | Scenario | Suggested fix |
|---|---|---|---|---|---|
| G1 | minor (test robustness) | integration load-trace test | waits for `exit`; stderr may still be open → `LOAD` line missed | intermittent fail under load | wait for `close` |
| G2 | minor (regression from E8) | win32.ts listening cache | `Date.now()` + "write only if newer" → backwards clock jump leaves future `at`; stale snapshot up to the jump size, `fresh` cannot replace | NTP step −1 h → stale ports 1 h | `performance.now()` for all timestamps |
| G3 | nit | elevated.mts EXIT | Node itself uses exit 10 (bootstrap failure) and 3 | rare false success | codes Node never uses (20–23) |
| G4 | nit | elevate() | token `iat` set before trust checks (~1–60 s) | real UAC window shorter than "5 minutes" | encode right before runPs |
| G5 | nit (test validity) | unit token length test | 8193 × "a" rejected anyway (not JSON) | length check removable without failing test | padded valid envelope > 8192 → 2; exactly 8192 not rejected for length |
| G6 | nit (unverified) | win32-trust.ts `.local` | `node.exe.local` is a folder; contents not checked | DotLocal redirection DLL (needs DevOverrideEnable) | treat existing `.local` as a problem |
| G7 | nit | nodeDirEntries | readdir error → `[]` silently | listing denied but ACL readable → U3 skipped | non-ENOENT error → refuse |
| G8 | nit (test gap) | realPath | non-ENOENT branch untested | E6 regress unnoticed | export + test with mocked error / junction loop |
| G9 | nit (unverified) | volatile-env integration test | key exists only for interactive logons | fails under service/SSH CI | skip when key missing |

## Round-3 findings
OK: E1 (G9 caveat), E2, E3 (G1), E4 (G3), E5, E6 (G8), E7 (G4/G5), E8 (G2), E9, E10, U1 (no false positives: 72 process + 40 registry names; non-ASCII survives UTF-8 JSON), U2, U3 (G6/G7), U6. Not OK: none.

## Status
critical 0, major 0. Minor G1, G2; nit G3–G9.
