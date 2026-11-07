# CR-xxx — <แก้อะไร>

| | |
|---|---|
| Status | `draft` → `approved` / `rejected` → `in-progress` → `testing` → `review` → `done` |
| Feature ที่แก้ | F-xxx (locked) |
| ประเภท | change (เปลี่ยน spec) / bugfix (ไม่เปลี่ยน spec) / refactor (ไม่เปลี่ยนพฤติกรรม) |
| **อนุญาตโดย (R1)** | <ผู้ใช้> / วันที่ — ไม่มี = ห้ามเริ่ม |

## 1. ของเดิม → ของใหม่
| ของเดิม | ของใหม่ | ทำไม |
|---|---|---|

(bugfix: สาเหตุ + วิธีทำให้เกิดซ้ำ)

## 2. Impact matrix
| feature / config / data | โดนอะไร | ต้อง migrate ไหม |
|---|---|---|

## 3. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | |
| ผลเสีย | |
| ทางเลือกที่ไม่เลือก | |

## 4. Migration + Rollback
- migration (config/data schemaVersion)
- rollback ถ้าพัง

## 5. ขอบเขตการแก้ (ห้ามแตะนอกนี้)
- ไฟล์ / module ที่แก้ได้

## 6. Test plan
| # | กรณี | ยืนยันพฤติกรรมเก่าที่ไม่เปลี่ยน? | ผล |
|---|---|---|---|

## 7. Security impact (R6)
- เปลี่ยน attack surface ไหม (port, endpoint, สิทธิ์, secret, input ใหม่)
- threat model ของ F-xxx ที่ต้องปรับ

## 8. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/CR-xxx/test-1.md) | [review-1](../reports/CR-xxx/review-1.md) | [security-1](../reports/CR-xxx/security-1.md) | |

## 9. เอกสารที่อัปเดต (R4)
- [ ] spec F-xxx  - [ ] DESIGN.md §…  - [ ] PLAN.md  - [ ] features/README.md  - [ ] reports/README.md
