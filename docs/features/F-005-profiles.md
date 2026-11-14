# F-005 — Profile loader + schema + built-in profiles

| | |
|---|---|
| Status | `review` |
| Phase | MVP-1 (PLAN.md) |
| DESIGN.md | §6 Runtime Profiles, §19.5 variants, §21.5 profiles สำหรับทุกคน, §13 (`webhub profiles`), §12 (`profiles/`, `data/profiles/`, `src/profiles/`) |
| Depends on | F-001 (home, `data/profiles/`, safe path, errors), F-003 (API route), F-004 (CLI command table) |
| Owner อนุมัติ | ผู้ใช้ / 2026-11-14 (Q1–Q6 ตามแนะนำ) |

## 1. เป้าหมาย / ขอบเขต
**ทำ (in scope)**
- รูปแบบ profile (schemaVersion 1) + validate (zod → error ชี้ field + ไฟล์ + บรรทัด) ตาม §6.1 / §19.5
- loader: built-in จาก `profiles/*.yml` ของ package + ของผู้ใช้จาก `$WEBHUB_HOME/data/profiles/*.yml` (id ซ้ำกับ built-in → ของผู้ใช้ทับทั้งตัว, Q3)
- ตัวประเมิน rule `detect` แบบ pure function บน "มุมมอง project" ที่ผู้เรียกส่งมา (`ProjectView`: มีไฟล์ไหม / อ่านไฟล์แบบจำกัดขนาด / รายชื่อ deps) → `{ matched, score, reasons }` — **ไม่เดินไฟล์เอง** (การเดิน scan root = F-006)
- เลือก `variants` ตาม version ของ dep (§19.5) → profile ที่มีผลจริง
- แปลง `start.cmd` / `runtime.install` เป็น argv (ไม่ผ่าน shell) + แทน placeholder `{PORT}` `{HOST}` และ `vars` (Q5)
- built-in profiles ชุดแรก (Q2) + fixture test ต่อ profile
- (Q4) `GET /api/v1/profiles` + `webhub profiles [--check]`: รายการ profile (id, ภาษา, ที่มา built-in / ผู้ใช้ / ทับ built-in) และปัญหาของไฟล์ที่โหลดไม่ผ่าน

**ไม่ทำ (out of scope)**
- เดินไฟล์ / ให้คะแนน project จริง / dedupe / monorepo / route prefix / port เดิม → F-006 (ใช้ `evaluateDetect` ของ F-005)
- รันอะไรทั้งนั้น (install / start) → F-017; run approval → F-007
- `webhub profiles import|export` (§21.5) → แยก item ภายหลัง (Q4)
- Runtime Manager (`runtime.lang` → version) → F-015; `container` → F-018
- กฎ "ไม่ใช่เว็บ" ระดับ global (§6.3) → F-006

## 2. ระบบเดิมรองรับยังไง (R2)
- F-001: `Paths.profiles` (`data/profiles/`) มีอยู่แล้วและ `ensureHome` สร้างให้; `assertSafePath` / ตรวจ link; `WebhubError` (`CONFIG_INVALID` + file / hint / details)
- F-003: API + auth (route ใหม่ผ่าน token / session เหมือน route อื่น)
- F-004: ตาราง `COMMANDS` ของ CLI, `--json`, exit code, `sanitize`
- package.json `files` มี `profiles` แล้ว (F-000)
- DESIGN §6.1 ใช้ YAML; §19.5 variants; §21.5 schemaVersion + fixtures — **ปรับ DESIGN** ตามคำตอบ (กติกา detect, รูป cmd, id ซ้ำ) + แถว §17

## 3. Design

