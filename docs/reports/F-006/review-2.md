# Review — F-006 — round 2 (code + security)

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `cd99cdb` (`feat/F-006-scanner`) |
| Reviewer | AI agent, separate from the author |
| PoCs | scratchpad `f006-r2/poc.mjs` (outside the repo), run against `dist/` |

## Verdict: **FAIL** (2 major, 3 minor)
Build passes. Scanner tests pass 40/40.

## Round-1 critical / major
| ID | Status | Evidence |
|---|---|---|
| S1 | fixed | A scan with a 256 KB Dockerfile of `\n` took 123 ms (event-loop lag ≤ 7 ms). Long lines, tabs and `FROM` variants took about 65 ms. |
| C1 | fixed | Time mode: 33 sites + 166 unread. Bytes mode: 103 sites + 198 unread. Both are schema-valid. |
| S3 | partly fixed | The folder share works, but candidate, byte and time starvation remain. The share math also caused a regression (R1, R2). |
| C2 / S2 | fixed | 1005 folders with one base name all got names ≤ 40. `notWeb` is clipped; each candidate gets `safeParse`; the whole result gets `parse` before saving. |
| C3 | fixed | No `public` rows. A real nested copy is still a `duplicate`. |
| C4 | fixed | The fixture passes. Infra-only parent → `hybrid`; parent `build:` → `compose`. |

## New findings

### R1 — major (regression) — `scan.ts:545`: the per-root share cuts scans that fit the global limit
`share = floor((limit - used) / (roots.length - i))`:
- It counts roots that are missing, links or inside home.
- It never gives folders an earlier root left unused back to that root.

Two cases:
- One real root plus 9 missing roots with `folders:100`: `truncated`, 0 candidates.
- Two roots of 74 and 2 folders with `folders:100`: `r1/zz/site` is lost.

Fix: divide only by usable roots, and resume cut roots with what is left (round robin). Truncate only at the global limit.

### R2 — major (security, S3 not fully fixed) — `scan.ts:181`, `:555-569`: a hostile earlier root still starves later roots
- **Candidates:** the limit is global. `r1/evil/p0..p2099/package.json` gives 2000 `unknown` rows, and `r2/good` is absent.
- **Bytes / time:** detection runs in `found` order. The fingerprint reads up to about 18 manifests × 256 KB per folder (lockfiles), so about 20 folders with big lockfiles use up the bytes, and later roots become `unknown`.

Fix:
- Give each root a share of the candidate limit, or walk round robin.
- Detect round robin across roots.
- Read the fingerprint lazily, or exclude lockfiles.
- Add a test with a hostile first root and a good second root.

### R3 — minor — `scan.ts:376-418`: parent + child compose merge
- **(a)** A service in both the parent and a child appears twice (`app: ["web","api","api"]`).
- **(b)** A parent compose file that fails to parse is still listed in `files` with `app: []`.

### R4 — minor: duplicate or nested scan roots
`[r1, r1, r1/a]` gives three candidates with the same `key`. Fix: dedupe real paths, and skip a root that lies inside another.

### R5 — minor: `truncated` keeps only the first cut and the first root

## Checked, no issue
- `Budget.reserve` is applied once, and abort still propagates.
- The share counter counts only folders taken from the queue.
- `nested()` split and the original-selection rule.
- The name loop keeps names ≤ 40.
- `truncated.root` is sanitized in the CLI.
- Unread drafts pass the schema.
