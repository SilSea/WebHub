# CR-002 — test lock race ของ F-001: ตรวจว่า "ไม่ถือ lock ซ้อนกัน" แทน "ชนะตัวเดียว"

| | |
|---|---|
| Status | `review` |
| Feature ที่แก้ | F-001 (locked) |
| ประเภท | bugfix — test เท่านั้น (ไม่เปลี่ยน spec, ไม่แตะ `src/`) |
| **อนุญาตโดย (R1)** | ผู้ใช้ / 2026-11-08 ("อนุญาต ทำเลย") |
| เหตุ | ระหว่าง W3 ของ F-003, `test/integration/store.test.ts` "4 processes taking over the same stale lock → exactly one wins" fail 4 ครั้ง (เครื่องโหลดหนัก, `expected [ 'WON', 'WON' ] to have a length of 1`) — รันเดี่ยวผ่าน |

## 1. ของเดิม → ของใหม่
| ของเดิม | ของใหม่ | ทำไม |
|---|---|---|
| racer ถือ lock 2 วิ แล้วปล่อย; test ยืนยัน `WON` = 1 และ `LOST` = 3 | racer พิมพ์เวลาได้ lock + เวลาปล่อย; test ยืนยัน (ก) มีผู้ชนะ ≥ 1, (ข) ช่วงถือ lock ของผู้ชนะ**ไม่ซ้อนกัน**, (ค) ที่เหลือ `LOST` (ไม่มี `ERR`) | สิ่งที่ lock ต้องรับประกันคือ mutual exclusion ไม่ใช่ "ชนะได้ตัวเดียวตลอดกาล" — racer ที่ช้าเกิน 2 วิ (PowerShell CIM ใน `isStale` ช้าตอนเครื่องโหลด) ได้ lock ที่ว่างแล้วหลังตัวแรกปล่อย = ถูกต้อง แต่ test เดิมนับเป็น fail |

**สาเหตุ (ยืนยันแล้ว).** Spike นอก repo `scratchpad/f001-race/` รัน racer 4 ตัว × 20 รอบ กับ `dist/store/lock.js` ระหว่างที่ `pnpm test:full` รันอยู่ — 4 รอบมีผู้ชนะ 2 ตัว และ**ทุกครั้งเป็นแบบต่อกัน** (ตัวที่ 2 ได้ lock หลังตัวแรกปล่อยแล้ว) ไม่มีซ้อน → โค้ด lock ถูก, test ตั้งสมมติฐานผิด. รันแบบ CPU เต็มอย่างเดียว (ไม่มี I/O ของ suite) 8 รอบ ไม่เกิด.

## 2. Impact matrix
| feature / config / data | โดนอะไร | ต้อง migrate ไหม |
|---|---|---|
| F-001 test `store.test.ts` (racer + 1 test) | เปลี่ยนเงื่อนไขที่ตรวจ: เข้มขึ้นเรื่อง overlap, ยอมผู้ชนะต่อกัน | ไม่ |
| F-001 `src/store/lock.ts` | ไม่แตะ | ไม่ |
| F-002 / F-003 | ไม่ (full suite กลับมาผ่านคงที่ → merge F-003 ได้) | ไม่ |

## 3. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | test ตรวจสิ่งที่ lock สัญญาจริง (ไม่ถือซ้อน) และจับ bug จริงได้ดีกว่าเดิม (เดิมผู้ชนะซ้อนกัน 2 ตัวแบบ "ตัวหนึ่ง ERR" อาจหลุด); ไม่ flaky ตามโหลด |
| ผลเสีย | แก้ test ของ feature ที่ done; เทียบเวลาข้าม process ใช้นาฬิกาเครื่องเดียวกัน (`Date.now()`) — ถ้านาฬิกาถูกปรับระหว่าง test อาจผิด (เกิดยาก, ทำให้ fail ไม่ใช่ผ่านผิด ถ้าถอยหลัง) |
| ทางเลือกที่ไม่เลือก | (1) ถือ lock นานขึ้น (เช่น 15 วิ) — ลดโอกาสแต่ยัง flaky และ test ช้า; (2) ให้ผู้ชนะถือจนทุก racer จบ (ไฟล์สัญญาณ) — ตรง "ชนะตัวเดียว" แต่ซับซ้อนกว่าและพิสูจน์น้อยกว่า; (3) แก้ `lock.ts` — ไม่มี bug ให้แก้ |

## 4. Migration + Rollback
- ไม่มี migration; rollback = revert commit ของ CR นี้

## 5. ขอบเขตการแก้ (ห้ามแตะนอกนี้)
- `test/integration/store.test.ts`: ฟังก์ชัน `racer()` และ test "stale lock race across processes" เท่านั้น
- เอกสาร: CR นี้, spec F-001 (แถว test ที่เกี่ยว + log), PLAN §0, reports `CR-002/`

## 6. Test plan
| # | กรณี | ยืนยันพฤติกรรมเก่าที่ไม่เปลี่ยน? | ผล |
|---|---|---|---|
| 1 | test ใหม่ผ่านรันเดี่ยว 10 ครั้ง และใน `pnpm test:full` 3 ครั้ง | ใช่ (lock ไม่แตะ) | ดู test-1 |
| 2 | mutation: ทำให้ `takeOver` ลบ lock ที่ไม่ stale (ข้ามการตรวจ `judged`) ใน build ชั่วคราว → test ใหม่ fail (จับ overlap ได้) | — | ดู test-1 |
| 3 | test อื่นของ F-001 ไม่เปลี่ยน, ผ่าน | ใช่ | ดู test-1 |

## 7. Security impact (R6)
- ไม่เปลี่ยน attack surface (test เท่านั้น); threat model F-001 ไม่ต้องปรับ

## 8. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/CR-002/test-1.md) | [review-1](../reports/CR-002/review-1.md) | [security-1](../reports/CR-002/security-1.md) | |

## 9. เอกสารที่อัปเดต (R4)
- [ ] spec F-001  - [ ] PLAN.md  - [ ] features/README.md  - [ ] reports/README.md