### 3.1 Profile (schemaVersion 1)
```yaml
schemaVersion: 1
id: python-fastapi            # ^[a-z][a-z0-9-]{1,39}$ ไม่ซ้ำ
language: python              # ข้อความสั้น (แสดงผล)
detect:
  all:  [{ file: "requirements.txt|pyproject.toml" }]                 # ทุกข้อต้องจริง
  any:  [{ fileContains: ["requirements.txt|pyproject.toml", "fastapi|uvicorn"] }, { dep: "fastapi" }]  # จริง ≥ 1 ข้อ (ถ้ามี)
  none: [{ file: "manage.py" }]                                       # จริงข้อไหน = ไม่ match
  score: 60                                                           # 0–100 เมื่อ match
runtime: { lang: python, install: "pip install -r requirements.txt" }
start:   { cmd: "uvicorn {module}:app --reload --host {HOST} --port {PORT}", vars: { module: "main" } }
port:    { default: 8000, via: arg }          # env | arg | fixed ; env → port.env: "PORT"
host:    { bind: "127.0.0.1" }                # เฉพาะ loopback (127.0.0.1 / ::1) — อย่างอื่น = error
devServer: { hostRewrite: false }
health:  { path: "/docs", timeout: 60 }       # path เริ่มด้วย "/", timeout 1–600 วิ
container: { image: "python:3.12-slim", workdir: /app, setup: "pip install -r requirements.txt" }
db:      { hints: ["psycopg", "sqlalchemy"] }
routes:  { detectPrefix: ["APIRouter(prefix="] }
variants:
  - when: { dep: "vite", range: ">=6" }
    devServer: { hostRewrite: true }          # merge ทับแบบ object ลึก; array แทนทั้งก้อน
```
- ทุก object เป็น strict (key แปลก = error ชี้ชื่อ key) — พิมพ์ผิดไม่เงียบ
- มี `start` (process) หรือ `static: { spa }` (ไม่มี process — `static`, `static-spa`) อย่างใดอย่างหนึ่ง; `start` ต้องมี `port`; `via: arg` ต้องมี `{PORT}` ใน `start.cmd`; `via: env` ต้องมี `port.env`
- `id` ต้องตรงชื่อไฟล์ (`<id>.yml`); ไฟล์ `.yaml` = problem (ใช้ `.yml`) → id ซ้ำระหว่างไฟล์ผู้ใช้เกิดไม่ได้
- กติกา detect (ไม่มี regex จาก profile — กัน ReDoS):
  - `file: "a|b"`: path relative ใช้ `/`, ห้าม `..` / absolute / drive / `\`; `*` ได้เฉพาะ segment สุดท้าย ≤ 4 ตัว (เช่น `*.uproject`, `src/*.config.*`); ลงท้าย `/` = folder
  - `fileContains: [files, "x|y"]`: substring (case-sensitive) ในไฟล์ที่อ่านได้ ≤ 256 KB ต่อไฟล์
  - `dep: "name"` (+ `range` ได้): อยู่ใน deps ที่ผู้เรียกส่งมา (package.json / requirements / pyproject — F-006 รวบรวม)
- variants: `when.dep` + `when.range` — range แบบ comparator (`>=6`, `<13`, `>=13 <15`, `^`/`~` ตีความเป็นช่วง; ไม่รับ `*` / `x` / `||`) (Q6); เทียบกับ **version ต่ำสุดที่ประกาศ** (`^5.4.0` = 5.4.0) ไม่ใช่ที่ติดตั้งจริง; ตรงหลายข้อ → apply ตามลำดับในไฟล์; ≤ 8 variants; ตอนโหลดตรวจ**ทุกชุด**ที่ใช้พร้อมกันได้ (2^n − 1 ชุด, review-1 K9 / review-2 L2); ค่า `null` ใน variant = ลบ key (ตอนนี้ `port.env`)
- `{PORT}` / `{HOST}` ใช้ได้ใน `start.cmd`, `runtime.install`, `container.setup`; `{name}` อื่นต้องมีใน `vars`; placeholder ไม่รู้จัก = error ตอนโหลด
- คำสั่ง: printable ASCII เท่านั้น (ไม่มี control / C1 / bidi / zero-width / fullwidth / tab — security-1 S3); quote ครอบทั้ง argument เท่านั้น ห้ามมี quote อื่นข้างใน; ห้าม metachar ของ shell; ห้ามระบุที่อยู่นอก loopback ใน cmd / vars / ค่า placeholder และใน argv ที่ render แล้ว (ประกอบจาก placeholder ก็ไม่ได้): dotted quad นอก 127/8 (รวม `0127.0.0.1`), IPv6 ทุกแบบยกเว้น `::1`, มี/ไม่มี `:port`; หลัง option host (`--host`, `-H`, `--bind`, `host=` …) ทุกรูปแบบ inet_aton (`0`, `0x0`, `0.0`) (S4, review-2 L1); เลข version 4 ส่วนแบบ `x==0.110.0.1` ไม่นับ (L5); ชื่อ host (`0.0.0.0.nip.io`) → F-017 ตรวจ listener
- `port.env` = `PORT` หรือ `<NAME>_PORT` เท่านั้น (ไม่ให้ทับ `PATH`, `PATHEXT`, `NODE_OPTIONS` … — S5)
- `file:` ตรงทั้งไฟล์และ folder ชื่อนั้น (ลงท้าย `/` = folder เท่านั้น); wildcard เรียงชื่อแล้วเก็บ 32 ตัวแรก (K8); detect ของ 1 profile อ่านไฟล์ได้ ≤ 64 ไฟล์สำหรับ `all`/`any` และอีก ≤ 64 สำหรับ `none` (เกิน = ถือว่าไม่เจอ — S6, L3)

### 3.2 Interface (TypeScript, `src/profiles/`)
```ts
// schema.ts
export const PROFILE_SCHEMA_VERSION = 1;
export const ProfileSchema: z.ZodType<Profile>;          // strict
export function parseProfile(text: string, file: string): Profile;   // throws WebhubError CONFIG_INVALID (file, line, field path)

// range.ts — parseRange / satisfies / lowestVersion (spec ของ dep → version ต่ำสุด; `latest`, `workspace:*`, `||` → ไม่ apply variant)
// command.ts — splitCommand / renderCommand / placeholdersOf
// routes.ts — profileRoutes(paths): RouteRegistrar (โหลดซ้อนกัน = ใช้ผลเดียวกัน)

// loader.ts
export interface LoadedProfile { profile: Profile; source: "builtin" | "user"; file: string; overrides?: string /* built-in file ที่ถูกทับ */ }
export interface ProfileProblem { file: string; message: string; details: string[] }
export function loadProfiles(paths: Paths, opts?: { builtinDir?: string }): Promise<{ profiles: LoadedProfile[]; problems: ProfileProblem[] }>;
// ไฟล์เสีย 1 ไฟล์ไม่ทำให้ทั้งหมดล้ม: ข้ามไฟล์นั้น + อยู่ใน problems; built-in เสีย = bug → test จับ

