# F-001 — Config + `$WEBHUB_HOME` + migration

| | |
|---|---|
| Status | `draft` |
| Phase | MVP-1 (PLAN.md) |
| DESIGN.md | §0 (ที่เก็บ config), §2 Registry, §11.3, §12, §21.4, §21.6 |
| Depends on | F-000 |
| Owner อนุมัติ | — |

## 1. เป้าหมาย / ขอบเขต
**ทำ** (library ภายใน `src/config/` + `src/store/` — ยังไม่มี daemon/CLI command)
- หา `$WEBHUB_HOME` + สร้างโครงโฟลเดอร์ด้วยสิทธิ์จำกัด
- อ่าน / validate / เขียน `webhub.config.json` ตาม schema (§11.3) + ค่า default
- **JSON store** กลางสำหรับไฟล์ใน `data/` ทั้งหมด: atomic write, backup, schemaVersion
- **Migration framework**: แปลง schema เก่า → ใหม่อัตโนมัติ + backup ก่อน; ไฟล์จาก webhub เวอร์ชันใหม่กว่า → ไม่แตะ
- **Single-writer lock** (daemon เป็นผู้เขียนคนเดียว — §2, §13)
- **Secrets store** (`data/secrets.json`): เก็บ/อ่าน password, token ตาม Q2

**ไม่ทำ**
- schema ของ `sites/*.json`, `ports.json`, `infra.json`, `state.json` (feature ที่ใช้ไฟล์นั้นกำหนดเอง โดยใช้ store นี้)
- คำสั่ง `webhub setup` / `doctor` (F-008), API แก้ config (F-003)
- macOS/Linux secret backend (phase 13 — มี interface รองรับ)

## 2. ระบบเดิมรองรับยังไง
- DESIGN กำหนดที่อยู่ `$WEBHUB_HOME` + default ต่อ OS (§21.4), โครง `data/` (§12), `schemaVersion` + `migrate/` + backup ก่อน migrate (§21.6), daemon เป็น single writer (§2, §13), secret ไม่ลง log/export (§20, WORKFLOW §8)
- ต้องเพิ่มใน DESIGN: ลำดับหา home, lock, atomic write, รูปแบบ secrets at rest (ตาม Q2), การจัดการไฟล์จากเวอร์ชันใหม่กว่า, พฤติกรรมเมื่อ config ไม่ถูกต้อง (Q3)

## 3. Design

### 3.1 `$WEBHUB_HOME`
ลำดับ: env `WEBHUB_HOME` (ต้องเป็น absolute path) → default ต่อ OS
| OS | default |
|---|---|
| Windows | `%APPDATA%\webhub` |
| macOS | `~/Library/Application Support/webhub` |
| Linux | `$XDG_DATA_HOME/webhub` หรือ `~/.local/share/webhub` |

กติกา (R6):
- ปฏิเสธ home ที่เป็น symlink/junction, อยู่ใน scan root, หรือเป็น root ของ drive
- ระหว่างพัฒนาใช้ repo ได้โดยตั้ง `WEBHUB_HOME` เอง (gitignore ครอบ `data/` `logs/` `runtimes/` แล้ว)
- test ใช้ home ใน temp dir เสมอ (ไม่แตะ home จริงของเครื่อง)

```ts
interface Paths {
  home: string; config: string;          // <home>/webhub.config.json
  data: string; sites: string; compose: string; profiles: string; backups: string; venvs: string;
  ports: string; infra: string; state: string; secrets: string; auth: string; lock: string;
  logs: string; runtimes: string; nginx: string; docker: string;
}
resolveHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string): string
pathsFor(home: string): Paths
ensureHome(paths: Paths): Promise<void>   // mkdir; Windows: ACL เฉพาะ user ปัจจุบัน + SYSTEM (icacls), POSIX: 0700 dir / 0600 file
```

