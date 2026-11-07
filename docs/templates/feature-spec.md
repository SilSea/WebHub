# F-xxx — <ชื่อ function>

| | |
|---|---|
| Status | `draft` → `planned` → `in-progress` → `testing` → `review` → `done` |
| Phase | MVP-x (PLAN.md) |
| DESIGN.md | §x.y |
| Depends on | F-xxx, … |
| Owner อนุมัติ | <ผู้ใช้> / วันที่ |

## 1. เป้าหมาย / ขอบเขต
- ทำอะไร (in scope)
- ไม่ทำอะไร (out of scope)

## 2. ระบบเดิมรองรับยังไง (R2)
- ส่วนของ design/โค้ดเดิมที่ใช้ต่อ
- design ที่ต้องเพิ่ม/ปรับใน DESIGN.md (ถ้ามี → อ้างแถวใน §17)

## 3. Design
- Interface (TypeScript signature / REST endpoint / CLI / config key)
- Data / schema (ไฟล์ใน `$WEBHUB_HOME`, schemaVersion, migration)
- Flow (ปกติ + error + rollback)
- Platform (Windows / Lite mode / ผ่าน Platform layer)

## 4. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | |
| ผลเสีย | |
| ทางเลือกที่ไม่เลือก + เหตุผล | |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done แล้ว | | |
| Zero-touch | | |
| Security | | |
| Performance / resource | | |
| Config / data เดิม | | |

## 6. Threat model (R6)
| Asset (ปกป้องอะไร) | ผู้โจมตี / ช่องทาง | ป้องกันด้วย | เทส |
|---|---|---|---|

Security checklist (WORKFLOW §6) ข้อที่เกี่ยว: …

## 7. คำถามถึงผู้ใช้ (ขั้น ②)
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|

## 8. Test plan
| # | กรณี | ประเภท (unit/integration/regression/fixture/security) |
|---|---|---|

## 9. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/F-xxx/test-1.md) | [review-1](../reports/F-xxx/review-1.md) | [security-1](../reports/F-xxx/security-1.md) | |

## 10. เอกสารที่อัปเดต (R4)
- [ ] DESIGN.md §…  - [ ] PLAN.md  - [ ] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
