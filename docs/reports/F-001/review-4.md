# Code + security review — F-001 — round 4

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | fb95838 (`git diff e2a0da5..fb95838`) |
| Reviewer | fresh reviewer agent (code + security); unit tests + 3 experiments on built `dist/` |

## Round-3 findings
| ID | Verdict | Note |
|---|---|---|
| F1 | FIXED (stated scenario) | restrict before audit; children created earlier are foreign-owned → refused; `/L` on resets. Narrower case → G2 |
| F2 | FIXED | case variants and trailing `.` rejected |
| F3 | FIXED | vanished entries ignored; unreadable has own message |
| F4 | FIXED (documented, smaller window) | |
| F5 | FIXED | |
| F6 | FIXED | |

## New findings
| ID | Severity | Location | Issue | Scenario | Fix |
|---|---|---|---|---|---|
| G1 | minor | src/config/home.ts:132 | Existing folder gets its ACL rewritten before checks that refuse it | Reproduced: existing home + junction → `SYMLINK_REFUSED` but ACL already changed (Administrators dropped, children changed). `WEBHUB_HOME` set by mistake to Documents/project keeps changed ACLs | Read-only checks first (owner + "is a webhub home") → refuse untouched |
| G2 | minor (borderline major) | src/config/home.ts:132, 236-266 | Children with explicit/protected ACLs are not changed by restricting home; with "bypass traverse" another user can add entries inside them after the audit listed them | By reasoning; needs home under a location granting other users Full Control | Re-audit after reset; marker only if second pass is clean |
| G3 | nit | test/unit/hardening-r3.test.ts:21-35 | F1 test cannot distinguish new order from old | regression would pass | test ordering-sensitive behaviour |

## Result
critical 0 · major 0 · minor 2 · nit 1. Owner decision: "แก้ทั้งหมดแล้ว merge" (no round 5).