### 3.2 JSON store (`src/store/json-store.ts`)
```ts
readJson<T>(file, schema, migrations): Promise<{ value: T; migratedFrom?: number }>
writeJsonAtomic(file, value): Promise<void>
```
- **atomic write**: เขียน `<file>.tmp-<rand>` → fsync → rename ทับ (Windows: retry เมื่อ EPERM/EBUSY จาก AV สูงสุด 5 ครั้ง) → เก็บรุ่นก่อนหน้าเป็น `<file>.bak` 1 ชุด
- ทุกไฟล์มี `schemaVersion` (integer)
  - เท่ากับปัจจุบัน → validate
  - ต่ำกว่า → backup ไป `data/backups/migrate/<timestamp>/<file>` → รัน migration ทีละขั้น → validate → เขียน
  - **สูงกว่า** (ไฟล์จาก webhub เวอร์ชันใหม่) → error `CONFIG_FROM_NEWER_VERSION` ไม่แก้ไฟล์ (กันข้อมูลหายตอน downgrade)
- อ่านไฟล์: ปฏิเสธ symlink (lstat), จำกัดขนาด 5 MB, JSON parse error → error ระบุไฟล์ + บรรทัด, ลอง `.bak` ไม่อัตโนมัติ (แจ้งให้ `doctor` เสนอ restore)
- เขียนได้เฉพาะ process ที่ถือ lock

### 3.3 Lock (`src/store/lock.ts`)
```ts
acquireLock(paths): Promise<Lock>   // data/.lock: { pid, startedAt, hostname }, เปิดแบบ exclusive (wx)
Lock.release(): Promise<void>
```
- lock ค้างจาก process ที่ตายแล้ว (PID ไม่อยู่ หรือ start time ไม่ตรง — กัน PID reuse) → ยึดคืนได้
- process ที่ไม่ถือ lock (CLI) อ่านได้อย่างเดียว

### 3.4 Config schema (`webhub.config.json`, schemaVersion 1)
ตาม DESIGN §11.3 ทุก key: `mode`, `locale`, `scanRoots`, `maxDepth`, `ignore`, `domainSuffix`, `reservedNames`, `ports`, `infra`, `runtimes`, `daemon`, `backups`, `defaultEnv`, `onDemand`, `profilesDir`
- ไม่มีไฟล์ → ใช้ default ในหน่วยความจำ (ไม่เขียนจนกว่าจะ save — `setup` F-008 เป็นคนสร้าง)
- validate เพิ่ม: `scanRoots` เป็น absolute + มีอยู่จริง (warning ถ้าไม่มี), ห้ามซ้อนกับ `$WEBHUB_HOME`; ช่วง port 1–65535 และ start ≤ end; `domainSuffix` เป็น hostname label ที่ถูกต้อง; path relative → resolve กับ home และต้องอยู่ใน home
- key ไม่รู้จัก / ค่าผิด → ตาม Q3

### 3.5 Secrets (`src/store/secrets.ts`)
```ts
interface SecretStore { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void>; }
generateSecret(bytes = 32): string     // crypto.randomBytes → base64url
```
- key รูปแบบ `<scope>/<name>` เช่น `postgres-17/pos`, `auth/master`
- ค่าไม่ปรากฏใน error/log (`toString`/`inspect` ของ object ที่ถือ secret → `***`)
- at-rest ตาม Q2

### 3.6 Errors
ทุก error เป็น `WebhubError { code, message, file?, hint? }` — code: `HOME_INVALID`, `CONFIG_INVALID`, `CONFIG_FROM_NEWER_VERSION`, `JSON_PARSE`, `LOCKED`, `SYMLINK_REFUSED`, `FILE_TOO_LARGE`, `SECRET_BACKEND`

