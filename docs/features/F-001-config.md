# F-001 — Config + `$WEBHUB_HOME` + migration

| | |
|---|---|
| Status | `in-progress` |
| Phase | MVP-1 (PLAN.md) |
| DESIGN.md | §0 (ที่เก็บ config), §2 Registry, §11.3, §12, §21.4, §21.6 |
| Depends on | F-000 |
| Owner อนุมัติ | ผู้ใช้ / 2026-11-07 |

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
- ระหว่างพัฒนาตั้ง `WEBHUB_HOME` เป็นโฟลเดอร์**นอก scan root** เช่น `%APPDATA%\webhub-dev` (repo อยู่ใน scan root `E:\Workspaces\Project` จึงใช้ repo เป็น home ไม่ได้ — กติกาข้อแรกปฏิเสธ; gitignore ยังครอบ `data/` `logs/` `runtimes/` กันพลาด)
- home ที่มีอยู่แล้วต้องเป็นของ user ปัจจุบัน (Windows: owner = SID ตัวเอง หรือ Administrators; POSIX: uid ตัวเอง) และ parent ต้องเป็นของ user ตัวเอง / SYSTEM / Administrators / TrustedInstaller (POSIX: ตัวเอง / root) — กัน user อื่นสร้างโฟลเดอร์รอไว้ก่อน (security-1 S2)
- home ที่เพิ่งสร้าง → ตั้ง ACL ทันทีหลัง mkdir (ก่อนตรวจอื่นที่ช้า) ลดช่องเวลาให้ user อื่นแทรก
- ตรวจทั้ง tree (audit) เมื่อยังไม่มี marker `.webhub-secured` หรือ ACL/mode ของ home ไม่ตรง: walk เองไม่ตาม link (ไม่ใช้ `icacls /T` — มันตาม junction ออกนอก home, review-2 N1)
  - เจอ junction/reparse point (Windows) → `SYMLINK_REFUSED` (POSIX: symlink ข้าม ไม่ตาม — runtimes ใช้ symlink ปกติ)
  - เจอ entry ที่ owner ไม่ใช่ user / SYSTEM / Administrators หรืออ่านไม่ได้ → `HOME_INVALID` (N2)
  - entry ที่มี ACL ของตัวเอง (explicit / protected) → `icacls <entry> /reset` ทีละตัว แล้วตั้ง ACL ที่ home (ลูกสืบทอด); POSIX: ลบ group/other bit
  - icacls ที่รายงาน `Failed processing N>0` = error (icacls คืน 0 แม้บางไฟล์พัง)
  - ผ่านแล้วเขียน marker → ครั้งต่อไปตรวจแค่ ACL ของ home (เร็ว)
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
readDoc<T>(file, spec: DocSpec<T>, { home, lock?, backupsDir? }): Promise<{ value: T; migratedFrom?: number } | undefined>
writeDoc(lock, file, value): Promise<void>   // ต้องถือ lock; file ต้องอยู่ใน lock.home
```
- **atomic write**: เขียน `<file>.tmp-<rand>` → fsync → rename ทับ (Windows: retry เมื่อ EPERM/EBUSY จาก AV สูงสุด 5 ครั้ง) → เก็บรุ่นก่อนหน้าเป็น `<file>.bak` 1 ชุด
- ทุกไฟล์มี `schemaVersion` (integer)
  - เท่ากับปัจจุบัน → validate
  - ต่ำกว่า → รัน migration ทีละขั้น (บน copy) → validate → ถ้าถือ lock: backup ไป `data/backups/migrate/<timestamp>/<file>` แล้วเขียนกลับ; ไม่ถือ lock (CLI): ใช้ค่าที่ migrate ในหน่วยความจำ ไม่แตะไฟล์
  - **สูงกว่า** (ไฟล์จาก webhub เวอร์ชันใหม่) → error `CONFIG_FROM_NEWER_VERSION` ไม่แก้ไฟล์ (กันข้อมูลหายตอน downgrade)
- อ่านไฟล์: ปฏิเสธ symlink (lstat), จำกัดขนาด 5 MB, ตัด UTF-8 BOM, JSON parse error → error ระบุไฟล์ + line/column (หาเองด้วย `jsonErrorIndex` — **ไม่ใช้ข้อความของ V8** เพราะมันยกเนื้อหาไฟล์มา อาจมี credential), ลอง `.bak` ไม่อัตโนมัติ (แจ้งให้ `doctor` เสนอ restore)
- error ของ schema แสดงค่าที่ได้รับ `(got …)` เฉพาะตัวเลข/boolean/string สั้น และไม่แสดงเลยใต้ key ที่อาจเป็น credential (`defaultEnv`, `entries`, …) หรือเอกสาร `sensitive`
- `DocSpec.sensitive` (secrets.json): ไม่เก็บ `.bak` และลบ `.bak` เก่า — secret ที่ลบ/เปลี่ยนแล้วไม่ค้างในสำเนา (S8); migration backup ยังเก็บ (ค่าเข้ารหัสอยู่)
- เขียนได้เฉพาะ process ที่ถือ lock

### 3.3 Lock (`src/store/lock.ts`)
```ts
acquireLock(paths): Promise<Lock>   // data/.lock: { pid, startedAt, hostname, token }, เปิดแบบ exclusive (wx), 0600
Lock.release(): Promise<void>
```
- สร้าง lock แบบ atomic พร้อมเนื้อหา: เขียน temp แล้ว `link()` (มี EEXIST); filesystem ที่ไม่มี hard link → `wx`
- lock ค้างจาก process ที่ตายแล้ว (PID ไม่อยู่ หรือ start time ไม่ตรง — กัน PID reuse) → ยึดคืนได้ โดยต้องถือ guard `<lock>.takeover` (wx) และอ่านซ้ำใต้ guard ว่ายังเป็นไฟล์เดิม ถึงจะลบ — มีผู้ชนะคนเดียว (review-1 R1 / security-1 S1); guard มี token; guard ค้าง > 30 วิ ถูกลบแบบ atomic (ย้ายออก + เทียบเนื้อหา) และลบ guard เฉพาะของตัวเอง (review-2 N3)
- สถานะ process 3 แบบ `alive / dead / unknown` (Windows ใช้ CIM `Win32_Process.CreationDate` อ่านข้าม elevation ได้); `unknown` (สิทธิ์ไม่พอ, tool พัง) = ถือว่ายังมีชีวิต → `LOCKED` (R2)
- `Lock.verify()` อ่าน token บนดิสก์ก่อนทุก `writeDoc` — lock หาย/ถูกแทน → `NOT_LOCKED`
- lock ของ hostname อื่น (home บน network drive) → ถือว่ายังล็อกอยู่ (ตรวจ process เครื่องอื่นไม่ได้)
- `release()` ลบไฟล์เฉพาะเมื่อ token ตรง (ไม่ลบ lock ที่คนอื่นยึดไปแล้ว)
- process ที่ไม่ถือ lock (CLI) อ่านได้อย่างเดียว

### 3.4 Config schema (`webhub.config.json`, schemaVersion 1)
ตาม DESIGN §11.3 ทุก key: `mode`, `locale`, `scanRoots`, `maxDepth`, `ignore`, `domainSuffix`, `reservedNames`, `ports`, `infra`, `runtimes`, `daemon`, `backups`, `defaultEnv`, `onDemand`, `profilesDir`
- ไม่มีไฟล์ → ใช้ default ในหน่วยความจำ (ไม่เขียนจนกว่าจะ save — `setup` F-008 เป็นคนสร้าง)
- validate เพิ่ม: `scanRoots` เป็น absolute + มีอยู่จริง (warning เฉพาะ ENOENT; สิทธิ์ไม่พอ = error), ห้ามซ้อนกับ `$WEBHUB_HOME` (เทียบทั้ง path ตรงและ realpath — กัน junction / ชื่อ 8.3); `runtimes.dir`/`profilesDir` ห้ามเท่ากับ home; ช่วง port 1–65535 และ start ≤ end; `domainSuffix` เป็น hostname label ที่ถูกต้อง; path relative → resolve กับ home และต้องอยู่ใน home
- key ไม่รู้จัก / ค่าผิด → **error `CONFIG_INVALID` ไม่ start** พร้อมรายการทุกจุดที่ผิด (path ของ key, ค่าที่ได้, ที่คาด) — zod `strict()` ทุก object
- schema เขียนด้วย zod 4 → `configJsonSchema()` คืน JSON Schema (ไว้ให้ editor autocomplete / profile §21.5). **การ export เป็นไฟล์ `schemas/` ใน package เลื่อนออกไป** — ต้องเพิ่มใน `files` ของ package.json = แก้ F-000 (ต้องมี CR); ทำพร้อม feature ที่ใช้จริง

### 3.5 Secrets (`src/store/secrets.ts`)
```ts
class SecretStore { static open(file, home, backend): Promise<SecretStore>; get(key): string | undefined; has(key); size; set(lock, key, value): Promise<void>; delete(lock, key): Promise<void>; }
generateSecret(bytes = 32): string     // crypto.randomBytes → base64url
```
- key รูปแบบ `<scope>/<name>` เช่น `postgres-17/pos`, `auth/master`
- `set`/`delete` ทำทีละคำสั่ง (queue ภายใน) — เขียนพร้อมกันไม่ทำ secret หาย (R3)
- ค่าไม่ปรากฏใน error/log (`toJSON`/`inspect` ของ store → `[SecretStore: N secrets]`)
- at-rest: **DPAPI (CurrentUser scope)** — ไฟล์ `data/secrets.json` = `{ schemaVersion, backend, entries: { <key>: <base64 ciphertext> } }` (backend ไม่ตรง → `SECRET_BACKEND`); daemon ถอดครั้งเดียวตอนเปิดผ่าน PowerShell (`System.Security.Cryptography.ProtectedData`, spawn แบบ args array, ข้อมูลส่งทาง stdin บรรทัดละ `b:<base64>` ไม่ผ่าน argv — prefix ทำให้ secret ว่างยังเป็น 1 บรรทัด) แล้ว cache ในหน่วยความจำ; เขียน = เข้ารหัสค่าใหม่ทีละค่า
- interface `SecretBackend { name; protect(items: Buffer[]): Promise<Buffer[]>; unprotect(items: Buffer[]): Promise<Buffer[]> }` (batch = เรียก PowerShell ครั้งเดียว) → Windows = DPAPI; macOS/Linux (phase 13) = Keychain / libsecret; test ใช้ backend จำลอง + test จริงบน Windows
- DPAPI ใช้ไม่ได้ (เช่น PowerShell ถูกบล็อก) → error `SECRET_BACKEND` ไม่ fallback เป็น plaintext เงียบๆ

### 3.6 Errors
ทุก error เป็น `WebhubError { code, message, file?, hint?, details[] }` — code: `HOME_INVALID`, `CONFIG_INVALID`, `CONFIG_FROM_NEWER_VERSION`, `JSON_PARSE`, `LOCKED`, `NOT_LOCKED`, `SYMLINK_REFUSED`, `PATH_OUTSIDE_HOME`, `FILE_TOO_LARGE`, `SECRET_BACKEND`

### 3.7 เรียกโปรแกรมของ OS (`src/proc/exec.ts`)
- `execFile` = spawn แบบ args array, `shell: false`, ข้อมูลลับส่งทาง stdin; error ของ stdin (child ปิดก่อนอ่าน) ไม่ทำ process crash — ใช้ exit code แทน (R4)
- `systemExe(name)` = path เต็มของเครื่องมือ OS: Windows `%SystemRoot%\System32\…` (`icacls.exe`, `whoami.exe`, `WindowsPowerShell\v1.0\powershell.exe`; `SystemRoot`/`windir` ต้องเป็น `X:\…` ไม่งั้น error — ไม่เดา), POSIX `/bin`, `/usr/bin`, … — **ห้ามหาผ่าน PATH** (เจอจริงตอนเทส: Git Bash มี `whoami` ของ coreutils มาก่อนใน PATH ทำให้หา SID ไม่ได้; และกัน binary planting)
- `powershell(script, input?)` = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand` (script คงที่ ไม่มีข้อมูลผู้ใช้ใน script)