// match.ts
export interface ProjectView {
  exists(rel: string): boolean;                 // ไฟล์/folder (rel ผ่านการตรวจแล้ว)
  list(relDir: string): string[];               // ชื่อใน folder (สำหรับ `*`)
  read(rel: string, maxBytes: number): string | undefined;
  deps(): ReadonlyMap<string, string>;          // ชื่อ → version / range ตามที่ project ประกาศ
}
export function evaluateDetect(p: Profile, view: ProjectView): { matched: boolean; score: number; reasons: string[] };
export function effectiveProfile(p: Profile, deps: ReadonlyMap<string, string>): Profile;   // apply variants
export function renderCommand(cmd: string, values: Record<string, string>): string[];        // argv, ไม่มี shell
```
- REST: `GET /api/v1/profiles` → `{ profiles: [{ id, language, source, file, overrides? }], problems: [{ file, message, details }] }` (auth เหมือน route อื่น; ไม่ส่ง path เต็มของ home ออกไป browser — `file` เป็น relative, error ที่มี path เต็ม (link / นอก home) แปลงเป็นข้อความคงที่ — K3/S2)
- CLI: `webhub profiles` (ตาราง id / language / source), `--check` → exit 2 ถ้ามี problem (สำหรับคนเขียน profile เอง), `--json`

### 3.3 Flow
1. โหลดเมื่อเรียก route ทุกครั้ง (ไฟล์ผู้ใช้เปลี่ยนแล้วเห็นทันที; ไม่มี cache / file watcher; เรียกซ้อนกัน = ใช้ผลเดียวกัน) — ผู้ใช้อื่น (F-006/F-007) เรียก `loadProfiles` เอง
2. อ่านไฟล์: `lstat` (bigint) → ต้องเป็น regular file, ไม่ใช่ link, ไม่ใช่ hard link (`nlink` 1, ไฟล์ผู้ใช้เท่านั้น), ≤ 64 KB → `open` → `fstat` ต้องเป็น `ino` เดียวกัน (ไม่เทียบ `dev`: Node 22 บน Windows ให้ 0 จาก lstat) → อ่าน ≤ 64 KB; จำนวนไฟล์ใน `data/profiles/` ≤ 200 (เกิน = problem, โหลด 200 ตัวแรกตามชื่อ)
3. parse YAML แบบ safe (YAML 1.2 core schema, ไม่มี custom tag, **ไม่รับ alias เลย** (ไม่มี alias bomb), key ซ้ำ / หลาย document / warning ของ YAML (เช่น tag ไม่รู้จัก) = error, ปฏิเสธ key `__proto__` / `constructor` / `prototype`, ข้อความ error ใช้แค่ code + บรรทัด ไม่ยกเนื้อไฟล์) → zod → ตรวจ placeholder / path pattern / range
4. id ซ้ำ: id ต้องตรงชื่อไฟล์ → ไฟล์ผู้ใช้ id ซ้ำกันเองไม่ได้; ผู้ใช้ทับ built-in → ตาม Q3; built-in ไม่ตรวจ hard link (pnpm / bun ติดตั้งเป็น hard link — K1); YAML ≤ 5000 node (นับทุกชนิดรวม map — L4), ไฟล์ ≤ 64 KB (L4), ตรวจ key ซ้ำเองแบบ O(n) (ของ `yaml` เป็น quadratic — S1); ผล parse cache ตาม (ino, size, mtime, ชื่อ) — เรียก route ซ้ำไม่ parse ไฟล์เดิมใหม่ (L4)

### 3.4 Built-in ชุดแรก (Q2)
`static`, `static-spa`, `vite`, `next`, `express`, `bun-elysia`, `fastapi` — แต่ละตัวมี fixture ใน `fixtures/<case>/` (ไฟล์ขั้นต่ำ) + ผลที่คาดหวัง; detect ของ `next` / `vite` อาศัย `dep`; `next` ใช้ variant `>=15` hostRewrite (Origin ยังเป็น spike ของ F-009); `vite` hostRewrite ทุก version (K5)

### 3.4a ข้อจำกัด / ข้อกำหนดถึง feature ถัดไป (review-1 K11, security-1 S8)
- `host.bind` เป็นค่าที่ webhub ส่งให้ (`{HOST}`); app ที่ไม่รับ HOST (express / Elysia `listen(PORT)`) bind ทุก interface ได้ → **F-017** ตรวจ listener หลัง start ว่าอยู่ใน loopback, ไม่ใช่ → เตือน / หยุด
- `start.cmd` รันโปรแกรมอะไรก็ได้ (`powershell -EncodedCommand`, UNC, `cmd /c`): ขอบเขตความปลอดภัยคือ **run approval (F-007)** — แสดง argv ที่ render แล้ว + executable ที่ resolve แล้ว (ไม่ใช่ string ดิบ), ผูก approval กับเนื้อหา profile ไม่ใช่แค่ id (ผู้ใช้ทับ built-in id ได้)
- **F-017**: resolve executable เอง (ไม่ให้ Windows หาใน cwd ของ project ก่อน — `NoDefaultCurrentDirectoryInExePath`), ห้าม `shell: true` บน POSIX, ค่าที่มี `=` / `,` / ขึ้นต้น `/` ผ่าน `.cmd` shim
- `fastapi` รองรับ `requirements.txt` เท่านั้น; project pyproject-only (uv / poetry) → profile แยกภายหลัง (follow-up)

### 3.5 Platform
- path pattern ใช้ `/` เสมอ; เทียบชื่อไฟล์แบบ case-insensitive บน Windows (ผ่าน `ProjectView` ของผู้เรียก)

## 4. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | เพิ่มภาษา / framework ด้วยไฟล์ ไม่แก้โค้ด; ผู้ใช้ทับ / เพิ่ม profile เองได้; error ชัด (ไฟล์ + บรรทัด + field); detect ไม่มี regex → ไม่มี ReDoS; คำสั่งเป็น argv ตั้งแต่ต้น → F-017 ไม่ต้องใช้ shell |
| ผลเสีย | YAML parser = dependency ใหม่ (Q1); กติกา detect จำกัด (substring + `*`) อาจไม่พอบาง framework → ต้องเพิ่ม rule type ภายหลัง (CR); variants ใช้ range แบบย่อ |
| ทางเลือกที่ไม่เลือก | profile เป็นโค้ด TS (ยืดหยุ่นสุด แต่ผู้ใช้เพิ่มเองไม่ได้ และ import = รันโค้ด); regex ใน detect (ReDoS + อ่านยาก); `cmd` ผ่าน shell (injection, ต่างกันระหว่าง cmd / sh) |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done แล้ว | น้อย | F-003: เพิ่ม route ใน API ผ่าน `registrars` ที่มีอยู่ — `daemon.ts` ส่ง `profileRoutes(paths)` นำหน้า registrars จาก test (wiring 1 บรรทัด, route เดิม / auth / โครงไม่เปลี่ยน); F-004: เพิ่ม command ในตาราง (โครงรองรับไว้แล้ว) + export `explainImpostor` เพื่อใช้ซ้ำ (พฤติกรรมไม่เปลี่ยน) |
| Zero-touch | ไม่ | อ่าน `profiles/` + `data/profiles/` เท่านั้น; F-005 ไม่แตะ project |
| Security | ใช่ | ดู §6 |
| Performance / resource | น้อย | ไฟล์ ≤ 200 × 64 KB; parse เฉพาะไฟล์ที่เปลี่ยน (cache) |
| Config / data เดิม | ไม่ | `data/profiles/` มีแล้ว (ว่าง) |
| Dependency | ใช่ (Q1) | `yaml` (pin, ไม่มี dependency ต่อ, ไม่มี install script) |

## 6. Threat model (R6)
| Asset | ผู้โจมตี / ช่องทาง | ป้องกันด้วย | เทส |
|---|---|---|---|
| daemon (ถือ token) | YAML ที่ทำให้ใช้ memory / CPU มาก (alias bomb, ไฟล์ใหญ่, ไฟล์เยอะ) — จาก profile ที่ผู้ใช้ copy มาจากที่อื่น | ขนาด ≤ 64 KB, ≤ 5000 node, ≤ 200 ไฟล์, ไม่รับ alias, ตรวจ key ซ้ำ O(n), cache ผล parse, ความยาว array จำกัดใน schema | alias bomb / ไฟล์ใหญ่ → problem, daemon ไม่ค้าง |
| daemon | prototype pollution จาก key `__proto__` | ปฏิเสธ key ต้องห้ามก่อน zod; strict object | YAML มี `__proto__` → problem; `Object.prototype` ไม่เปลี่ยน |
| CPU | ReDoS จาก pattern ใน profile | ไม่มี regex จาก profile: substring + `*` แบบ segment เดียว (match แบบ linear) | pattern ยาว / `*` เยอะ → เวลาจำกัด |
| ไฟล์นอก project | pattern `../` / absolute ใน `file` / `fileContains` | validate ตอนโหลด (ห้าม `..`, absolute, drive, `\`); `ProjectView` ของ F-006 จำกัด root อีกชั้น | pattern ต้องห้าม → problem |
| เครื่องผู้ใช้ | command injection ผ่าน `cmd` / `vars` / ค่า placeholder | `renderCommand` → argv (ไม่มี shell), metachar ของ shell ใน cmd = error ตอนโหลด, ค่า vars / placeholder ต้องตรง allowlist อักขระ, แทนได้เฉพาะชื่อที่ประกาศ | cmd มี `&` / `|` / `;` / `` ` `` / `$(` → error; ค่ามีช่องว่าง / quote → error |
| เครื่องผู้ใช้ | profile สั่ง bind นอก loopback | `host.bind` เฉพาะ `127.0.0.1` / `::1`; cmd / vars / ค่า placeholder ห้ามที่อยู่นอก loopback; app ที่ไม่สน HOST → F-017 ตรวจ listener (§3.4a) | `0.0.0.0` / `--host 0.0.0.0` / var `0.0.0.0` → error |
| ไฟล์ใน `data/profiles/` | link / hardlink ชี้ออกไปนอก home | `assertSafePath` + `lstat` regular file + ไม่ใช่ link | link → problem |
| terminal / browser | ชื่อ / ข้อความจาก profile มี control char | CLI ผ่าน `sanitize`; API ส่ง JSON (dashboard escape — F-027) | id / language มี ESC → พิมพ์เป็น `?` |
| ผู้ใช้ | profile ที่ได้มาจากคนอื่นรันคำสั่งทันที | F-005 ไม่รันอะไร; run approval = F-007 | — |
| supply chain | `yaml` package | pin version, lockfile, `pnpm audit`, ไม่มี postinstall | audit ใน checks |

