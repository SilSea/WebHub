# Security review — F-000 — round 3 (final)

| | |
|---|---|
| Date | 2026-11-07 |
| Diff | `371e26f` |
| Reviewer | fresh agent; verified by Claude |

| ID | Verdict | Evidence |
|---|---|---|
| N1 (major) symlinked fixture dir | fixed | `lstat` rejects links before `isDirectory`; `realpath` containment; `assertNoSymlinks`; junction test runs on Windows, dir symlink on Linux |

Checklist (§8): Dependencies, Input, Secrets, Zero-touch — pass. CI unchanged (`contents: read`, SHA-pinned actions, `persist-credentials: false`). No new findings.

Open security findings: **0**.