## 4. ผลดี / ผลเสีย
| | รายละเอียด |
|---|---|
| ผลดี | ทุก feature ต่อจากนี้ได้ที่เก็บข้อมูลที่ปลอดภัย (atomic + backup + lock) และ migration ฟรี; อัปเดต webhub ไม่ทำ config พัง; downgrade ไม่ทำข้อมูลหาย; secret แยกไฟล์และไม่หลุดใน log |
| ผลเสีย | ทุกการเขียนช้าลงเล็กน้อย (fsync + rename); lock ทำให้ CLI เขียนเองไม่ได้ (ต้องผ่าน daemon — ตรงกับ design อยู่แล้ว); ACL บน Windows ต้องเรียก `icacls` |
| ทางเลือกที่ไม่เลือก | SQLite เป็น store — query ได้ แต่ต้องมี native module (ขัด install-script block ของ F-000) และแก้ด้วยมือไม่ได้; เก็บ config ใน registry/AppData แบบ key-value — ไม่ข้าม OS; ไม่มี lock แล้วเชื่อว่ามี daemon ตัวเดียว — เสี่ยงข้อมูลเสียเมื่อเปิด 2 ตัว |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done (F-000) | test เท่านั้น | เพิ่มไฟล์ใหม่ใน `src/config`, `src/store`, `src/fs`, `src/proc`, `test/`. แก้ `test/integration/pack.test.ts` ให้อ่าน `src/` แบบ recursive (เดิมอ่านแค่ชั้นบนสุด → ไฟล์ใน subfolder ถูกนับว่า "ไม่คาดหมาย"); เจตนาเดิมไม่เปลี่ยน: ทุกไฟล์ใน `dist/` ต้องมี `src/*.ts` รองรับ. พฤติกรรม CLI/package ของ F-000 ไม่เปลี่ยน |
| Zero-touch | ไม่ | เขียนเฉพาะใน `$WEBHUB_HOME`; ปฏิเสธ home ที่อยู่ใน scan root |
| Security | มี | secret at rest, สิทธิ์ไฟล์, symlink, path traversal — ดู §6 |
| Performance | เล็กน้อย | fsync ต่อการเขียน |
| Config / data เดิม | ไม่ | ยังไม่มีผู้ใช้ |
| Dependency | เพิ่ม 1 ตัว | `zod 4.6.7` (ไม่มี dependency ย่อย) |

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
| Q1 | library validate schema | zod 4 / ajv (JSON Schema) / เขียนเอง | **zod 4** — dependency เดียวไม่มี dep ย่อย, ได้ type TS อัตโนมัติ, gen JSON Schema ให้ editor/profile (§21.5) ได้ | **zod 4** |
| Q2 | เก็บ secret บนดิสก์ยังไง | DPAPI (เข้ารหัสผูกกับ user Windows) + ACL / ACL อย่างเดียว (plain JSON) | **DPAPI + ACL** — ไฟล์ secrets หลุด (backup, copy, sync cloud) แล้วอ่านไม่ได้บนเครื่อง/user อื่น; ช้าเฉพาะตอนเปิด daemon (เรียก PowerShell ครั้งเดียวแล้ว cache ในหน่วยความจำ) | **DPAPI + ACL** |
| Q3 | config มี key ไม่รู้จัก / ค่าผิด | ไม่ start + บอกจุดผิดชัดเจน / ข้าม key แปลก + เตือน | **ไม่ start + บอกจุดผิด** — กันพิมพ์ผิดแล้วระบบทำงานด้วยค่าที่ไม่ได้ตั้งใจ (เช่น expose LAN); `doctor` ชี้วิธีแก้ | **ไม่ start + บอกจุดผิด** |
| Q4 | รูปแบบไฟล์ config | JSON / JSONC (ใส่ comment ได้) | **JSON** — ตรง DESIGN, ไม่ต้องมี parser เพิ่ม; แก้ผ่าน dashboard/CLI เป็นหลัก | **JSON** |

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
| 1 | [test-1](../reports/F-001/test-1.md) | [review-1](../reports/F-001/review-1.md) | [security-1](../reports/F-001/security-1.md) | major 6 (R1–R4, S2, S3) → แก้ |
| 2 | [test-2](../reports/F-001/test-2.md) | [review-2](../reports/F-001/review-2.md) (code + security) | ↔ | R1–R4 fixed; S2/S3 partial; major ใหม่ N1, N2 → แก้ |
| 3 | [test-3](../reports/F-001/test-3.md) | | | |

