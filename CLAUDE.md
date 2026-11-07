# webhub — กฎสำหรับการทำงาน (คนและ AI)

อ่านก่อนทำงานทุกครั้ง:
- Design: `DESIGN.md` · ขั้นตอน: `docs/WORKFLOW.md` · แผน: `docs/PLAN.md` · สถานะ feature: `docs/features/README.md`

## กฎ (บังคับ — รายละเอียดใน docs/WORKFLOW.md)
- **R0 Zero-touch** — ห้ามแก้ไฟล์ใน project ของผู้ใช้; ทุก config/env ผ่าน webhub
- **R1** — ห้ามแก้ feature ที่ `done` โดยไม่ได้รับอนุญาต (ต้องมี CR ที่ผู้ใช้อนุมัติ)
- **R2** — ห้ามเขียนโค้ดก่อนมี spec/CR ที่ `approved` (spike ได้เฉพาะใน scratchpad นอก repo)
- **R3** — ทุก spec/CR วิเคราะห์ผลดี / ผลเสีย / ทางเลือก / impact
- **R4** — ทุกการเปลี่ยนต้องอัปเดตเอกสารที่เกี่ยวข้อง
- **R5** — report (test / review / security / manual coverage) แยกไฟล์ใน `docs/reports/`, append-only
- **R6** — security สูงสุด: secure by default, threat model ทุก spec, security review แยกทุก function

## Workflow
1. สร้าง function: ออกแบบ → ถามความเห็น → เอกสาร → implement (ไม่กระทบของเดิม) → ทดสอบ → code review + security review → แก้ critical/major จนเป็น 0
2. แก้ function: เหมือนข้อ 1 แต่เริ่มจาก CR + ขออนุญาตก่อน
3. คู่มือ: วิเคราะห์ระบบ → คู่มือ HTML เปิดจากไฟล์ได้ (`docs/manual/`) → ตรวจความครบถ้วน

## การสื่อสาร
- ถามผู้ใช้เป็นภาษาไทย; ไม่ตัดสินใจแทนในขั้น "ถามความเห็น" และการขออนุญาตแก้ feature
- branch: `develop` (หลัก), `feat/F-xxx-<name>`, `fix/CR-xxx-<name>`; commit อ้าง F-xxx / CR-xxx
