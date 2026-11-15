# Review — F-006 — round 3 (code + security)

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `ef569fa` (`feat/F-006-scanner`) |
| Reviewer | AI agent, separate from the author |
| PoCs | scratchpad `f006-r3/` (`poc1.mjs`, `poc2.mjs`, `poc3.mjs`), outside the repo |

## Verdict: **FAIL** (1 major, 3 minor)
Build passes. Scanner tests pass 45/45.

## Status
| Item | Status | Notes |
|---|---|---|
| R1 | fixed | `poc1`, three roots A (hostile), B (deep sites), C (monorepo) with `folders=30`: B 3/3, C merged |
| R2 | fixed | `candidates=20` → B 3/3; `bytes=200k` and `timeMs=50` → B still detected |
| C6 | fixed, side effect | Q3 |
| S4 | fixed | — |
| C9 | fixed | — |
| C11 | **not fixed** | Q1 |
| C12 | fixed | No test |
| C13 | fixed, side effect | Q2 |
| C14 | fixed, side effect | Q2 |
| S5 | fixed | — |
| S6 | fixed | Q4 (comment) |

## Findings

### Q1 — major — `scan.ts:37, 618-624`: C11 measures compact JSON, but the store writes pretty JSON
`json-store.ts:162` writes `JSON.stringify(value, null, 2)` and refuses anything over 5 MB. Pretty JSON is 1.43–2.38× the compact size. `poc2.mjs 1500` (1500 folders, each with 200 compose services) gave 2.68 MB compact and 6.38 MB pretty, so the save fails with `FILE_TOO_LARGE` and the whole scan is lost. Content in a root can do this on purpose (DoS).

**Fix:** measure the same serialization the store uses, and add a test.

### Q2 — minor — `scan-command.ts:175-190`, `routes.ts:151`: `?result=0` polling hides our result
Our scan ends, and another client starts a new scan within 500 ms. Our next poll sees a `running` scan with a different id and `last: null`, so the CLI reports `SCAN_LOST`.

**Fix:** when the running scan is not ours, poll once more without `?result=0`.

### Q3 — minor — `scan.ts:469`: after C6, non-web projects no longer hide non-web folders inside them
A Unity project now also lists `Packages` and `Packages/com.me.tool` (unknown). A Python repo lists its sub-packages.

**Fix:** any candidate hides nested non-sites. Only a `site` hides nested sites.

### Q4 — minor (docs) — `hints.ts:148-154`
The comment says "no shell characters", but `|`, `<`, `>` and spaces are allowed, because real version ranges need them.

**Fix:** reword the comment, and add a note in F-015 that hints never reach a shell.

## Checked, no issue
- Progress counts.
- The round-robin walk and `interleave` always terminate.
- The C11 loop costs at most about 20 stringify calls.
- Query arrays fail closed.
- The CLI retry propagates errors.
- Removing `truncated.root` removed one printed path.
