# Code review — F-006 — round 1

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `2fb0673` (`feat/F-006-scanner`, diff vs `develop`) |
| Reviewer | AI agent, separate from the author (correctness) |

## Verdict: **FAIL** (4 major)

Build passes. The scanner tests (35) pass. C1–C4 were confirmed with scratch scripts against `dist/` (scratchpad, outside the repo):
- **C1:** `limits.folders=3` over 3 static sites gave `truncated: folders` and 0 candidates.
- **C2:** a 200-char `.csproj` name failed the `ScanResult` zod check on `notWeb[0]`.
- **C3:** two CRA-style projects gave two `duplicate` rows that point at each other.
- **C4:** a root `docker-compose.yml` with `build:` plus `frontend/` and `backend/` gave `runner: native` and no `compose`.

Changes outside the scanner are additive (one registrar in `src/daemon.ts`, one command in `src/cli.ts`); F-001..F-005 are not affected.

## Findings

### C1 — major — `src/scanner/scan.ts:471-486`: a walk limit discards every candidate found so far
- A limit hit during the walk throws `Truncated` out of the `try`, so the detect loop never runs. The walk raises `folders`, `candidates` and `time` (`walk` → `listDir` → `budget.folder()`).
- **Scenario:** a large root goes over 20 000 folders, or over 2 000 marker folders. `found` already holds hundreds of projects, but the result has `candidates: []`. This breaks spec §3.1 / §3.5 ("the results so far are still usable").
- **Why no test caught it:** `scanner.test.ts:293` checks only the reason.
- **Fix:**
  - Catch `Truncated` around the walk only, then still detect what was found.
  - Folder and candidate limits apply to the walk only. Detection gets a reserve of time and bytes.
  - If no allowance is left, emit the found folders as minimal `unknown` drafts.
  - Add a test that asserts partial candidates.

### C2 — major — `src/scanner/hints.ts:196`, reasons via `scan.ts:266/355`, view sub-listings: project strings are not clamped to the schema caps
- **Scenario:**
  - A `<170+ chars>.csproj` without ASP.NET makes `notWeb` longer than 200.
  - A user profile `fileContains` on a long wildcard name makes a reason longer than 400.
- **Effect:** `writeDoc`'s zod check fails and the whole scan ends as `SCAN_FAILED`, with no path. One hostile cloned repo blocks every scan, and the user cannot tell which one (DoS from untrusted input, §6).
- **Fix:**
  - Clamp every string when it is built: file names in messages to about 60 characters, `reasons` / `notWeb` / `source` to their caps.
  - `Candidate.safeParse` each candidate. A failing one is dropped and recorded in `problems`.

### C3 — major — `src/scanner/scan.ts:389-398` (`nested`): `public/` folders become mutual duplicates
- The duplicate check runs before the "index.html-only / non-site nested → dropped" rule.
- **Scenario:** CRA-style `public/` (`index.html` + `manifest.json`) has a byte-identical boilerplate `index.html` in every project. So `shop/public` becomes a `duplicate` of `blog/public` and the other way round, named `public` / `public-2`. This is noise in F-007 and contradicts spec §3.3 step 8.
- **Fix:**
  - Apply the duplicate rule only to nested drafts that would otherwise be kept (kind `site`, not static), or whose fingerprint includes a real manifest.
  - `original` must be a kept, top-level candidate.

### C4 — major — `src/scanner/scan.ts:271-273, 327-370`: in a monorepo, a compose file in the parent is lost
- `detect()` returns before `composeOf` when no profile matches. A compose-only parent is `unknown`, so its compose is never read.
- The merge then builds `compose` / `runner` from the children only.
- **Scenario:** a root `docker-compose.yml` (`build: ./frontend`, `build: ./backend`) with `frontend/` + `backend/` gives `runner: native` and no `compose`. F-007 would run it natively instead of with compose (spec §3.3 step 7, DESIGN §9).
- **Fix:**
  - Always run `composeOf` and keep the result on the draft.
  - In the merge, use the parent's compose first, then the children's.
  - Add a fixture for this layout.