## 10. เอกสารที่อัปเดต (R4)
- [x] DESIGN.md §21.6 (home, lock, atomic, secrets at rest, newer-version)  - [x] PLAN.md queue  - [x] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-07 | W1 ① | ร่าง spec |
| 2026-11-07 | W1 ③④⑤ | อนุมัติ, เข้า queue, ผู้ใช้สั่งทำต่อ → W3 |
| 2026-11-07 | W1 ② | Q1 zod 4, Q2 DPAPI + ACL, Q3 ไม่ start + บอกจุดผิด, Q4 JSON |
| 2026-11-07 | W3 E2 | implement; ปรับ spec ให้ตรงของจริง: dev home ต้องอยู่นอก scan root, เลื่อน export ไฟล์ JSON Schema (ต้อง CR F-000), API ของ store/secrets, `systemExe` (§3.7), `NOT_LOCKED`/`PATH_OUTSIDE_HOME` |
| 2026-11-07 | W3 E3 | test-1: 89 pass / 4 skip (ตาม OS); เทสเจอ bug 2 ตัวแก้แล้ว (whoami จาก PATH, secret ว่างทำ DPAPI พัง) |
| 2026-11-07 | W3 E4/E5 | review-1 + security-1: critical 0, major 6 → แก้ครบ + test (test-2: 101 pass / 5 skip) |
| 2026-11-07 | W3 E5 | ผู้ใช้ตัดสิน minor/nit รอบ 1: แก้ทั้งหมด |
| 2026-11-07 | W3 E4/E5 | review-2: major N1, N2 + minor N3 → แก้พร้อม minor/nit ทั้งหมด (test-3: 116 pass / 5 skip) |
