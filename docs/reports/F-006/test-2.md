# Test report — F-006 — round 2 (after review-1 / security-1 fixes)

| | |
|---|---|
| Date | 2026-11-15 |
| Branch | `feat/F-006-scanner` (fixes on top of `2f6b334`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0 + Node 22.12.0, pnpm 12.9.1. The machine was still under heavy external load (game, Unreal Editor). |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| `scanner` + `scanner-fixtures` (unit) | 36 | 0 | 0 |
| `scan` (integration) | 4 | 0 | 0 |
| F-006 suites on Node 22.12 | 40 | 0 | 0 |
| Full suite | 489 | 4 (pre-existing timing, see test-1) | 6 |

Lint, typecheck and build pass. The 4 failures are tests that `develop` also failed under the same load in test-1, plus the W2 flood test, which failed in test-1 run 1:
- "more than 200 files"
- "our daemon stopping (503)"
- "second process gets LOCKED"
- "MAX_CONNECTIONS sockets …"

## Fixes and their tests
| Finding | Fix | Test |
|---|---|---|
| S1 critical: ReDoS on the Dockerfile `EXPOSE` / `FROM` patterns | Match line by line with `[ \t]`, no `m` flag. Dockerfile read is capped at 64 KB. | `scanner` "Dockerfile regexes stay linear" (256 KB of `\n`, `" \n"`, `\t`, under 200 ms each); "hostile content" (a scan of a repo with a 256 KB Dockerfile of newlines finishes fast) |
| C1 / S3 major: a walk limit dropped every candidate; one wide root starved the others | Each root gets an equal share of the folder limit that is left. A limit ends that root (folders) or the whole walk (time / candidates). The folders found are still detected, with a one-time reserve. `truncated.root` names the root that was cut. | `scanner` "scan: … truncation" (partial candidate kept; fake-clock time limit); "one wide root does not starve the others" |
| C2 / S2 major: strings from projects overflowed the schema; names could reach 41 characters | Strings are clipped when built. Each candidate is checked with `Candidate.safeParse`; a bad one is dropped and recorded as a problem. `ScanResult.parse` runs before save and before serving. The name suffix keeps names ≤ 40. | `scanner` "hostile content" (200-character `.csproj` name → valid result, `notWeb` ≤ 200) |
| C3 major: identical `public/` boilerplate became mutual duplicates | The rule that drops nested non-site / static folders now runs before the duplicate check. The original must be a shown candidate that is not itself a duplicate. | `scanner` "public/ folders with the same boilerplate are not duplicates" |
| C4 major: a compose file in the monorepo parent was lost | The compose of every folder is kept on the draft. The merge takes the parent's compose first, for both runner and files. | `scanner-fixtures` "compose at the monorepo root" (new fixture `monorepo-compose`) |