Security checklist (WORKFLOW §8): ไม่มี secret ✓, input validation ทุก field ✓, ไม่มี shell ✓, อ่านเฉพาะใน home / package ✓, dependency ใหม่ → ตาม Q1

## 7. คำถามถึงผู้ใช้ (ขั้น ②)
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|
| Q1 | รูปแบบไฟล์ profile | A YAML + package `yaml` (pin) / B JSON (ไม่มี dependency ใหม่, ไม่มี comment) / C JSON5-ish ทำเอง | **A** (ตรง DESIGN, เขียนมือง่าย, มี comment) | ตามแนะนำ (2026-11-14) |
| Q2 | built-in ชุดแรกใน F-005 | A 7 ตัว (static, static-spa, vite, next, express, bun-elysia, fastapi) / B ทั้ง Node + Python ใน §6.2 (~16 ตัว) / C เฉพาะ 4 ตัวที่ fixture ในเครื่องผู้พัฒนาใช้ | **A** (ครบ fixture §9; เพิ่มทีหลังเป็นไฟล์ + fixture) | ตามแนะนำ (2026-11-14) |
| Q3 | profile ผู้ใช้ id เดียวกับ built-in | A ทับทั้งตัว + แสดงว่า "overrides built-in" / B merge เฉพาะ field ที่เขียน / C ห้าม (ต้องใช้ id ใหม่) | **A** (คาดเดาได้, ไม่มี merge แปลก) | ตามแนะนำ (2026-11-14) |
| Q4 | CLI / API ใน F-005 | A library + `GET /api/v1/profiles` + `webhub profiles [--check]` / B library อย่างเดียว / C A + `import/export` | **A** (import/export ทำพร้อม run approval) | ตามแนะนำ (2026-11-14) |
| Q5 | รูป `start.cmd` | A string → แยกเป็น argv เอง (รองรับ `"..."`), metachar shell = error / B array of args / C รับทั้งสอง | **A** (ตรง DESIGN, อ่านง่าย, ไม่มี shell) | ตามแนะนำ (2026-11-14) |
| Q6 | version range ใน variants | A ทำเอง (comparator `>= > <= < =`, `^`, `~`) / B package `semver` | **A** (ใช้แค่ช่วงง่าย; ไม่เพิ่ม dependency) | ตามแนะนำ (2026-11-14) |

