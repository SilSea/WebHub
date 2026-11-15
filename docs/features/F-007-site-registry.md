# F-007 — Site registry + approve / ignore / add

| | |
|---|---|
| Status | `planned` (2026-11-15) |
| Phase | MVP-1 (PLAN.md) |
| DESIGN.md | §11.4 ต่อ site `data/sites/<name>.json`, §21.3 detect ไม่เจอ / ผิด, §10.1 ชื่อ reserved, §13 CLI (`approve` / `ignore` / `list` / `add`), §6.1 profile `start` |
| Depends on | F-001 (config `reservedNames`, `domainSuffix`, store, safe path, lock), F-003 (API + auth + CSRF), F-004 (CLI), F-005 (`loadProfiles`, `renderCommand`, `effectiveProfile`), F-006 (`data/scan.json`, `Candidate`) |
| Owner อนุมัติ | ผู้ใช้ / 2026-11-15 (Q1–Q5 ตามแนะนำ) |

## 1. เป้าหมาย / ขอบเขต
**ทำ (in scope)**
- **Registry**: site ที่ผู้ใช้รับแล้ว = 1 ไฟล์ `data/sites/<name>.json` (DESIGN §11.4, schemaVersion 1) ผ่าน store F-001 (atomic + lock; daemon เขียนคนเดียว)
- **Pending list**: candidate จาก `data/scan.json` (F-006) ที่ `kind: "site"` และยังไม่ถูกรับ / ไม่ถูก ignore → "รอ approve"; `duplicate` / `unknown` / `not-web` แสดงแยก (approve ได้ถ้าผู้ใช้ยืนยัน — ใช้ `add` แทน)
- **Approve** (`webhub approve <name|key> [--name <n>]`): candidate → site
  - validate ชื่อ: slug `[a-z0-9-]` 1–40, ไม่อยู่ใน `config.reservedNames` (§10.1), ไม่ซ้ำ site อื่น, ไม่ชน host ภายใน
  - **Run approval** (F-005 S8, PLAN): ก่อนรับ แสดง "แผนการรัน" ต่อ service — runner, cwd, argv ที่ render แล้ว (ค่า `{PORT}` / `{HOST}` จริง), executable ที่ resolve แล้ว (path เต็ม), ที่มาของ profile (built-in / user + path) — แล้วผูก approval กับ hash ของแผน + เนื้อหา profile (Q1)
- **Ignore** (`webhub ignore <name|key>` / `--undo`): candidate ไม่โผล่ใน pending อีก (Q5)
- **Add manual** (`webhub add <path> [--profile <id>] [--name <n>]`, DESIGN §21.3): project ที่ scan ไม่เจอ / detect ผิด → detect folder นั้นอย่างเดียวด้วย scanner ของ F-006 (อ่านอย่างเดียว), `--profile` ทับผล detect → แผนการรัน → รับเหมือน approve
- **List** (`webhub list [--pending|--ignored|--all] [--json]`): site + สถานะ (`ok`, `missing` = folder หาย, `changed` = detect ใหม่ต่างจากตอนรับ, `needs-approval` = แผนการรันเปลี่ยน)
- **Remove** (`webhub remove <name>`): ลบ site ออกจาก registry เท่านั้น — **ไม่แตะไฟล์ project** (R0)
- **Override ไม่ถูก rescan ทับ** (§21.3): ไฟล์ site แยก `detected` (ผลตอนรับ / refresh) กับ `overrides` (ที่ผู้ใช้แก้); ค่าที่ใช้ = detected ทับด้วย overrides (Q2)
- API (`/api/v1/sites…`) ให้ CLI + dashboard ใช้ร่วมกัน; CLI เป็น client ของ daemon (§13)

**ไม่ทำ (out of scope)**
- รันอะไรทั้งนั้น (up / down / install) → F-009 / F-017 — F-007 แค่เก็บ approval; runner ต้องเช็ค hash ก่อนรันทุกครั้ง
- จอง / แก้ port → F-010 (Port Map); F-007 เก็บแค่ port ที่ detect / override
- routes, DB, URL env, env sets → F-006b / F-011+; ฟิลด์ใน §11.4 ที่ยังไม่มีเจ้าของ = ไม่มีใน schema v1 (เพิ่มด้วย migration ทีหลัง)
- แก้ override ทุก field ผ่าน CLI (`webhub port`, `route`, `env` …) → feature ของแต่ละเรื่อง; F-007 มี API `PATCH` สำหรับ field ชุดแรก (Q4)
- "Save as profile" (§21.3) → ภายหลัง
- dashboard UI → F-0xx (dashboard)

