# CR-001 — pack test: allow `src/*.mts` → `dist/*.mjs`

| | |
|---|---|
| Status | `review` |
| Feature ที่แก้ | F-000 (locked) |
| ประเภท | change (test ของ F-000 รับนามสกุลเพิ่ม 1 คู่) |
| **อนุญาตโดย (R1)** | ผู้ใช้ / 2026-11-07 ("Approve mini-CR") |
| เหตุ | F-002 security-2 T3: entry ที่รันเป็น admin ต้องเป็นไฟล์เดียวที่ไม่ import อะไรนอกจาก `node:*` → `src/platform/elevated.mts` build เป็น `dist/platform/elevated.mjs` (`.mjs` = node ไม่ต้องอ่าน `package.json` เพื่อตัดสิน module type) |

## 1. ของเดิม → ของใหม่
| ของเดิม | ของใหม่ | ทำไม |
|---|---|---|
| `expectedDist()` ยอมเฉพาะ `dist/<n>.js(.map)` เมื่อมี `src/<n>.ts` | ยอมเพิ่ม `dist/<n>.mjs(.map)` เมื่อมี `src/<n>.mts` (ข้าม `.d.ts`/`.d.mts`) | `.mjs` ที่ build จาก `.mts` เป็นไฟล์ที่ตั้งใจ publish; กฎ "publish เฉพาะของที่ build จาก source" ยังเหมือนเดิม |

## 2. Impact matrix
| feature / config / data | โดนอะไร | ต้อง migrate ไหม |
|---|---|---|
| F-000 pack test | allowlist เพิ่ม 1 คู่นามสกุล; ไฟล์อื่นที่ไม่ได้ build จาก source ยังถูกจับเหมือนเดิม | ไม่ |
| F-001 | ไม่ | ไม่ |
| F-002 | ทำให้ pack test ผ่านกับ `elevated.mjs` | ไม่ |

## 3. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | entry admin ไม่ต้องพึ่ง `package.json` "type" → trust check ของ F-002 เล็กลง (node.exe + 1 ไฟล์ + โฟลเดอร์แม่) |
| ผลเสีย | แก้ test ของ feature ที่ done (เล็กมาก) |
| ทางเลือกที่ไม่เลือก | คง `elevated.js` — node อ่าน `package.json` ที่อยู่สูงขึ้นไปเพื่อตัดสิน type → ต้องตรวจ `package.json` เพิ่ม และคนที่เพิ่ม `dist/package.json` ได้ทำ elevate พังได้ |

## 4. Migration + Rollback
- ไม่มี migration; rollback = revert commit ของ CR นี้ (+ F-002 กลับไปใช้ `.js`)

## 5. ขอบเขตการแก้ (ห้ามแตะนอกนี้)
- `test/integration/pack.test.ts` ฟังก์ชัน `expectedDist()` เท่านั้น

## 6. Test plan
| # | กรณี | ยืนยันพฤติกรรมเก่าที่ไม่เปลี่ยน? | ผล |
|---|---|---|---|
| 1 | develop (ไม่มี `.mts`): pack test ผ่านเหมือนเดิม | ใช่ | ดู test-1 |
| 2 | F-002 branch: `dist/platform/elevated.mjs(.map)` ผ่าน; ไฟล์แปลกอื่นยังถูกจับ | ใช่ | ดู test-1 |

## 7. Security impact (R6)
- attack surface ไม่เปลี่ยน: ยังห้าม publish ไฟล์ที่ไม่ได้ build จาก source; `.mjs` ต้องมี `.mts` คู่กันใน `src/`

## 8. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/CR-001/test-1.md) | [F-002 review-3](../reports/F-002/review-3.md) — OK | [F-002 security-3](../reports/F-002/security-3.md) — OK | ผ่าน |

## 9. เอกสารที่อัปเดต (R4)
- [x] spec F-000 (หมายเหตุ CR-001)  - [x] features/README.md  - [x] reports/README.md
