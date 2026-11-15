# CR-004 — เทส F-004 สองตัวล่มตอนเครื่องโหลด: timeout ของเทส + ขอบเวลาเทียบ baseline

| | |
|---|---|
| Status | `done` (2026-11-15) |
| Feature ที่แก้ | F-004 (locked) |
| ประเภท | bugfix — test เท่านั้น (ไม่เปลี่ยน spec, ไม่แตะ `src/`) |
| **อนุญาตโดย (R1)** | ผู้ใช้ / 2026-11-14 ("อนุญาต" — เทส H1) + 2026-11-15 ("รวมทั้ง 2 เทส, ทำก่อน merge") |
| เหตุ | ระหว่าง W3 ของ F-005 (ชุดเทสใหญ่ขึ้น): `test/unit/cli-stop.test.ts` "start waits for our stopping daemon to leave (review-4 H1)" ล่มด้วย timeout default 5 วิ (5024–5104 ms) 4 ครั้ง, 2/2 ในรอบหลัง; `test/integration/cli.test.ts` "an impostor on the port" ล่มที่ `stop --force` < 8 วิ 2 ใน ~7 รอบ — รันเดี่ยวผ่านทุกครั้ง |

## 1. ของเดิม → ของใหม่
| ของเดิม | ของใหม่ | ทำไม |
|---|---|---|
| H1: timeout ของเทส = default 5 วิ, start `timeoutMs: 5_000` | timeout ของเทส 30 วิ, start `timeoutMs: 15_000` | รันเดี่ยวใช้ ~3.1 วิ (`ensureHome` + spawn) ชิดขอบ 5 วิ; สิ่งที่เทสพิสูจน์ (รอ daemon เก่าออกก่อน, ≥ 3 ครั้งที่ดู, spawn จริง) ไม่ขึ้นกับเวลา |
| impostor: `stop --force` ต้อง < 8 วิ (เวลาจริง) | `stop --force` ต้อง < max(เวลา `status` ก่อน, หลัง stop) + 6 วิ (review-1 M1) | `status` ทำงานเดียวกัน (spawn CLI, proof, หา process บน port) แต่ไม่มี stop → baseline ของโหลดเครื่องขณะนั้น; stop ที่รอ 10 วิ เกิน baseline + 6 วิ **เมื่อโหลดใกล้กัน** (ขอบ ~4 วิ). ตัวจับที่ไม่ขึ้นกับโหลดคือ unit test `cli-stop.test.ts` "daemon dead, program on the port → DAEMON_IMPOSTOR at once" (fake platform — N1) |

## 2. Impact matrix
| feature / config / data | โดนอะไร | ต้อง migrate ไหม |
|---|---|---|
| F-004 tests (2 ตัว) | ขอบเวลาเท่านั้น | ไม่ |
| F-004 `src/` | ไม่แตะ | ไม่ |
| F-005 | merge ได้เมื่อชุดเต็มเขียว | ไม่ |

## 3. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | ไม่ล่มผิดตอนเครื่องโหลด; เงื่อนไขที่พิสูจน์ยังอยู่ครบ (impostor: ยังจับการรอ 10 วิได้ เพราะเทียบ baseline) |
| ผลเสีย | เทส H1 ที่ค้างจริงจะรู้ช้าลง (30 วิ แทน 5 วิ); baseline ของ impostor ผันผวนตามโหลด — ถ้า `status` ช้าผิดปกติ (> ~4 วิ เกินงานจริงของ stop) แต่ `stop` ไม่ช้า regression รอ 10 วิอาจผ่าน integration test ได้ — unit test (fake platform) ยังจับได้เสมอ |
| ทางเลือกที่ไม่เลือก | (1) ปิดการรันขนานของ vitest — ทั้งชุดช้าลงมาก; (2) ขอบคงที่ 9.5 วิ — ยัง flaky ได้ตอนโหลดหนัก; (3) ลบเงื่อนไขเวลา — เสียการพิสูจน์ "ไม่รอ 10 วิ" |

## 4. Migration + Rollback
- ไม่มี migration; rollback = revert commit ของ CR นี้

## 5. ขอบเขตการแก้ (ห้ามแตะนอกนี้)
- `test/unit/cli-stop.test.ts`: เทส "start waits for our stopping daemon to leave (review-4 H1)" เท่านั้น
- `test/integration/cli.test.ts`: เทส "an impostor on the port" เท่านั้น
- เอกสาร: CR นี้, spec F-004 (log), PLAN, features/README, reports `CR-004/`

## 6. Test plan
| # | กรณี | ยืนยันพฤติกรรมเก่าที่ไม่เปลี่ยน? | ผล |
|---|---|---|---|
| 1 | 2 เทสผ่านรันเดี่ยว และชุดเต็มบน branch 2/2 | ใช่ (ไม่แตะ `src/`) | test-1, test-2 |
| 2 | ชุดเต็มหลัง merge F-005 (ชุดใหญ่ที่ทำให้ล่ม) ผ่าน | ใช่ | test-1 |

## 7. Security impact (R6)
- ไม่เปลี่ยน attack surface (test เท่านั้น); threat model F-004 ไม่ต้องปรับ; เทส impostor ยังยืนยันว่าไม่ส่ง token

## 8. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/CR-004/test-1.md) | [review-1](../reports/CR-004/review-1.md) PASS (M1 minor, N1–N2 nit) | (รวมใน review-1) | ผู้ใช้: แก้ M1 + N1, N2 = follow-up |
| 2 | [test-2](../reports/CR-004/test-2.md) 393/6 ×2 | — | — | M1 + N1 แก้ → `done` |

## 9. เอกสารที่อัปเดต (R4)
- [x] spec F-004 (log)  - [x] PLAN.md  - [x] features/README.md  - [x] reports/README.md
