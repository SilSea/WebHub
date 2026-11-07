# Security review — F-000 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Diff | `develop..bb0fba1` |
| Reviewer | fresh agent; spot-checked by Claude |

## Checklist (WORKFLOW §8)
| Area | Result | Evidence |
|---|---|---|
| Network | n/a | no listeners |
| AuthN/AuthZ | n/a | — |
| Input | pass | no shell strings; pack test uses `execFileSync(process.execPath, [...])`; fixture name regex |
| Secrets | pass | `.env*` gitignored; no secrets in workflow |
| Privilege | n/a | — |
| Project code | n/a | — |
| Outbound | n/a | — |
| Docker | n/a | — |
| Dependencies | pass (see #1) | frozen lockfile, 109 integrity hashes, no git/tarball sources; lifecycle scripts blocked; `minimumReleaseAge` 24h verified (blocked biome 2.6.6); actions SHA-pinned and SHAs match tags; `permissions: contents: read`; `persist-credentials: false`; `pull_request` not `pull_request_target` |
| Data | n/a | — |
| Zero-touch | pass (see review #5) | harness works on temp copies; remove guard realpaths and requires `webhub-fx-` parent under tmpdir |

## Threat model — verified against code
| Threat (spec §6) | Mitigated | Proof |
|---|---|---|
| Compromised dependency install script | yes | `onlyBuiltDependencies: []`, frozen install |
| Tampered third-party action | yes | SHA pin, read-only permissions |
| Unintended files published | partly (#2) | `files` allowlist + pack test |
| Harness overwrites real fixture | yes (#4 future) | temp copy, remove guard, tests |

## Findings
| # | Severity | File:line | Issue | Fix | Status |
|---|---|---|---|---|---|
| 1 | minor | `.github/workflows/ci.yml` | Audit level differs from spec/checklist (same as review #1) | `pnpm run audit` | open |
| 2 | minor | `package.json` build, `tsconfig.build.json` | `dist/` never cleaned; pack allowlist accepts anything under `dist/` | Stale files could be published | Clean `dist` before build; pack test only allows `dist/*.js(.map)` matching `src/*.ts` | open |
| 3 | nit | `tsconfig.build.json` | Source maps reference `../src` not shipped (broken maps, no leak) | `inlineSources` or drop maps from package | open |
| 4 | nit | `test/helpers/fixture.ts` `copyFixture` | `verbatimSymlinks` could let a future fixture symlink point outside the temp copy | Reject symlinks in fixtures | open |
