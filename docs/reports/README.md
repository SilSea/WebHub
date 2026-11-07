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
| F-002 | 4 | [test-4](F-002/test-4.md) | [review-3](F-002/review-3.md) | [security-3](F-002/security-3.md) | in-progress — review รอบ 4 (ผู้ใช้อนุมัติเกิน 3 loop) |
| CR-001 | 1 | [test-1](CR-001/test-1.md) | [F-002 review-3](F-002/review-3.md) — OK | [F-002 security-3](F-002/security-3.md) — OK | review ผ่าน, รอ merge พร้อม F-002 |

## Regression
| วันที่ | ผล |
|---|---|
