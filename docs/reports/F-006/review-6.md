# Review — F-006 — round 6 (W1 / W2 diff)

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `456e64b` (`feat/F-006-scanner`) |
| Reviewer | AI agent, separate from the author |
| PoC | scratchpad `f006-r6/poc.mjs` (outside the repo), run against `dist/` |

## Verdict: **PASS** (0 critical, 0 major, 1 minor, 3 nit)
Build is clean. Tests pass 53/53.

## Status
- **W1:** fixed, except for X1. One base file and one override are read. Extra files are recorded as a problem. An override alone gives no compose.
- **W2:** fixed. At most 200 services.
- **Consumers:**
  - `detect` and `portHint` use the merged services.
  - `ownCompose` works.
  - `MARKERS` and fingerprints still recognise all 8 file names.
- **Security:** problem messages are fixed strings or `ComposeError` codes plus the path, with no file content (checked with an override that holds an `environment` secret). Problems are capped at 500.

## Edge cases
| Case | Result | Matches docker |
|---|---|---|
| `compose.yaml` + `compose.yml` | reads `.yaml` | yes |
| `docker-compose.yaml` + `.yml` | reads `.yaml` | **no**: docker reads `.yml` (X1) |
| `compose.override.yaml` + `.yml` | reads `.yaml` | **no**: docker reads `.yml` (X1) |
| broken base | no compose + problem | acceptable |
| broken override | base only + problem | docker errors (X3) |
| override only | no compose + problem | yes |
| upper-case names | matched | yes on Windows (X4) |
| unreadable base | no compose, no problem | X2 |

## Findings

### X1 — minor — `compose.ts:10-24`: preference order differs from compose-go
compose-go uses:
- bases: `compose.yaml, compose.yml, docker-compose.yml, docker-compose.yaml`
- overrides: `compose.override.yml, compose.override.yaml, docker-compose.override.yml, docker-compose.override.yaml`

So a folder that has both spellings gets the wrong file; in the PoC the port was 1111 where docker uses 2222.

**Fix:** declare both lists explicitly in compose-go order, and add a test.

### X2 — nit — `scan.ts:296`: an unreadable compose file is skipped silently
**Fix:** add a problem "could not read compose file", except when the budget is the cause.

### X3 — nit — `scan.ts:303`: a broken override still gives `compose` from the base
Docker refuses to run in this case. The problem is recorded, and F-007 approval covers it.

**Fix:** document it in the spec.

### X4 — nit — `scan.ts:281`: names are matched without case
That is correct on Windows; Linux docker is case-sensitive. The message for an extra override says "first compose file".

**Fix:** document the Linux difference, and use a separate message for extra overrides.