## 2. ระบบเดิมรองรับยังไง (R2)
- F-001: store (`readDoc` / `writeDoc`, lock, zod, migration), `assertSafePath`, `isInside`, `config.reservedNames`, `config.domainSuffix`, `Paths.data`
- F-003: `RouteRegistrar`, auth (bearer CLI / session + key header browser), CSRF ต่อ route, `REQUEST_TIMEOUT_MS`
- F-004: command table, `ensureDaemon`, `sanitize`, exit code
- F-005: `loadProfiles` (built-in + user, ที่มาของไฟล์), `effectiveProfile`, `renderCommand` (argv, ไม่ผ่าน shell, ตรวจ bind non-loopback), `bindsNonLoopback`
- F-006: `data/scan.json` (`Candidate.key` = sha256 ของ real path, `name`, `kind`, `profile`, `runner`, `services`, `compose`), `scan()` ใช้กับ folder เดียวได้ (`scanRoots: [path]`, `maxDepth: 0`)
- ไม่มี resolver หา executable → เพิ่ม `resolveExecutable` (อ่านอย่างเดียว: `node_modules/.bin` ของ cwd ก่อน แล้ว `PATH` × `PATHEXT` บน Windows; ไม่รัน `where`)

## 3. Design
### 3.1 ไฟล์ (`data/sites/<name>.json`, `data/ignored.json`)
```ts
Site = {
  schemaVersion: 1;
  name: string;                 // = ชื่อไฟล์; slug 1–40, ไม่ reserved
  path: string;                 // real path ตอนรับ (absolute)
  key: string;                  // candidate key (sha256 ของ path, F-006)
  createdAt: string; updatedAt: string;
  detected: {                   // snapshot จาก F-006 ตอนรับ / --refresh (ไม่ถูก rescan ทับเอง)
    at: string; scanId?: string; profile?: string; runner: Runner; score: number;
    compose?: CandidateCompose; services: Record<string, Service>;
  };
  overrides: {                  // ผู้ใช้แก้ (ทับ detected ทีละ field)
    runner?: Runner; services?: Record<string, Partial<Service>>;
  };
  approval: {                   // run approval (Q1)
    at: string; planHash: string;     // sha256 ของแผนการรัน (canonical JSON)
    profiles: Record<string, { id: string; source: "builtin" | "user"; sha256: string }>;
  } | null;                     // null = ยังไม่อนุมัติให้รัน (เช่น add แบบ --no-approve)
}
IgnoredList = { schemaVersion: 1; keys: { key: string; path: string; at: string }[] } // ≤ 5000
```
- ชื่อไฟล์มาจากชื่อที่ validate แล้วเท่านั้น + `assertSafePath` (ไม่มี `..`, separator, reserved device name)

### 3.2 แผนการรัน (run plan)
- ต่อ service: `{ service, runner, cwd (absolute, อยู่ใน path ของ site), argv[], executable (path เต็ม | null = หาไม่เจอ), profile { id, source, file?, sha256 }, port { value, via, env? } }`
  - `argv` = `renderCommand(profile.start.cmd, { PORT, HOST })` — PORT = port ที่ detect / override, HOST = `profile.host.bind` (loopback)
  - runner `compose` / `hybrid`: แผน = ไฟล์ compose (relative) + project name ที่จะใช้; ยังไม่รัน `docker compose config` (F-009)
  - runner `static`: ไม่มี argv (nginx เสิร์ฟ `publicDir`)
- `planHash` = sha256 ของ canonical JSON ของแผนทั้งหมด (เรียง key) — เปลี่ยนอะไรก็ตาม (profile ถูกแก้, override port, executable ย้าย) → hash ไม่ตรง → `needs-approval`
- อนุมัติแบบ 2 จังหวะ (กัน approve แบบไม่เห็นแผน): `GET …/plan` → แผน + `planHash`; `POST …/approve { planHash }` → ต้องตรงกับแผนที่คำนวณใหม่ตอนนั้น ไม่งั้น `409 PLAN_CHANGED`

### 3.3 ค่าที่ใช้ (effective) + rescan
- effective = `detected` ทับด้วย `overrides` (field ต่อ field; service ที่ไม่มีใน detected ต้องมีครบใน overrides)
- rescan (F-006) **ไม่เขียน** `data/sites/` เลย; `list` เทียบ candidate ล่าสุด (key เดียวกัน) กับ `detected` → `changed` + บอก field ที่ต่าง
- `webhub approve <name> --refresh` = เอา candidate ล่าสุดมาเป็น `detected` ใหม่ (overrides คงไว้) → แผนใหม่ → ต้องอนุมัติแผนอีกครั้ง