## 4. ผลดี / ผลเสีย
| | รายละเอียด |
|---|---|
| ผลดี | ทุก feature ต่อจากนี้ได้ที่เก็บข้อมูลที่ปลอดภัย (atomic + backup + lock) และ migration ฟรี; อัปเดต webhub ไม่ทำ config พัง; downgrade ไม่ทำข้อมูลหาย; secret แยกไฟล์และไม่หลุดใน log |
| ผลเสีย | ทุกการเขียนช้าลงเล็กน้อย (fsync + rename); lock ทำให้ CLI เขียนเองไม่ได้ (ต้องผ่าน daemon — ตรงกับ design อยู่แล้ว); ACL บน Windows ต้องเรียก `icacls` |
| ทางเลือกที่ไม่เลือก | SQLite เป็น store — query ได้ แต่ต้องมี native module (ขัด install-script block ของ F-000) และแก้ด้วยมือไม่ได้; เก็บ config ใน registry/AppData แบบ key-value — ไม่ข้าม OS; ไม่มี lock แล้วเชื่อว่ามี daemon ตัวเดียว — เสี่ยงข้อมูลเสียเมื่อเปิด 2 ตัว |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done (F-000) | ไม่ | เพิ่มไฟล์ใหม่ใน `src/config`, `src/store`, `test/` เท่านั้น |
| Zero-touch | ไม่ | เขียนเฉพาะใน `$WEBHUB_HOME`; ปฏิเสธ home ที่อยู่ใน scan root |
| Security | มี | secret at rest, สิทธิ์ไฟล์, symlink, path traversal — ดู §6 |
| Performance | เล็กน้อย | fsync ต่อการเขียน |
| Config / data เดิม | ไม่ | ยังไม่มีผู้ใช้ |
| Dependency | อาจเพิ่ม 1 ตัว | ตาม Q1 |

## 6. Threat model
| Asset | ผู้โจมตี / ช่องทาง | ป้องกันด้วย | เทส |
|---|---|---|---|
| secrets (DB password, auth token) | user อื่นบนเครื่องอ่านไฟล์ | ACL เฉพาะ user (Windows) / 0600 (POSIX) | ตรวจ ACL/mode หลัง ensureHome + write |
| secrets | ไฟล์ secrets หลุดไปกับ backup / export / log / report | at-rest ตาม Q2; ไม่รวมใน config export (§20); redaction ใน error/log | test ว่า error/inspect ไม่มีค่า secret |
| secrets | malware ที่รันเป็น user เดียวกัน | **ป้องกันไม่ได้เต็มที่** (DPAPI ก็ถอดได้ใน session เดียวกัน) — ลดผลกระทบด้วย password สุ่มต่อ site, bind 127.0.0.1 | — (บันทึกเป็นข้อจำกัด) |
| `data/*.json` | เขียนพร้อมกัน 2 process → ไฟล์เสีย | lock + atomic rename | test 2 process แย่ง lock |
| `data/*.json` | ไฟฟ้าดับกลางการเขียน | tmp + fsync + rename, `.bak` | test ไฟล์ tmp ค้างไม่กระทบไฟล์หลัก |
| ไฟล์นอก home | symlink ใน `data/` ชี้ออกไป → webhub เขียนทับไฟล์อื่น | lstat ปฏิเสธ symlink ทุกไฟล์/โฟลเดอร์ที่อ่าน-เขียน | test symlink/junction |
| ไฟล์นอก home | path ใน config (`runtimes.dir`, `profilesDir`) แบบ `../../` | resolve แล้วต้องอยู่ใน home | test traversal |
| ข้อมูลผู้ใช้ | downgrade webhub แล้ว migrate ย้อน/ทับ | ไฟล์ schema ใหม่กว่า → ไม่แตะ + error | test |
| project ของผู้ใช้ (R0) | `WEBHUB_HOME` ชี้เข้า project | ปฏิเสธ home ใน scan root | test |
| process | JSON ใหญ่ผิดปกติ (DoS) | จำกัด 5 MB | test |

Checklist ที่เกี่ยว: Secrets, Input, Privilege (ไม่ต้อง admin), Data, Zero-touch

