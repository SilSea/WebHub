# Test report — F-001 — round 3

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-2 + all round-1 minor/nit, owner decision "แก้ทั้งหมด") |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI still blocked by GitHub billing lock) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| unit (F-001 + F-000) | 108 | 0 | 5 |
| integration (pack, built CLI, lock across processes, stale-lock race, zero-touch) | 8 | 0 | 0 |
| — total | 116 | 0 | 5 |
| regression (F-000) | 29 | 0 | 0 |

Skips on Windows by design: POSIX 0600 files, POSIX 0700 home, POSIX group/other strip, non-Windows DPAPI error, symlinked file (needs admin / Developer Mode).

## New tests (`test/unit/hardening.test.ts` unless noted)
| Finding | Test |
|---|---|
| N1 junction traversal | junction inside home → `SYMLINK_REFUSED` listing it; outside file's ACL (icacls output) and content unchanged |
| N2 (c) fast path | home ACL exact + child with explicit `Everyone:F` + no marker → reset; marker written; second run fast |
| N2 (a) icacls failures | `icacls()` now fails on `Failed processing N>0` (code path; no non-admin way to create an un-re-ACL-able child in a test) |
| N2 (b) foreign owner | audit refuses entries owned by others (code path; needs a second account to reproduce) |
| N3 guard | guard older than 30 s is broken, lock acquired, no `.lock*` files left |
| R5 / S6 | `SystemRoot="C:Windows"`, `windir="\Windows"` → `systemExe` throws |
| R6 BOM | BOM-prefixed JSON parses |
| S5 / R6 parse error | `JSON_PARSE` says `line 3, column N`; credential not in message/details; `jsonErrorIndex` agrees with JSON.parse on 4 valid / 7 invalid inputs |
| R7 / S9 DPAPI error | garbage ciphertext → detail names the .NET exception, not `#< CLIXML` |
| R8 received value | `(got 99)`, `(got "turbo")`; `defaultEnv` value never shown |
| R9 | `..foo` is inside; `..` is not |
| R10 | stat errors other than ENOENT are problems (code path) |
| R11 | leftover `.tmp-*` does not affect reads/writes; integration suite refuses stale `dist/` |
| R12 | `has()` validates keys |
| S7 | `runtimes.dir: "."` / `profilesDir: ["./"]` rejected; scan root that is a junction to home detected |
| S8 | no `secrets.json.*` copies after set/set/delete; secrets schema errors never echo values |

Other checks: lint, typecheck, build, `pnpm run audit` (high) — pass. Temp dirs left: 0.