### 3.4 Interface
- API (ทุก route: access `user` ของ F-003; POST / PATCH / DELETE มี CSRF ตาม F-003)
  - `GET /api/v1/sites` → `{ sites: SiteSummary[], pending: Candidate[], ignored: … }` (`?view=pending|ignored`)
  - `GET /api/v1/sites/:name` → site + effective + สถานะ
  - `GET /api/v1/candidates/:key/plan?name=` → แผน + planHash (candidate จาก scan.json)
  - `POST /api/v1/candidates/:key/approve { name, planHash }` → `201` site; `409 NAME_TAKEN | PLAN_CHANGED`, `400 NAME_RESERVED | NAME_INVALID`
  - `POST /api/v1/candidates/:key/ignore`, `DELETE /api/v1/candidates/:key/ignore`
  - `POST /api/v1/sites/add { path, profile?, name? }` → detect folder เดียว → `{ candidate, plan, planHash }` (ยังไม่สร้าง site); แล้ว approve ด้วย key เหมือนเดิม
  - `PATCH /api/v1/sites/:name { overrides }` (Q4) → แผนเปลี่ยน → `approval` เป็น `needs-approval`
  - `POST /api/v1/sites/:name/approve { planHash }` (อนุมัติแผนใหม่ / `--refresh`), `DELETE /api/v1/sites/:name`
- CLI: `approve`, `ignore [--undo]`, `add`, `list`, `remove` — แสดงแผน (sanitize) + ถาม y/N ก่อนส่ง approve; `--yes` ข้ามการถาม (ใช้ใน script; ยังส่ง planHash ที่เห็น); `--json`

### 3.5 Platform
- path เทียบแบบ case-insensitive บน Windows; `path` เก็บ real path; folder หาย → `missing` (ไม่ลบ site เอง)
- executable resolve บน Windows: `PATHEXT` (`.COM;.EXE;.BAT;.CMD` …) — `.bat` / `.cmd` = รันผ่าน `cmd.exe` → แสดงเตือนในแผน (F-002: argv ผ่าน cmd ต้อง escape — runner F-009 ตัดสิน)

## 4. ผลดี / ผลเสีย (R3)
| | |
|---|---|
| ผลดี | ไม่มีอะไรรันโดยไม่ผ่านตาและการกดยืนยันที่ผูกกับแผนจริง; rescan ไม่ทับค่าที่ผู้ใช้แก้; 1 site = 1 ไฟล์ (diff ง่าย, เสียไฟล์เดียวไม่กระทบ site อื่น) |
| ผลเสีย | ต้องอนุมัติใหม่เมื่อ profile / override / executable เปลี่ยน (เพิ่มขั้นตอน); `changed` ต้องให้ผู้ใช้ refresh เอง; executable resolve ตอนอนุมัติอาจต่างจากตอนรัน (runner ต้องเช็คซ้ำ) |
| ทางเลือก | (1) approve แค่ "รับ site" แล้วถามตอนรันครั้งแรก — ง่ายกว่า แต่ dashboard ต้องมี flow ยืนยันตอนกด up; (2) ไฟล์เดียว `data/sites.json` — atomic ข้าม site แต่ conflict / ขนาดโต; (3) rescan อัปเดต detected อัตโนมัติ — สะดวก แต่ค่าที่รันเปลี่ยนเงียบ ๆ |

## 5. Impact ต่อของเดิม
- เพิ่มไฟล์ใหม่ (`src/sites/*`, `src/cli/site-commands.ts`), เพิ่ม registrar ใน `src/daemon.ts`, command ใน `src/cli.ts` — additive
- F-006 ไม่เปลี่ยน (อ่าน `data/scan.json` ผ่าน `scanSpec`; add ใช้ `scan()` ที่มีอยู่)
- F-005 ไม่เปลี่ยน (ใช้ `renderCommand` / `loadProfiles` ที่มีอยู่; ต้องรู้ไฟล์ที่มาของ profile — มีใน `LoadedProfile` แล้ว)

