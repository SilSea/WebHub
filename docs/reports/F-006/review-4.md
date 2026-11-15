# Review — F-006 — round 4 (code + security)

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `48ac944` (`feat/F-006-scanner`) |
| Reviewer | AI agent, separate from the author |
| PoCs | scratchpad `f006-r4/` (`poc1.mjs`–`poc5.mjs`), outside the repo |

## Verdict: **FAIL** (2 major, 1 minor)
Build passes. Scanner tests pass 49/49. Neither major is a security issue; both are correctness issues.

## Status
| Item | Status | Notes |
|---|---|---|
| Q1 | fixed | `poc2`: 4.65 MB / 4.52 MB pretty, under 5 MB, truncated rather than lost |
| R3 | (b) fixed, (a) partly | Duplicates inside one folder (base + override) remain → V2 |
| R4 | fixed as written, regression | Case, 8.3, trailing `\`, `[R,R]` and both orders → `inside-root`. But the inner root is never walked → V1 |
| Q2 | fixed | One remaining three-scan race is inherent |
| Q3 | fixed | One edge case → V3 |
| Q4 | fixed | Nit: duplicated comment at `scan.ts:594-595` |

## Findings

### V1 — major — `scan.ts:596-613`: a covered root is skipped even when the outer walk never reaches it
The outer walk stops at `maxDepth`. It also skips `SKIP_DIRS`, dot folders, folders in `ignore`, and anything past the folder limit. `[R, R\a\b\c\d\deepsite]` gives `deepsite` missing (found if scanned alone). The same happens under `.work`, `vendor` and `ignore` folders. This breaks the spec's own workaround: add the deep folder as its own scan root.

**Fix:** walk covered roots too, with one shared `visited` set of listed folders. Add tests.

### V2 — major (pre-existing) — `scan.ts:256-276, 327-333`, `compose.ts`: compose files in one folder are not merged by service name
- **Runner flip:** base `db: image: postgres` plus override `db: ports` turns the runner from `hybrid` to `compose`, with `app:["db"]` and `infra:["db"]`. F-007 would run the site in compose, which has no app.
- **Same name twice:** base `web`/`db` plus override `web`/`db` gives `app:["web","web","db"]`.

**Fix:** merge services by name across files, in file order, then classify. Add a test with an override file.

### V3 — minor — `scan.ts:488-491` + `unread()`
When detection is cut, unread folders are `unknown`. After Q3 they are hidden by any non-site parent, so a real site that was not read disappears.

**Fix:** flag unread drafts and do not hide them.

## Checked, no issue
- `isInside` / `samePath` after realpath.
- Inside-home and link roots never cover others.
- Keys are stable.
- Compose `files` lists only parsed files.
- The merged `app` / `infra` are deduped.
- The schema enum.
- `RESULT_MAX_BYTES`.
- No new security issue.
