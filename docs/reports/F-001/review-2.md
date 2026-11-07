# Code + security review — F-001 — round 2

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 526a4ba (`git diff 2e3d5db..526a4ba`) |
| Reviewer | fresh reviewer agent (code + security); experiments on built `dist/` in scratchpad |

## Round-1 majors
| ID | Verdict | Evidence |
|---|---|---|
| R1 / S1 stale-lock race | FIXED | link() create + guarded takeover + verify(); 5 procs × 5 trials and 6 procs × 10 trials with stale guard → exactly 1 winner |
| R2 inaccessible process | FIXED | CIM tri-state; lsass / PID 4 → alive, 999999 → dead |
| R3 concurrent secrets | FIXED | per-store queue; failure does not block |
| R4 stdin crash | FIXED | 70 KB / 300 KB / 2 MB early-exit children → exit code, no crash |
| S2 owner check | PARTIAL | home + parent checked; children not (→ N2) |
| S3 child ACLs | PARTIAL | reported case fixed; fast path, silent icacls failures, junction traversal (→ N1, N2) |

## New findings
| ID | Severity | Location | Issue | Scenario | Fix |
|---|---|---|---|---|---|
| N1 | major | src/config/home.ts:225 | `icacls <home> /reset /T` follows junctions inside home → resets ACLs outside (R0) | Reproduced: junction `home\data\link` → outside protected file loses protection / explicit grants wiped | No `/T` across reparse points; own walk that refuses junctions |
| N2 | major | src/config/home.ts:127-129, 217-246 | (a) `icacls /C` exits 0 with failures; (b) child owners not checked (owner keeps WRITE_DAC); (c) exact-home fast path skips tree | Reproduced (a) and (c); (b) by reasoning: other user creates `home\data` in the creation window, re-opens ACL later | Lock home right after mkdir; full tree audit (owner, explicit ACE, reparse) without fast-path bypass; treat "Failed processing N>0" as error |
| N3 | minor | src/store/lock.ts:153-161 | Stale-guard break and guard removal not token-checked | By reasoning (not reproduced): crash in takeover + concurrent starters → two guard holders | Token in guard; remove-if-ours via atomic move |

## Result
critical 0 · major 2 (N1, N2) · minor 1 (N3) → not ready; round 3.