## 8. Test plan
| # | กรณี | ประเภท |
|---|---|---|
| 1 | built-in ทุกตัว parse + validate ผ่าน; id ไม่ซ้ำ | unit |
| 2 | key แปลก / type ผิด / ค่าเกินช่วง → error มีไฟล์ + บรรทัด + path ของ field | unit |
| 3 | ไฟล์ผู้ใช้เสีย 1 ไฟล์ → อยู่ใน problems, ที่เหลือโหลดได้ | unit |
| 4 | ผู้ใช้ทับ built-in (Q3); id ต้องตรงชื่อไฟล์ | unit |
| 5 | YAML alias bomb, ไฟล์ > 64 KB, > 5000 node, > 200 ไฟล์, `__proto__`, custom tag → problem, ไม่ค้าง, prototype ไม่เปลี่ยน | security |
| 6 | link / hardlink ใน `data/profiles/` → problem | security |
| 7 | pattern `..` / absolute / `C:` / `\` → error | security |
| 8 | detect: all / any / none / score, `*` ใน segment, folder `x/`, fileContains จำกัด 256 KB, dep (+range) | unit |
| 9 | pattern ยาว + `*` เยอะ → เวลา linear | security |
| 10 | variants: เลือกตาม range, หลายข้อตามลำดับ, deep merge / array แทน | unit |
| 11 | range parser: `>=6`, `<13`, `>=13 <15`, `^1.2.3`, `~1.2`, ค่าแปลก → error ตอนโหลด | unit |
| 12 | `renderCommand`: quote, placeholder, vars; metachar / ค่าแปลก / placeholder ไม่รู้จัก → error | unit / security |
| 13 | `host.bind: 0.0.0.0` → error | security |
| 14 | fixture ต่อ built-in profile: match ถูกตัว, ไม่ match ตัวอื่นเกินคะแนน | fixture |
| 15 | `GET /api/v1/profiles` ต้องมี auth; ไม่มี path เต็ม; `webhub profiles` / `--check` exit 2 เมื่อมี problem / `--json`; ข้อความ sanitize | integration |
| 16 | Node 22.12 | compat |

## 9. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/F-005/test-1.md) 436/6 | [review-1](../reports/F-005/review-1.md) **FAIL** (K1, K2 major) | [security-1](../reports/F-005/security-1.md) **FAIL** (S1 major) | K1, K2, K4, S1 แก้แล้ว; minor/nit ถามผู้ใช้ |
| 2 | [test-2](../reports/F-005/test-2.md) 447/6 | [review-2](../reports/F-005/review-2.md) code + security **PASS** (L1–L4 minor, L5–L6 nit) | (รวมใน review-2) | minor/nit รอบ 1 แก้ทั้งหมด → รอบ 2 PASS |
| 3 | [test-3](../reports/F-005/test-3.md) 452/6 (+1 F-004 flaky → CR-004) | — | — | L1–L6 แก้ทั้งหมด (ผู้ใช้เลือก "แก้แล้ว merge") |

## 10. เอกสารที่อัปเดต (R4)
- [x] DESIGN.md §6.1 (กติกา detect / cmd / id ซ้ำ), §17  - [x] PLAN.md  - [x] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-14 | W1 ① | ร่าง spec |
| 2026-11-14 | W1 ②–④ | ผู้ใช้ตอบ Q1–Q6 ตามแนะนำ (YAML + `yaml`, 7 built-in, ผู้ใช้ทับทั้งตัว, lib + API + CLI, cmd string → argv, range ทำเอง) → `planned` |
| 2026-11-14 | W3 | ผู้ใช้สั่ง "เริ่มเลย" → implement `src/profiles/*`, `profiles/*.yml` ×7, fixtures ×6, `webhub profiles`, `GET /api/v1/profiles`; `yaml@2.9.1` (ไม่มี dependency / install script); test-1 → `review` |
