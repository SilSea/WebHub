# Workflow — การสร้าง / แก้ไข function

ใช้กับทุกงานใน webhub (ทั้งคนและ AI). อ้างอิง design หลัก: [`DESIGN.md`](../DESIGN.md), แผน: [`PLAN.md`](PLAN.md)

---

## กฎ (บังคับ)

| # | กฎ | ความหมายในทางปฏิบัติ |
|---|---|---|
| R1 | **ห้ามแก้ feature โดยไม่ได้รับอนุญาต** | feature ที่ status `done` ใน [`features/README.md`](features/README.md) = locked. จะแตะพฤติกรรม/API/config/schema ของมัน → ต้องมี Change Request (CR) ที่เจ้าของอนุมัติก่อน. แก้บั๊คที่ไม่เปลี่ยน spec ก็ต้องแจ้งใน CR แบบสั้น |
| R2 | **ห้ามเขียนโค้ดก่อนออกแบบ** | ต้องมี Feature Spec / CR ที่ status `approved` ก่อนเขียนโค้ดบรรทัดแรก. spec ต้องบอกว่าระบบเดิม (DESIGN.md) รองรับยังไง หรือต้องปรับ design ส่วนไหน |
| R3 | **วิเคราะห์ผลดี / ผลเสียทุกครั้ง** | ทุก spec / CR มีหัวข้อ "ผลดี / ผลเสีย / ทางเลือกที่ไม่เลือก" + ผลกระทบต่อ feature เดิม, Zero-touch, security, performance |
| R4 | **ต้องอัปเดตเอกสารทุกครั้ง** | ทุกการเปลี่ยน (design, โค้ด, config, bug fix) → อัปเดต DESIGN.md / spec / CR / PLAN.md / features/README.md ใน commit เดียวกันหรือก่อนหน้า. เอกสารไม่ตรงโค้ด = งานยังไม่เสร็จ |
| R5 | **Report แยกไฟล์** | ผลทดสอบ, code review, security review, regression → ไฟล์แยกใน `docs/reports/` (ไม่ฝังใน spec) — spec แค่ลิงก์ไป |
| R6 | **Security สูงสุด** | secure by default (bind 127.0.0.1, deny ก่อน allow, least privilege, ไม่มี secret ใน log/repo/export); ทุก spec มี threat model; ทุก function ผ่าน security review แยก; security finding ระดับใดก็ตามที่ exploit ได้ = **critical** (block merge) |
| R0 | **Zero-touch** (จาก DESIGN §0) | ไม่แก้ไฟล์ใน project ของผู้ใช้. ทุก gate ต้องเช็คข้อนี้ |

---

## 1. สร้าง function ใหม่

```
 ①ออกแบบ → ②ถามความเห็น → ③เขียน/แก้เอกสาร → ④implement (ไม่กระทบของเดิม)
   → ⑤ทดสอบ → ⑥code-review → ⑦แก้ bug critical/major จนเป็น 0 → done (locked)
              ▲                          │
              └──── วนกลับ ⑤ ทุกครั้งที่แก้ ─┘
```

