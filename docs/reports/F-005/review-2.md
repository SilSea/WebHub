# Code + security review — F-005 — round 2 (focused)

| | |
|---|---|
| Date | 2026-11-14 |
| Scope | `git diff c929e32..ba99faa` (fixes for review-1 K1–K12, security-1 S1–S8) |
| Reviewer | separate agent; scratch copy; tsc + build + biome clean; F-005 suites 54/54 on Node 24 and 22.12; full suite 447/6; probes removed; no repo edits |
| Verdict | **PASS** — 0 critical, 0 major; 4 minor (L1–L4), 2 nit (L5, L6) |

## Round-1 status
| ID | Status |
|---|---|
| K1, K2, K3/S2, K4, K5, K7/S3, K8, K10, S1, S5, S7 | fixed |
| K11/S8 | fixed (documented, spec §3.4a) |
| K12 | fixed; spec §3.4 still mentions next `<13` (L6) |
| K6 | partly: `static-spa` `none` lists only package.json (L6) |
| K9 | partly: cumulative check covers prefixes 0..i only (L2); `null` only for `port.env` |
| S4 | partly: placeholder assembly + shorthand addresses (L1) |
| S6 | fixed, but the budget can disable `none` (L3) |

## New findings
| ID | Severity | Where | Scenario | Evidence | Fix |
|---|---|---|---|---|---|
| L1 | minor | `command.ts` `namesNonLoopback` / `renderCommand`; `schema.ts` | `--host 0.0.0.{Z}` + var `Z: "0"` renders `0.0.0.0`; shorthand forms pass: `0`, `--host=0`, `0.0`, `0x0`, `::0`, `0::`, `[::0]`, `0:0:0:0:0:0:0:0`, `0127.0.0.1`, `167772161` | **ran** | Check rendered arguments (load + render); refuse any IP literal (inet_aton forms, `::`) except 127/8 and `::1`; correct spec §6 |
| L2 | minor | `schema.ts` variants | Variant sets with a gap (V0 + V2 without V1) not checked → `port {via: env}` without `env` at dep 4.0.0 | **ran** | Check every subset when ≤ 8 variants, or validate in `effectiveProfile` |
| L3 | minor | `match.ts` | `none` shares the 64-read budget; exhausted → `none: fileContains` counts as not found → profile matches (built-ins unaffected) | **ran** | Separate budget for `none` or exhausted = hit |
| L4 | minor | `schema.ts` visitor; `MAX_PROFILE_BYTES` | `Map` handler stops `Node` calls for maps → 80k `{}` pass the node cap, tag check skipped for maps (warnings still catch); a 256 KB file costs 0.2–0.8 s to reject, 200 files ≈ 158 s CPU per `GET /api/v1/profiles` | **ran** | Count / tag-check in `Map` too; `MAX_PROFILE_BYTES` 32–64 KB; cache by (ino, size, mtime) |
| L5 | nit | `command.ts` | False positive on 4-part versions (`pip install x==0.110.0.1`) | ran | Check host-like arguments only, or document |
| L6 | nit | docs, profiles | Spec §3.4 next `<13`; review-1 / security-1 "status" sections say "asked the user" (fixed in `ba99faa`); `static-spa` `none` list | reasoned | Docs + append status; align `none` lists |

## Addendum to review-1 / security-1 status
K3, K5–K12 and S2–S8 (asked the user in round 1) were fixed in `ba99faa` — user chose "fix all".