## 7. คำถามถึงผู้ใช้
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|
| Q1 | library validate schema | zod 4 / ajv (JSON Schema) / เขียนเอง | **zod 4** — dependency เดียวไม่มี dep ย่อย, ได้ type TS อัตโนมัติ, gen JSON Schema ให้ editor/profile (§21.5) ได้ | |
| Q2 | เก็บ secret บนดิสก์ยังไง | DPAPI (เข้ารหัสผูกกับ user Windows) + ACL / ACL อย่างเดียว (plain JSON) | **DPAPI + ACL** — ไฟล์ secrets หลุด (backup, copy, sync cloud) แล้วอ่านไม่ได้บนเครื่อง/user อื่น; ช้าเฉพาะตอนเปิด daemon (เรียก PowerShell ครั้งเดียวแล้ว cache ในหน่วยความจำ) | |
| Q3 | config มี key ไม่รู้จัก / ค่าผิด | ไม่ start + บอกจุดผิดชัดเจน / ข้าม key แปลก + เตือน | **ไม่ start + บอกจุดผิด** — กันพิมพ์ผิดแล้วระบบทำงานด้วยค่าที่ไม่ได้ตั้งใจ (เช่น expose LAN); `doctor` ชี้วิธีแก้ | |
| Q4 | รูปแบบไฟล์ config | JSON / JSONC (ใส่ comment ได้) | **JSON** — ตรง DESIGN, ไม่ต้องมี parser เพิ่ม; แก้ผ่าน dashboard/CLI เป็นหลัก | |

## 8. Test plan
| # | กรณี | ประเภท |
|---|---|---|
| 1 | resolveHome: env > default ต่อ OS; env relative → error | unit |
| 2 | home เป็น symlink / root drive / อยู่ใน scan root → error | security |
| 3 | ensureHome สร้างโครงครบ; สิทธิ์ (Windows ACL / POSIX 0700/0600) | integration |
| 4 | config: ไม่มีไฟล์ → default; ไฟล์ถูกต้อง → parse; ผิด → error ระบุ path ของ key (ตาม Q3) | unit |
| 5 | path relative ใน config resolve กับ home; `../` หลุด home → error | security |
| 6 | atomic write: tmp ค้าง/ไฟล์หลักไม่เสีย, `.bak` ถูกสร้าง | unit |
| 7 | migration v0 → v1: backup ก่อน, ผลถูก, เขียนกลับ; migration พัง → ไฟล์เดิมไม่เปลี่ยน | unit |
| 8 | schemaVersion ใหม่กว่า → `CONFIG_FROM_NEWER_VERSION` + ไฟล์ไม่เปลี่ยน | unit |
| 9 | lock: process ที่ 2 ได้ `LOCKED`; lock ค้างจาก PID ตาย → ยึดคืน | integration |
| 10 | symlink ใน `data/` → ปฏิเสธทั้งอ่าน/เขียน | security |
| 11 | ไฟล์ > 5 MB → `FILE_TOO_LARGE` | security |
| 12 | secrets: set/get/delete; ค่าไม่อยู่ใน error/`inspect`/JSON ของ error; at-rest ตาม Q2 (ไฟล์ไม่มี plaintext ถ้า DPAPI) | security |
| 13 | generateSecret: ความยาว/charset, ไม่ซ้ำ | unit |
| 14 | Zero-touch: fixture project ไม่ถูกแตะเมื่อ scanRoot ชี้ไปที่ copy | fixture |
| 15 | regression F-000 ทั้งชุด | regression |

## 9. Reports
| รอบ | test | review | security | ผล |
|---|---|---|---|---|

## 10. เอกสารที่อัปเดต (R4)
- [ ] DESIGN.md §21.4/§21.6 (home, lock, atomic, secrets at rest, newer-version)  - [ ] PLAN.md queue  - [ ] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-07 | W1 ① | ร่าง spec |