| ขั้น | ทำอะไร | Output | Gate (ผ่านถึงไปต่อ) |
|---|---|---|---|
| ① ออกแบบ | อ่าน DESIGN.md ส่วนที่เกี่ยว, เขียน Feature Spec จาก [`templates/feature-spec.md`](templates/feature-spec.md): ขอบเขต, interface, data/config, flow, error, ผลดี/ผลเสีย, ทางเลือก, impact ต่อ feature เดิม, **threat model**, test plan | `docs/features/F-xxx-<name>.md` status `draft` | ครบทุกหัวข้อ, ไม่มี "TBD" ในส่วน interface / threat model |
| ② ถามความเห็น | สรุปประเด็นที่ต้องตัดสินใจเป็นคำถาม (ภาษาไทย) + ทางเลือก + ข้อแนะนำ | คำตอบผู้ใช้ | ผู้ใช้ตอบครบทุกข้อ |
| ③ เอกสาร | ใส่คำตอบใน spec, อัปเดต DESIGN.md ถ้า design เปลี่ยน (+ แถวใน §17 Review log), อัปเดต PLAN.md | spec status `approved` | ผู้ใช้อนุมัติ spec |
| ④ Implement | เขียนโค้ดตาม spec เท่านั้น. **ไม่กระทบ feature เดิม**: ไม่เปลี่ยน signature/behavior ที่มีอยู่, ของใหม่เพิ่มแบบ additive (ไฟล์ใหม่, option ใหม่ default ปิด, schema migration แบบเข้ากันได้) | branch `feat/F-xxx-<name>` | build ผ่าน, ไม่มีไฟล์นอกขอบเขต spec ถูกแก้ |
| ⑤ ทดสอบ | unit + integration ตาม test plan + **regression ทั้งชุด** ของ feature ที่ done แล้ว + fixtures (DESIGN §21.5) + **security tests** ตาม threat model | `reports/F-xxx/test-<n>.md` | เทสใหม่ผ่าน 100%, regression ผ่าน 100% |
| ⑥ Code review | (a) code review diff ทั้งหมด (correctness, Zero-touch, กระทบ feature เดิม, ตรง spec) (b) **security review แยก** ตาม [checklist](#6-security-checklist-r6) + `npm audit` / dependency check. จัดระดับ: **critical / major / minor / nit** | `reports/F-xxx/review-<n>.md`, `reports/F-xxx/security-<n>.md` | review ครบทุกไฟล์ใน diff + checklist ครบทุกข้อ |
| ⑦ แก้ bug | แก้ critical + major ทั้งหมด → กลับ ⑤ → ⑥ ใหม่ (report รอบใหม่ `-<n+1>`) จนไม่เหลือ. minor/nit → แก้หรือบันทึกเป็น backlog (ผู้ใช้เลือก) — **security finding ไม่มี minor ที่ปล่อยผ่าน** ต้องแก้หรือผู้ใช้ยอมรับเป็นลายลักษณ์อักษรใน report | spec status `done`, merge เข้า `develop`, อัปเดตเอกสาร (R4) | critical = 0, major = 0, security open = 0, regression ผ่าน |

ระดับ bug:
- **critical** — ข้อมูลหาย/เสีย, ละเมิด Zero-touch, ช่องโหว่ security, crash ของ daemon, feature เดิมพัง
- **major** — ฟังก์ชันหลักตาม spec ทำงานผิด, ไม่มี rollback ตามที่ spec สัญญา, error ที่ผู้ใช้แก้เองไม่ได้
- **minor** — edge case, ข้อความผิด, UX ไม่ดี แต่มีทางเลี่ยง
- **nit** — style, naming

---

## 2. แก้ไข function ที่มีอยู่

ใช้ขั้นเดียวกับข้อ 1 แต่เริ่มด้วย **Change Request** และมีเพิ่ม:

| ขั้น | เพิ่มจากข้อ 1 |
|---|---|
| ① ออกแบบ | เขียน CR จาก [`templates/change-request.md`](templates/change-request.md): ของเดิมทำอะไร → จะเปลี่ยนเป็นอะไร → ทำไม; **impact matrix**: feature ไหน / config ไหน / ข้อมูลไหนโดนบ้าง; แผน migration + rollback |
| ② ถามความเห็น | ต้องขอ **อนุญาตแก้ feature** อย่างชัดเจน (R1) — ไม่อนุญาต = หยุด |
| ④ Implement | แก้เฉพาะที่ CR ระบุ; ส่วนที่ไม่ได้ระบุห้ามแตะ; ถ้าระหว่างทำพบว่าต้องแตะเพิ่ม → หยุด กลับ ① แก้ CR + ขออนุญาตใหม่ |
| ⑤ ทดสอบ | เพิ่มเทสที่พิสูจน์ว่าพฤติกรรมเก่าที่ "ไม่ได้ตั้งใจเปลี่ยน" ยังเหมือนเดิม |

Bug fix ที่ไม่เปลี่ยน spec → CR แบบย่อ (ส่วน "ของเดิม / สาเหตุ / แก้ยังไง / เทส"), ยังต้องขออนุญาต

---

## 2.5 คู่มือการใช้งาน (User manual)

```
 ①วิเคราะห์ระบบ → ②จัดทำคู่มือ HTML (เปิดได้ทันที) → ③ตรวจความครบถ้วนการใช้งาน → (ขาด → กลับ ①/②)
```

| ขั้น | ทำอะไร | Output | Gate |
|---|---|---|---|
| ① วิเคราะห์ระบบ | อ่านโค้ดจริง + spec ที่ `done` + CLI `--help` + หน้า dashboard → สร้าง **inventory**: ทุกคำสั่ง CLI, ทุกหน้า/ปุ่ม dashboard, ทุก config key, ทุก error/ป้ายเตือนที่ผู้ใช้เห็น, flow หลัก (ติดตั้ง → setup → scan → approve → start → เปิดเว็บ → DB …), ข้อจำกัด, troubleshooting | `docs/manual/_inventory.md` | inventory มาจากของจริง (ไม่ใช่จาก design ที่ยังไม่ทำ) |
| ② คู่มือ HTML | `docs/manual/index.html` + หน้าแยกต่อหัวข้อ; **เปิดจากไฟล์ได้ทันที** (double-click, `file://`) ไม่ต้องมี server; ไม่โหลดอะไรจากภายนอก (CSS/JS/รูป inline หรือไฟล์ข้างๆ — R6); ภาษาไทยเป็นหลัก; มีสารบัญ + ค้นหา + ตัวอย่างคำสั่ง copy ได้ + screenshot | `docs/manual/*.html` | เปิดใน Chrome/Edge/Firefox ได้, ลิงก์ภายในไม่เสีย |
| ③ ตรวจความครบถ้วน | เทียบ inventory ↔ คู่มือ ทีละรายการ (coverage table จาก [`templates/manual-coverage.md`](templates/manual-coverage.md)); ทำตามคู่มือจริงบนเครื่องสะอาด (fixture project) ทีละ flow; ตรวจว่าตรงกับพฤติกรรมจริง | `reports/manual/coverage-<n>.md` | coverage 100%, ทุก flow ทำตามได้จริง, ไม่มีขั้นตอนที่ผิดจากของจริง |

- รันเมื่อ: จบแต่ละ MVP (PLAN.md) และทุกครั้งที่ CR เปลี่ยนสิ่งที่ผู้ใช้เห็น (R4)
- คู่มือห้ามมี secret/token/path ส่วนตัวจริง (ใช้ตัวอย่าง)

---

## 3. สิ่งที่ AI (Claude) ต้องทำในแต่ละขั้น

- ขั้น ② และการขออนุญาต R1 → ถามผู้ใช้เสมอ **ไม่ตัดสินใจแทน**, ถามเป็นภาษาไทย
- ห้ามเขียนโค้ดในขั้น ①–③ (prototype/spike ทดลองได้เฉพาะใน scratchpad และต้องบอกผู้ใช้ — ไม่เข้า repo)
- ขั้น ⑥ ใช้ reviewer ที่ไม่เห็นเหตุผลของผู้เขียน (agent ใหม่ / `/code-review`) แล้ว **ยืนยัน finding กับโค้ดจริง** ก่อนแก้
- commit / push เฉพาะเมื่อผ่าน gate ของขั้นนั้น; ข้อความ commit อ้าง `F-xxx` / `CR-xxx`

---

## 4. Definition of Done

- [ ] spec/CR status `done`, report ครบใน `docs/reports/F-xxx/` (test, review, security — รอบสุดท้ายผ่าน)
- [ ] critical = 0, major = 0, security open = 0
- [ ] regression ทั้งชุดผ่าน
- [ ] ไม่มีไฟล์ใน project ของผู้ใช้ถูกแก้ (fixture test ตรวจ hash ก่อน/หลัง)
- [ ] DESIGN.md / PLAN.md / features/README.md อัปเดตแล้ว
- [ ] merge เข้า `develop`

---

## 5. Reports (R5)

```
docs/reports/
├── README.md                 # index: ทุก report + ผลล่าสุดต่อ feature
├── F-xxx/
│   ├── test-1.md             # template: templates/test-report.md
│   ├── review-1.md           # template: templates/review-report.md
│   ├── security-1.md         # template: templates/security-report.md
│   └── test-2.md …           # รอบถัดไปหลังแก้ (ไม่เขียนทับรอบเก่า)
├── CR-xxx/ …
├── design/                   # review ของ DESIGN.md แต่ละ version
└── regression/<date>.md      # ผล regression ทั้งชุดก่อน merge
```

- report เขียนครั้งเดียว ไม่แก้ย้อนหลัง (append-only) → ตรวจย้อนได้ว่าแต่ละรอบเจออะไร
- ห้ามมี secret / token / password / connection string จริงใน report (mask เป็น `***`)

---

## 6. Security checklist (R6)

ใช้ทุก function ในขั้น ① (threat model) และ ⑥ (security review)

| หมวด | ต้องผ่าน |
|---|---|
| Network | bind `127.0.0.1` เป็น default ทุก port; เปิด LAN ต้องผู้ใช้สั่ง + password; ไม่มี port publish `0.0.0.0` โดยไม่ตั้งใจ |
| AuthN/AuthZ | ทุก endpoint ผ่าน token/session (ยกเว้น `/_wake`, `/_auth` ที่จำกัด Host); Host allowlist (DNS rebinding); Origin check (CSRF); cookie `HttpOnly; SameSite=Strict` host-only; master token ไม่ออกนอก daemon |
| Input | validate ทุก input ด้วย schema; ห้ามต่อ string เข้า shell (ใช้ `spawn` แบบ args array); path ต้อง resolve แล้วอยู่ใน root ที่อนุญาต (กัน path traversal); SQL ใช้ parameter |
| Secret | อยู่ใน `data/secrets.json` (สิทธิ์ไฟล์เฉพาะ user); ไม่อยู่ใน log, error message, report, export (ยกเว้น `--with-secrets`), URL query; password สุ่มด้วย CSPRNG |
| Privilege | ไม่รันเป็น admin; ยกสิทธิ์เฉพาะงานที่จำเป็น (hosts file) ผ่าน Platform `elevate()` ทีละครั้ง + แสดงสิ่งที่จะทำ |
| Code จาก project | Run approval ก่อนรัน command/compose/image ใหม่ (DESIGN §21.6); script ใน API Studio รันใน isolated-vm |
| Outbound | API Studio จำกัดปลายทาง (SSRF); โหลด runtime/image ตรวจ checksum / digest |
| Docker | container ของ webhub ไม่ privileged, ไม่ mount docker socket (ยกเว้นจำเป็นและระบุใน spec), mount project แบบ `:ro`; label `webhub.managed=true` |
| Dependency | lockfile ของ webhub เอง, `npm audit` ไม่มี high/critical, pin version image |
| Data | คำสั่งอันตรายต้องยืนยัน + backup ก่อน; ไม่ลบ volume/ข้อมูลของ project อัตโนมัติ |
| Zero-touch | test ตรวจ hash ไฟล์ใน fixture project ก่อน/หลัง = เท่ากัน |

ระดับ security finding: exploit ได้จากเครื่องอื่น/เว็บอื่น หรือได้ token/secret = **critical**; ต้องมีสิทธิ์ local user อยู่แล้วแต่ยกระดับได้ = **major**; defense-in-depth ที่ขาด = **major** ถ้าเป็นข้อใน checklist ไม่งั้น minor

---

## 7. วิเคราะห์ workflow นี้ — ผลดี / ผลเสีย

| | ผลดี | ผลเสีย | ลดผลเสียยังไง |
|---|---|---|---|
| ออกแบบก่อนโค้ด (R2) | design ไม่ขัดกัน (เห็นจาก review DESIGN v6–v9 ที่เจอปัญหาก่อนเขียนโค้ด), ประเมินงานได้, ผู้ใช้คุมทิศทาง | ช้าในช่วงแรก, design อาจผิดเพราะยังไม่ได้ลองจริง | อนุญาต spike ใน scratchpad (ไม่เข้า repo) เพื่อพิสูจน์สมมติฐาน เช่น §18 |
| ถามความเห็นทุก function | ไม่ทำผิดสิ่งที่ผู้ใช้ต้องการ, ตัดสินใจโปร่งใส | ผู้ใช้ต้องตอบบ่อย, งานรอคำตอบ | รวมคำถามเป็นชุดเดียวต่อ function, ใส่ข้อแนะนำให้เลือกได้เร็ว; เรื่องเทคนิคล้วนตัดสินเองแล้วบันทึกเหตุผล |
| ห้ามแก้ feature เดิมโดยไม่ได้อนุญาต (R1) | feature ที่ใช้อยู่ไม่พังเงียบๆ, ประวัติการเปลี่ยนตรวจย้อนได้ | refactor ยาก, อาจเกิดโค้ดซ้ำเพราะไม่กล้าแตะของเดิม | CR แบบ "refactor ไม่เปลี่ยนพฤติกรรม" + regression test เป็นตัวยืนยัน |
| วิเคราะห์ผลดี/ผลเสีย (R3) | เห็น trade-off ก่อนตัดสินใจ, มีเหตุผลอ้างอิงภายหลัง | เอกสารยาวขึ้น | ตารางสั้น 3 คอลัมน์ ไม่ต้องเขียนเรียงความ |
| เทส + regression ทุกรอบ | มั่นใจว่าไม่กระทบของเดิม | เวลารันเทสเพิ่มตามจำนวน feature | แยก fast suite (unit) / full suite (integration+Docker) — รัน full ก่อน merge |
| วน review จน critical/major = 0 | คุณภาพสูง, security ไม่หลุด | วนหลายรอบได้, เกณฑ์ critical/major อาจตีความต่างกัน | นิยามระดับ bug ชัดในข้อ 1, จำกัดการวนที่ 3 รอบ — เกินแล้วถามผู้ใช้ |
| อัปเดตเอกสารบังคับ (R4) | เอกสารเชื่อถือได้, คน/AI รอบหน้าเข้าใจระบบจากเอกสารได้ | งานเอกสารเพิ่มทุก commit | DoD มี checkbox, review ⑥ ตรวจว่าเอกสารตรงโค้ด |
| Report แยก (R5) | ประวัติชัด ตรวจย้อนได้, spec ไม่บวม | ไฟล์เยอะ | โฟลเดอร์ต่อ feature + index ใน `reports/README.md` |
| Security สูงสุด (R6) | เหมาะกับเครื่องมือที่แตะ hosts file, Docker, DB, รันโค้ดของ repo อื่น — พลาดแล้วกระทบทั้งเครื่อง | ช้าขึ้น, UX ยุ่งขึ้น (ยืนยันบ่อย, ต้องใส่ password เมื่อเปิด LAN), บาง feature อาจทำไม่ได้ (เช่น เปิด LAN แบบง่าย) | checklist เดียวใช้ซ้ำ, ยืนยันครั้งเดียวต่อการเปลี่ยนคำสั่ง (ไม่ถามทุก start) |
| คู่มือ HTML + ตรวจครบถ้วน | ผู้ใช้อื่นใช้ได้โดยไม่ต้องอ่าน DESIGN.md (ตรงกับ goal "ใช้กับ project ของใครก็ได้"); เปิดออฟไลน์ได้; inventory ช่วยจับ feature ที่ไม่มีใครรู้ว่ามี | ต้องดูแลคู่มือทุกครั้งที่ UI/CLI เปลี่ยน; screenshot ล้าสมัยเร็ว | สร้างคู่มือตอนจบ MVP (ไม่ใช่ทุก commit); inventory gen จาก CLI `--help` / route ของ dashboard ได้บางส่วน |
| ภาพรวม | เหมาะกับ webhub ที่แตะ Docker/DB/hosts file ของเครื่องจริง (พลาดแล้วเสียหายจริง) | ไม่เหมาะกับงานทดลองเร็วๆ | งาน spike แยกออกจาก workflow ชัดเจน |
