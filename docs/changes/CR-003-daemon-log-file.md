# CR-003 — daemon รับ `--log-file`: เขียน log ลงไฟล์เอง + จำกัดขนาดเป็น byte

| | |
|---|---|
| Status | `planned` |
| Feature ที่แก้ | F-003 (locked) |
| ประเภท | change (เพิ่ม option ใหม่; ไม่ส่ง option = พฤติกรรมเดิมทุกอย่าง) |
| **อนุญาตโดย (R1)** | ผู้ใช้ / 2026-11-13 ("อนุญาต + อนุมัติ", "ทำเลย"; แนวทางเลือกใน F-004 Q1 = A) |
| เหตุ | ข้อกำหนดจาก F-003 security-6 U4 / security-8 Y1 + Y2: log ของ daemon ต้องจำกัดขนาดเป็น byte และห้ามส่ง stdout เข้า pipe ที่ CLI ถือ. F-003 เขียน log ลง stdout อย่างเดียว → CLI (F-004) จำกัดขนาดระหว่างรันไม่ได้ |

## 1. ของเดิม → ของใหม่
| ของเดิม | ของใหม่ | ทำไม |
|---|---|---|
| `node dist/daemon.js` ไม่รับ argument; log = JSON lines ลง stdout | รับ `--log-file <path>` (ตัวเดียว, ไม่บังคับ). ส่ง → log บรรทัดเดิมเขียนลงไฟล์นั้น (append, sync) แทน stdout; ก่อนเขียนบรรทัดที่ทำให้ไฟล์เกิน **5 MB** → rename เป็น `<path>.1` (ทับของเก่า) แล้วเริ่มไฟล์ใหม่ → รวม ≤ ~10 MB. ไม่ส่ง → stdout เหมือนเดิม | CLI spawn แบบ detached ด้วย stdio `ignore` / file fd ได้ (ไม่มี pipe — Y2) และ flood ที่ยอมรับเป็น residual (security-7/8) ไม่กิน disk (U4/Y1) |
| — | path ต้องอยู่**ใน `logs/` ของ `$WEBHUB_HOME`** (`isInside` + `assertSafePath` ของ F-001: ไม่ตาม symlink/junction), ไฟล์ต้องเป็น regular file หรือยังไม่มี | กันเขียนทับไฟล์นอก home ผ่าน argument / symlink |
| argument แปลก / ผิด | → stderr `webhub daemon: …` + exit **2** (ก่อน start, ไม่แตะ lock) | เหมือน config ผิด (exit code ตาราง F-003) |
| เขียนไฟล์ไม่ได้ (disk เต็ม, ไฟล์ถูกล็อก) | ทิ้งบรรทัดนั้น, ไม่ล้ม, ลองเปิดใหม่ตอน rotate ครั้งถัดไป | log ห้ามทำให้ daemon ตาย (เหมือน EPIPE ของ stdout — K2) |

`stderr` (error ตอน start + ชื่อ class ตอน crash) ไม่เปลี่ยน — CLI ส่งไปไฟล์ `logs/daemon-start.err` ผ่าน fd (F-004)

## 2. Impact matrix
| feature / config / data | โดนอะไร | ต้อง migrate ไหม |
|---|---|---|
| F-003 `src/daemon.ts` `main()` | parse `--log-file`, ส่ง `log` ไปยัง `startDaemon` (option `log` มีอยู่แล้ว) | ไม่ |
| F-003 ใหม่ `src/server/log-file.ts` | writer + rotate | ไม่ |
| F-003 test | เพิ่ม; เทสเดิมไม่เปลี่ยน (ไม่ส่ง flag) | ไม่ |
| F-001 / F-002 | ใช้ `assertSafePath` / `isInside` เท่านั้น | ไม่ |
| `$WEBHUB_HOME/logs/` | มีไฟล์ `daemon.log`, `daemon.log.1` (ACL ของ home) | ไม่ |
| F-004 | ใช้ flag นี้ตอน spawn | — |

## 3. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | cap จริงระหว่างรัน; ไม่มี process เพิ่ม; logic signal/crash ของ `main()` อยู่ที่เดียว; ไม่ส่ง flag = เหมือนเดิม 100% |
| ผลเสีย | แก้ feature ที่ done; เขียน sync ทุกบรรทัด (บรรทัด ≤ 512 B — Y1, ต้นทุนต่ำ แต่ flood = I/O เพิ่ม); rotate 2 ไฟล์ = log เก่าหาย |
| ทางเลือกที่ไม่เลือก | (B) CLI rotate ตอน start — ไม่ cap ระหว่างรัน; (C) log pump process — pump ค้าง = daemon ค้าง; (D) entry ใหม่เรียก `startDaemon({log})` — ลอก signal/crash handling 2 ที่; รวมบรรทัด 4xx ซ้ำ — ลดแต่ไม่ cap |

## 4. Migration + Rollback
- ไม่มี schema / data ใหม่
- rollback: revert commit; F-004 ต้อง revert คู่กัน (ใช้ flag)

## 5. ขอบเขตการแก้ (ห้ามแตะนอกนี้)
- `src/daemon.ts` (เฉพาะ `main()` + helper parse argument)
- `src/server/log-file.ts` (ใหม่)
- `test/unit/log-file.test.ts` (ใหม่), `test/integration/daemon.test.ts` (เพิ่ม test เท่านั้น)
- docs: spec F-003 (§3, §6, §8, log), CR นี้, PLAN, features/README, reports

## 6. Test plan
| # | กรณี | ยืนยันพฤติกรรมเก่าที่ไม่เปลี่ยน? | ผล |
|---|---|---|---|
| 1 | ไม่ส่ง flag → log ไป stdout เหมือนเดิม (เทส F-003 เดิมผ่านทั้งหมด) | ใช่ | |
| 2 | `--log-file logs/daemon.log` → "ready" อยู่ในไฟล์, stdout ว่าง | — | |
| 3 | เขียนเกิน 5 MB → `daemon.log` ≤ 5 MB + `.1` มี, บรรทัดไม่ขาดกลาง | — | |
| 4 | path นอก `logs/`, `..`, symlink/junction, เป็น directory → exit 2, ไม่มี auth.json, ไม่ถือ lock | — | |
| 5 | argument แปลก / `--log-file` ไม่มีค่า / ซ้ำ → exit 2 | — | |
| 6 | ไฟล์เขียนไม่ได้ระหว่างรัน (mock `writeSync` throw) → daemon ยังตอบ API | — | |
| 7 | flood 4xx (เหมือน security-8 Y1) กับ cap เล็ก (test option) → ขนาดรวมไม่เกิน cap × 2 | — | |
| 8 | suite F-003 บน Node 22.12 | ใช่ | |

## 7. Security impact (R6)
- input ใหม่: argument ของ process (มาจาก CLI ของผู้ใช้เอง) → validate path ใน `logs/`, ไม่ตาม link
- ไม่มี port / endpoint / secret ใหม่; log ไม่มี token (เหมือนเดิม — F-003 §6)
- threat model F-003 เพิ่มแถว: "disk เต็มจาก log flood → cap" และ "argument ชี้ไฟล์นอก home → ปฏิเสธ"

## 8. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|

## 9. เอกสารที่อัปเดต (R4)
- [ ] spec F-003  - [ ] DESIGN.md §12 (log)  - [ ] PLAN.md  - [ ] features/README.md  - [ ] reports/README.md