### C5 — minor — `scan.ts:392-394`
`original` may be dropped, may itself be a duplicate, or may be removed by the monorepo merge. That gives mutual or dangling `duplicateOf`. Resolve `original` among kept, non-duplicate candidates only.

### C6 — minor — `scan.ts:384`
Any earlier draft counts as a parent, including `unknown` / `not-web`. A stray `requirements.txt` or tooling `package.json` at a root then silently drops everything static or unknown below it. Only `site` (and `duplicate`) drafts should be parents.

### C7 — minor — `scan.ts:188-198`
The fingerprint reads up to 256 KB of every lockfile for every candidate, against the 64 MB budget. Roughly 200–250 JS projects lead to `truncated: bytes`. Compute it lazily (nested drafts + possible originals), or hash with a stream outside the budget.

### C8 — minor — `src/scanner/view.ts`
`evaluateDetect` short-circuits, so each chained IO rule costs one fill round. After 8 rounds, missing data counts as "not there", so a `none` exclusion fails open for long user profiles. Treat "still missing" as unmatched + `problems`, or prefetch. Also: `deps()` re-parses the manifests while anything else is missing (performance).

### C9 — minor — `src/scanner/view.ts` `fill()`
Sub-folder listings are not filtered with `badName`, so odd names reach `list()`, wildcards and reasons.

### C10 — minor — `fsread.ts:154-166` / `view.ts`
`readSmall` runs `lstat` on the last segment only. If an intermediate folder is swapped for a junction after it was listed, a file outside the candidate is read. This needs concurrent local write access. Fix: check the parent's `realpath` after `open`.

### C11 — minor — `src/scanner/routes.ts:94-107`
A result over the 5 MB store cap fails the whole scan. Spec §3.4 says to truncate instead.

### C12 — minor — `routes.ts:61-69`
`loadLast` sets `lastLoaded` before the await. If a scan finishes during the first read, the new `last` is overwritten with the old file, and the CLI fails with `SCAN_LOST`.

### C13 — minor — `scan-command.ts:150-161`, `routes.ts:156`
- After a 409, a scan that already finished re-throws the 409. Use the `scanId` from the 409 body.
- `DELETE` is not scoped, so Ctrl+C can cancel another client's scan. Use `DELETE ?scanId=`.

### C14 — minor — `routes.ts:139-153`
Each 500 ms poll returns the full `last` result (up to 5 MB), and the CLI zod-parses it each time. Omit `last` while a scan is running.

### C15 — minor — `compose.ts` + `scan.ts:281-283`
Base and override files are not merged by service name. A service in both is listed twice, and an override-only entry counts as an app.

### C16 — minor (needs verification on Windows) — `fsread.ts:129`
libuv reports any reparse point as a link, including OneDrive placeholders, so OneDrive projects may be skipped. `lstat` entries of type `link`.

### C17 — minor — `scan.ts:174` vs spec §1 publicDir
A repo with only `docs/index.html` becomes a site at `…/docs` instead of the repo with `publicDir: docs`. Handle it, or document it.

### C18 — minor — tests vs spec §8
Missing tests:
- partial candidates after truncation;
- time / bytes / entries truncation at scan level;
- CLI sanitize and exit 2;
- `.env` secret through the API and `--json`;
- compose bomb at scan level → `problems`;
- 100k deps;
- long names;
- junction swap;
- a "no write API / no `child_process`" grep;
- fixtures for C3 and C4.

### C19 — nit — docs
- Spec §3.1 / §3.3 name `walk.ts` / `detector.ts`; the code is in `scan.ts`.
- §4 still says "depth 4".
- A `DELETE` during `writeDoc` returns `cancelled:true` but the result is saved.
