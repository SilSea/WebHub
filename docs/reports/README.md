# Reports index

Report แยกไฟล์ append-only (WORKFLOW R5). Template: [`../templates/`](../templates/)

## Design reviews
| Report | Version | Findings | ผล |
|---|---|---|---|
| [design/review-v7.md](design/review-v7.md) | v7 → v8 | 16 | แก้ครบ (`bf55188`) |
| [design/review-v8.md](design/review-v8.md) | v8 → v9 | 9 | แก้ครบ (`28c0cae`) |

## Features / CR
| ID | รอบล่าสุด | test | review | security | ผล |
|---|---|---|---|---|---|
| F-000 | 3 | [test-3](F-000/test-3.md) | [review-3](F-000/review-3.md) | [security-3](F-000/security-3.md) | done — critical/major/security 0 |
| F-001 | 5 | [test-5](F-001/test-5.md) | [review-4](F-001/review-4.md) | (รวมใน review-2…4; [security-1](F-001/security-1.md)) | done — critical/major 0; minor/nit แก้ครบตามผู้ใช้สั่ง |
| F-002 | 5 | [test-5](F-002/test-5.md) | [review-4](F-002/review-4.md) | [security-4](F-002/security-4.md) | done — review-4 / security-4: critical/major 0; minor/nit แก้ทั้งหมดตามผู้ใช้สั่ง (test-5); ผู้ใช้ไม่ขอ review รอบ 5 |
| CR-001 | 1 | [test-1](CR-001/test-1.md) | [F-002 review-3](F-002/review-3.md) — OK | [F-002 security-3](F-002/security-3.md) — OK | done — merge พร้อม F-002 |
| F-003 | 9 | [test-9](F-003/test-9.md) | [review-8](F-003/review-8.md) | [security-8](F-003/security-8.md) — PASS | done — 8 รอบ review; ผู้ใช้ตัดสิน residual (N3, L3, CPU DoS ในเครื่อง); minor/nit รอบ 8 แก้ครบ; ไม่มีรอบ 9 ตามผู้ใช้ |
| CR-002 | 2 | [test-2](CR-002/test-2.md) | [review-1](CR-002/review-1.md) — PASS | [security-1](CR-002/security-1.md) — PASS | done — minor แก้ครบตามผู้ใช้สั่ง |
| F-004 | 5 | [test-5](F-004/test-5.md) | [review-4](F-004/review-4.md) — PASS | [security-1](F-004/security-1.md) FAIL → รอบ 2–4 รวมใน review — PASS | done — review-1 C1/C2 major + security-1 D1 critical, review-2 E1 major แก้แล้ว; minor/nit ทุกรอบแก้ครบตามผู้ใช้สั่ง; ไม่มี review รอบ 5 ตามผู้ใช้ |
| CR-003 | 3 | [test-3](CR-003/test-3.md) | [review-2](CR-003/review-2.md) — PASS | [security-1](CR-003/security-1.md) — PASS; รอบ 2 รวมใน review-2 — PASS | done — review-1 Z1 major แก้แล้ว; minor/nit/info ทั้งสองรอบแก้ครบตามผู้ใช้สั่ง; ไม่มี review รอบ 3 ตามผู้ใช้ |

## Regression
| วันที่ | ผล |
|---|---|
| 2026-11-07 | `develop` หลัง merge CR-001 + F-002 (`ad7988d`): lint, typecheck, build, test:full 173 pass / 5 skip, audit — ผ่าน (Windows, Node 24.20; CI ถูกบล็อกจาก billing) |
| 2026-11-08 | `develop` หลัง merge CR-002 + F-003 (`98dd58d`): lint, typecheck, build, test:full 248 pass / 5 skip, audit — ผ่าน (Windows, Node 24.20; ชุด F-003 ผ่าน Node 22.12 ด้วย; CI ถูกบล็อกจาก billing) |
| 2026-11-13 | `develop` หลัง merge CR-003 (`a1384fd`): lint, typecheck, build, test:full 300 pass / 6 skip, audit — ผ่าน (Windows, Node 24.20; ชุด CR-003 ผ่าน Node 22.12 ด้วย; CI ถูกบล็อกจาก billing) |
