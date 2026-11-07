# Test report — F-001 — round 4

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-3, owner decision "แก้ทั้งหมด + review อีกรอบ") |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI still blocked by GitHub billing lock) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| unit (F-001 + F-000) | 111 | 0 | 5 |
| integration | 8 | 0 | 0 |
| — total | 119 | 0 | 5 |
| regression (F-000) | 29 | 0 | 0 |

## New / changed tests
| Finding | Test |
|---|---|
| F1 restrict before audit | pre-existing home (inherited temp ACL) + child → home protected (no `(I)`), child has exactly 2 inherited entries (`hardening-r3.test.ts`) |
| F2 case-insensitive "not the home" | `runtimes.dir` = home in upper case → `CONFIG_INVALID` |
| F3 vanished entry | code path (`Test-Path` before reporting `ERR:`); "unreadable" now has its own message |
| F4 removeIf window | check-before-move; limit documented in code + spec |
| F5 messages | 200k-deep nesting → `JSON_PARSE` without bogus `line 1, column 1`; sensitive doc hint does not mention `.bak` |
| F6 | `systemExe` with bad `SystemRoot` → `WebhubError` `SYSTEM_TOOL` |
| R11 | integration suite checks every `src/**/*.ts` has a newer `dist/**/*.js` |

Other checks: lint, typecheck, build, `pnpm run audit` (high) — pass.
