# Code + security review — F-001 — round 3

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | e2a0da5 (`git diff 526a4ba..e2a0da5`) |
| Reviewer | fresh reviewer agent (code + security); experiments on built `dist/`; `jsonErrorIndex` fuzzed vs `JSON.parse` (350k inputs, 0 disagreements) |

## Round-2 findings
| ID | Verdict | Note |
|---|---|---|
| N1 | FIXED | no `/T`; junction → `SYMLINK_REFUSED`, outside ACL untouched; inheritance propagation does not cross junctions |
| N2 (a) | FIXED | failures throw |
| N2 (b) | PARTIAL | entries created during the audit of an existing loose home are not checked (→ F1) |
| N2 (c) | FIXED | marker + exact ACL required |
| N3 | FIXED | small window remains (→ F4) |

## Round-1 minor/nit
R5/S6, R6, R7/S9, R8, R9, R10, R12, R13, S5, S8: FIXED. R11: PARTIAL (no test for `unknown` process state; dist freshness checks 2 files). S7: PARTIAL (→ F2).

## New findings
| ID | Severity | Location | Issue | Scenario | Fix |
|---|---|---|---|---|---|
| F1 | major | src/config/home.ts:131, 236-257 | Existing home with loose ACL: audit runs before restrict → entries created during the audit window never audited; marker then skips them forever | By reasoning: another user creates `data` with own protected DACL during Alice's first start of `C:\webhub-dev` → owns secrets/auth/state folder permanently; `icacls /reset` follows file symlinks without `/L` | Restrict home first whenever not exact, then audit/reset/marker; `/L` on per-entry reset |
| F2 | minor | src/config/config.ts:35 | "not equal to home" check case-sensitive | `runtimes.dir` = home with different case accepted | `relative(home, abs) === ""` |
| F3 | nit | src/config/home.ts:288-298 | entry vanishing during audit → "owned by another user" | concurrent tmp files | ignore not-found; separate message |
| F4 | nit | src/store/lock.ts:60-69 | `removeIf` link-back window | crashed takeover + ≥3 racing starters | document / shrink window |
| F5 | nit | json-store.ts:138; json-position.ts:98 | `.bak` hint for secrets; deep nesting → line 1 col 1 | misleading messages | doc-dependent hint; omit position on non-numeric throw |
| F6 | nit | src/proc/exec.ts:56 | `systemExe` throws plain `Error` | CLI shows internal error | `WebhubError` |

## Result
critical 0 · major 1 (F1) · minor 1 · nit 4 → not ready. Third loop reached (WORKFLOW W3 max 3) → owner decides how to continue.
