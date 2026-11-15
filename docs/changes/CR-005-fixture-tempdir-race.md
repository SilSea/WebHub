# CR-005 — เทส F-000 นับ temp dir กลางของเครื่อง → ชนกับเทสอื่นที่ copy fixture พร้อมกัน

| | |
|---|---|
| Status | `review` |
| Feature ที่แก้ | F-000 (locked) |
| ประเภท | bugfix — test เท่านั้น (ไม่เปลี่ยน spec, ไม่แตะ `src/`, ไม่แตะ `test/helpers/`) |
| **อนุญาตโดย (R1)** | ผู้ใช้ / 2026-11-15 ("อนุญาต CR-005 ก่อน push") |
| เหตุ | หลัง merge F-005 เข้า `develop`: `test/unit/fixture-harness.test.ts` "rejects a missing fixture before creating any temp dir" ล่ม 1 ใน 3 รอบของชุดเต็ม (รันเดี่ยวผ่าน). เทสนับ `webhub-fx-*` ใน temp dir กลาง ก่อน/หลัง; `test/unit/profiles-fixtures.test.ts` (F-005) ใช้ `copyFixture` ใน worker อื่นพร้อมกัน → จำนวนเปลี่ยนจากเทสอื่น |

## 1. ของเดิม → ของใหม่
| ของเดิม | ของใหม่ | ทำไม |
|---|---|---|
| นับ `webhub-fx-*` ใน `os.tmpdir()` กลาง ก่อน/หลัง `copyFixture("does-not-exist")` | ชี้ `TEMP` / `TMP` / `TMPDIR` ของ worker นี้ไปที่ temp dir ส่วนตัว (ยืนยัน `tmpdir()` เปลี่ยนจริง) → `copyFixture` ต้อง throw "fixture not found" และ dir ส่วนตัวต้องว่าง → คืน env + ลบ dir | ไม่มีเทสอื่นเขียนลง dir ส่วนตัว → ไม่ชน; ยังพิสูจน์ "ไม่สร้าง temp dir ก่อนตรวจว่า fixture มีจริง" (mutation: `mkdtemp` ก่อนตรวจ → เทสล่ม) |

## 2. Impact matrix
| feature / config / data | โดนอะไร | ต้อง migrate ไหม |
|---|---|---|
| F-000 test (1 ตัว) | วิธีวัด | ไม่ |
| F-000 `test/helpers/fixture.ts` | ไม่แตะ | ไม่ |
| F-005 / ชุดเต็ม | กลับมาเขียวคงที่ → push `develop` ได้ | ไม่ |

## 3. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | ไม่ล่มผิด; เข้มขึ้น (dir ต้องว่างทั้งหมด ไม่ใช่แค่จำนวนเท่าเดิม); ไม่ขึ้นกับเวลา |
| ผลเสีย | แก้ `process.env` ของ worker ชั่วคราว — เทสอื่นใน**ไฟล์เดียวกัน**รันต่อกัน (ไม่ขนาน) และ env คืนใน `finally` จึงไม่กระทบ; พึ่งว่า `os.tmpdir()` อ่าน env ทุกครั้ง (Node ทำแบบนี้ทุก platform; มี `expect(tmpdir()).toBe(own)` กันไว้) |
| ทางเลือกที่ไม่เลือก | (1) ให้ `copyFixture` รับ temp root — แตะ helper ที่ทุกเทสใช้; (2) ให้เทส F-005 ไม่ copy fixture — ขัด DESIGN §21.5 (เทสบน copy + ยืนยัน Zero-touch); (3) ปิดการรันขนาน — ช้าทั้งชุด |

## 4. Migration + Rollback
- ไม่มี migration; rollback = revert commit ของ CR นี้

## 5. ขอบเขตการแก้ (ห้ามแตะนอกนี้)
- `test/unit/fixture-harness.test.ts`: เทส "rejects a missing fixture before creating any temp dir" เท่านั้น
- เอกสาร: CR นี้, spec F-000 (log), PLAN, features/README, reports `CR-005/`

## 6. Test plan
| # | กรณี | ยืนยันพฤติกรรมเก่าที่ไม่เปลี่ยน? | ผล |
|---|---|---|---|
| 1 | ไฟล์ `fixture-harness` ผ่าน 19/19; ชุดเต็ม 3/3 | ใช่ (ไม่แตะ helper) | test-1 |
| 2 | mutation ชั่วคราว: `mkdtemp` ก่อนตรวจว่า fixture มี → เทสล่ม; คืน helper แล้ว | — | test-1 |

## 7. Security impact (R6)
- ไม่เปลี่ยน attack surface (test เท่านั้น); การป้องกัน path / symlink ของ `copyFixture` ไม่แตะ

## 8. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/CR-005/test-1.md) | [review-1](../reports/CR-005/review-1.md) | (รวมใน review-1) | |

## 9. เอกสารที่อัปเดต (R4)
- [x] spec F-000 (log)  - [x] PLAN.md  - [x] features/README.md  - [ ] reports/README.md (ตอน done)