## 6. Threat model (R6)
| ทรัพย์สิน | ภัย | กัน | ผลที่คาด |
|---|---|---|---|
| การรันโค้ด | repo / profile ที่ได้มาจากคนอื่นถูกรัน; profile ถูกแก้หลัง approve; executable ปลอมใน `node_modules/.bin` | run approval ผูกกับ planHash (argv + exe path + sha256 ของ profile); เปลี่ยน = `needs-approval`; runner (F-009) เช็คซ้ำก่อนรัน | แก้ profile 1 ตัวอักษร → ต้องอนุมัติใหม่ |
| approve จาก browser | เว็บอื่น (CSRF) / tab ที่ถูกหลอก approve site | auth + CSRF ของ F-003; approve ต้องส่ง planHash ที่ได้จาก GET plan (เดาไม่ได้ถ้าไม่เห็นแผน) | POST ไม่มี / ผิด planHash → 409 |
| `data/sites/` | ชื่อ site ทำ path traversal / ทับไฟล์อื่น; ชื่อ reserved ชน host ภายใน | slug regex + reserved list + `assertSafePath`; ไฟล์เขียนผ่าน store เท่านั้น | `../x`, `con`, `hub` → 400 |
| project ของผู้ใช้ (R0) | remove / ignore ลบหรือแก้ไฟล์ project | registry เขียนแค่ `data/`; remove = ลบไฟล์ site ใน `data/sites/` เท่านั้น | hash ของ fixture ก่อน = หลัง |
| add manual | path ไปที่ home ของ webhub, link, system folder | real path, ไม่ใช่ link, ไม่ซ้อน home (เหมือน scan root), scanner อ่านอย่างเดียว | path ผิด → 400 |
| terminal / dashboard | ชื่อ / path / argv มี ESC / bidi | sanitize ทุก output CLI; schema จำกัดความยาว | ไม่มี escape หลุด |
| ข้อมูลลับ | แผนแสดงค่า env | แผนมีแค่ argv + ชื่อ env ของ port (ไม่มีค่า `.env`) | — |

## 7. คำถามถึงผู้ใช้ (ขั้น ②)
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|
| Q1 | run approval ผูกกับอะไร / ทำตอนไหน | (A) ตอน approve: แสดงแผน (argv + exe + profile) → ผูก planHash; เปลี่ยน = อนุมัติใหม่ · (B) approve แค่รับ site, ถามตอน up ครั้งแรก | A | A |
| Q2 | rescan กับ site ที่รับแล้ว | (A) ไม่ทับ: แสดง `changed`, ผู้ใช้ `--refresh` เอง (overrides คงไว้) · (B) อัปเดต `detected` อัตโนมัติ (overrides คงไว้) แล้วตั้ง `needs-approval` | A | A |
| Q3 | folder ของ site ย้าย / หาย | (A) ผูกกับ real path: หาย = `missing`, ผู้ใช้ remove / add ใหม่ · (B) ตามด้วย fingerprint ไป path ใหม่ | A | A |
| Q4 | แก้ override ใน F-007 | (A) API `PATCH` field ชุดแรก (runner, service: profile / port / via / cwd / publicDir) + `webhub add --profile`; CLI แก้ทีละ field รอ feature ของเรื่องนั้น · (B) `webhub site <n> set key=value` ครบใน F-007 | A | A |
| Q5 | ignore ด้วยอะไร | (A) candidate key (real path) ใน `data/ignored.json` + `--undo` · (B) pattern / glob ของ path (ignore ทั้งกลุ่ม) | A | A |

## 8. Test plan
| # | เคส | ชนิด |
|---|---|---|
| 1 | approve: ชื่อ ok / reserved / ซ้ำ / ผิดรูป / traversal → ไฟล์ site + effective ถูก | unit + integration |
| 2 | แผนการรัน: argv render จริง, exe resolve (`node_modules/.bin` ก่อน PATH, PATHEXT), static / compose ไม่มี argv | unit |
| 3 | planHash: เปลี่ยน profile (แก้ไฟล์ user 1 ตัวอักษร), override port, exe ย้าย → `needs-approval`; POST planHash เก่า → 409 | unit + integration |
| 4 | rescan หลัง approve → site ไม่เปลี่ยน, list = `changed`; `--refresh` คง overrides | integration |
| 5 | ignore / undo; pending ไม่รวม ignored / approved | integration |
| 6 | add: path ok / link / home / ไม่มี / ไฟล์; `--profile` ทับ detect | integration |
| 7 | remove: ไฟล์ project ไม่ถูกแตะ (hash), ไฟล์ site หาย | integration |
| 8 | API: 401, CSRF (browser ไม่มี key header → 403), schema ของ response | integration |
| 9 | CLI: ตาราง list, แผน + y/N, `--yes`, `--json`, sanitize ESC (Linux CI) | integration |
| 10 | Node 22.12 | ทั้งหมด |

## 9. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|

## 10. เอกสารที่อัปเดต (R4)
DESIGN §11.4 (แยก `detected` / `overrides` / `approval`, ฟิลด์ v1), §12 (`data/sites/`, `data/ignored.json`, `src/sites/`), §13 (`remove`, `list` flags), §17 แถวใหม่; PLAN; features/README

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-15 | W1 ① | ร่าง design + Q1–Q5 → รอความเห็นผู้ใช้ |
| 2026-11-15 | W1 ②–④ | ผู้ใช้ตอบ Q1–Q5 ตามแนะนำ (approval ตอน approve ผูก planHash, rescan ไม่ทับ, ผูก real path / ignore ตาม key, PATCH ชุดแรก) → `planned` |
