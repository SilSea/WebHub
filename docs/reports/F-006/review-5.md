# Review — F-006 — round 5 (code + security)

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `7f6e3c6` (`feat/F-006-scanner`) |
| Reviewer | AI agent, separate from the author |
| PoCs | scratchpad `f006-r5/poc1.mjs`, `poc2.mjs` (outside the repo), run against `dist/` |

## Verdict: **PASS** (0 critical, 0 major, 2 minor)
Build, typecheck and biome are clean. Scanner tests pass 51/51. Nothing in this round is exploitable. A hostile project can only affect how its own folder is classified, and F-007 run approval covers that.

## Status
| Item | Status | Evidence |
|---|---|---|
| V1 | fixed | Root orders `[R, deep]` / `[deep, R]`, case changes, and a dot folder 3 levels down all give the same candidates and keys, each listed once. Round robin lists each walk's root in round 1, so an outer walk never re-queues an inner root's subtree. Folder budget 3: both roots are reached. Monorepo merge (S4) via the owner works. |
| V2 | fixed | Base image + override ports → infra / `hybrid`. Base build + override image → app. Ports deduped, capped at 50. |
| V3 | fixed | Unread folders are kept under not-web, under site, and at top level. End to end with a time cut: they show as `unknown`. Unread drafts cannot be originals. |

## New findings

### W1 — minor — `compose.ts:10-19` + `scan.ts:273-293`: every compose name is merged, but docker compose reads one base file + one override
If a folder has both `compose.yaml` and `docker-compose.yml`, the scanner also counts services and ports from the file docker ignores. An override with no base still gets a compose runner.

**Fix:** use the first base name found and the first override name found. With no base, there is no compose. List the extra base files in `problems`.

### W2 — minor — `scan.ts:345-351`, `schema.ts:46`: more than 200 services after the merge drops the candidate
`draft.compose.app` / `infra` are not sliced after the merge. Two files with 150 services each give 300, above the schema maximum of 200, and the candidate is left out.

**Fix:** cap the merged list at 200, and add a test.

### Doc nit
`docs/PLAN.md` still lists C15 as deferred, but V2 fixed it.

## Final whole-feature pass: no critical or major issues
Checked:
- **Keys:** stable across root order and case.
- **Names:** unique, ≤ 40 characters, sites get names first.
- **Kinds:** follow the enum.
- **Runner:** compose wins over the profile; a monorepo takes the highest rank.
- **Port:** order follows DESIGN.
- **Compose:** safe YAML, no env values, `files` lists only parsed files.
