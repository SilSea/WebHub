# F-006 — Scanner + detector

| | |
|---|---|
| Status | `testing` |
| Phase | MVP-1 (PLAN.md) |
| DESIGN.md | §9 Detection, §6.3 ตัดคะแนน (ไม่ใช่เว็บ), §7 Runners (เลือก runner), §19.1 runtime version hint, §12 (`src/scanner/`), §13 (`webhub scan`), §21.5 fixtures |
| Depends on | F-001 (config `scanRoots`, home, store, safe path), F-002 (platform: ไม่ใช้ shell), F-003 (API + auth), F-004 (CLI), F-005 (`loadProfiles`, `evaluateDetect`, `effectiveProfile`, `ProjectView`) |
| Owner อนุมัติ | ผู้ใช้ / 2026-11-15 (Q1–Q6 ตามแนะนำ) |

## 1. เป้าหมาย / ขอบเขต
**ทำ (in scope)** — ขอบเขตตามแนะนำใน Q1 (แยก "deep detect" ออกเป็น F-006b)
- เดิน `scanRoots` แบบ**อ่านอย่างเดียว** หา folder ที่เป็น project (candidate) — ไม่ตาม symlink / junction, ความลึกตาม config `maxDepth` + ไม่เข้า folder ใน config `ignore` (F-001; ผู้ใช้เลือก 2026-11-15 แทนค่าคงที่ 4 ของ Q2), จำกัดจำนวน / เวลา
- ต่อ candidate: สร้าง `ProjectView` (F-005) จาก disk ที่จำกัดอยู่ใน folder นั้น + รวม deps จาก `package.json` / `requirements.txt` / `pyproject.toml` → `evaluateDetect` กับทุก profile → profile ที่ชนะ (คะแนนสูงสุด, เสมอ → id ตามตัวอักษร) + ตัวเลือกอื่น + เหตุผล
- ตัดคะแนน "ไม่ใช่เว็บ" (§6.3): browser extension (`manifest.json` ที่มี `manifest_version`), Roblox `*.rbxl(x)`, Unreal `*.uproject`, Unity `ProjectSettings/`, `*.csproj` ที่ไม่มี `Microsoft.AspNetCore`, `electron` / `tauri` / `@tauri-apps/*` ใน deps, Python ที่ไม่มี web framework (ไม่มี profile Python ไหน match) → `kind: "not-web"` + เหตุผล
- Score ≥ 50 = เว็บ (§9)
- **Runner** (§9): มี compose ที่ service ของ app `build:` → `compose`; compose ที่ mount source (volume `.:/app` / `./src:…`) หรือมีแค่ infra (image DB/redis เท่านั้น) → `hybrid`; ไม่มี compose → profile static → `static`, ไม่งั้น `native`. อ่าน compose ด้วย parser YAML แบบเดียวกับ F-005 (Q6)
- **Monorepo / แยก repo** (§9): sub-folder `frontend|client|web|ui|*-frontend|*-web` + `backend|server|api|*-backend|*-api` ใต้ folder เดียวกัน → candidate เดียว หลาย service (`services.frontend`, `services.backend`)
- **ซ้อน / ซ้ำ** (§9): project ที่อยู่ใน project อื่น → เทียบ fingerprint (sha256 ของ manifest: `package.json`, compose, `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `index.html` ที่ root — ไม่รวม lockfile เพราะใหญ่ กิน byte limit, review-2 R2) กับ candidate อื่น → ตรงกัน = `kind: "duplicate"` + `duplicateOf`; ไม่ตรง = candidate ปกติ (ส่วนประกอบ)
- **Port เดิม + via** (§9 ชุดที่ไม่ต้องอ่าน source code): `vite.config.*` `server.port` (ตัวเลข literal เท่านั้น → `arg`), `.env*` key `PORT` / `*_PORT` (Q5 → `env`), compose `ports:` (รวม `${VAR:-N}`), Dockerfile `EXPOSE`, script ใน `package.json` ที่มี `--port N` / `-p N` (→ `arg`, เรียก binary ตรง — §6.2) — ได้ค่า + ที่มา; ไม่เจอ → ใช้ `port` ของ profile
- **publicDir** (§9): `public/` / `dist/` / `docs/` ที่มี `index.html` (ตามลำดับนี้) ไม่งั้น root — เฉพาะ profile static
- **Runtime version hint** (§9 / §19.1): `.nvmrc`, `.node-version`, `engines.node`, `packageManager`, `.python-version`, `requires-python`, `.bun-version`, Dockerfile `FROM` (hint) — เก็บเป็น string + ที่มา ยังไม่ resolve (F-015); ต้องตรงรูปแบบ version (ไม่มี `;` `$` quote backtick `&`), `packageManager` = `ชื่อ@x.y.z` เท่านั้น — hint เป็นข้อความไม่น่าไว้ใจ ห้ามส่งเข้า shell (security-1 S6)
- ชื่อ site ที่เสนอ: slug จากชื่อ folder (`[a-z0-9-]`, ≤ 40, ชนกัน → ต่อ `-2`) — การจอง / validate ชื่อเป็นของ F-007
- เก็บผล scan ล่าสุดที่ `data/scan.json` ผ่าน store (F-001, atomic + lock; daemon เป็นผู้เขียนคนเดียว) (Q3)
- API + CLI (Q4): `POST /api/v1/scan` เริ่ม scan (ทีละ 1 งาน), `GET /api/v1/scan` สถานะ + ผลล่าสุด; `webhub scan [--json]` รอจนจบ + แสดงตาราง
- fixtures ใหม่สำหรับ monorepo / compose / duplicate / not-web / symlink + ผลที่คาดหวัง (§21.5)

**ไม่ทำ (out of scope)**
- **F-006b "deep detect"** (Q1, item ใหม่ ก่อน F-009): route prefix จาก source code (`.group("/api")`, `setGlobalPrefix`, `app.use('/api')`, `APIRouter(prefix=`) + `socket.io` / `ws` route, shared service, DB (image ใน compose + deps + env keys), URL env (§11.2), dev services (§5.8), `.listen(N)` (fixed)
- pending list / approve / ignore / add / override ไม่ถูก rescan ทับ → F-007 (F-006 ไม่เขียน `data/sites/`)
- รันอะไรทั้งนั้น (ไม่เรียก `git`, `npm`, `docker compose config`, interpreter) — อ่านไฟล์อย่างเดียว
- `webhub roots add|remove|list` → F-008 (setup) — F-006 ใช้ `scanRoots` จาก config ที่มีอยู่
- scan อัตโนมัติ / file watcher → ภายหลัง (F-007 / dashboard)

## 2. ระบบเดิมรองรับยังไง (R2)
- F-001: `config.scanRoots` (absolute, ตรวจแล้วว่าไม่ซ้อนกับ home), `Paths.data`, store (`writeDoc` atomic + lock + zod + schemaVersion + migration), `isInside` / `assertSafePath`, `WebhubError`
- F-003: route ผ่าน auth เดียวกับ route อื่น (`RouteRegistrar`), `REQUEST_TIMEOUT_MS` 30 วิ → scan ต้องเป็นงานเบื้องหลัง ไม่ใช่ request ยาว
- F-004: CLI command table + `ensureDaemon` + sanitize output
- F-005: `loadProfiles`, `evaluateDetect`, `effectiveProfile`, `ProjectView`, `wildcardMatch`, parser YAML แบบปลอดภัย (ใช้ซ้ำกับ compose), `MAX_READS_PER_PROFILE`
- DESIGN ที่เพิ่ม / ปรับ (ขั้น ③ → §17 แถวใหม่): §9 เพิ่มข้อ "อ่านอย่างเดียว + ขีดจำกัด + `.env` เก็บแค่ port" และแยก F-006 / F-006b; §12 `data/scan.json`

## 3. Design
### 3.1 Walk (`src/scanner/scan.ts` `step`, `src/scanner/fsread.ts`)
- เริ่มจากแต่ละ scan root (ตรวจ: มีอยู่, เป็น folder, ไม่ใช่ link, ไม่ซ้อนกับ home — F-001); root ที่ใช้ไม่ได้ → `roots[i].status` + เดิน root อื่นต่อ; root ที่ซ้ำกับ root ก่อนหน้า → `inside-root` ไม่เดิน; root ที่อยู่ใน root อื่น → `inside-root` แต่ยังเดิน (walk นอกอาจไปไม่ถึง: ความลึก, `ignore`, folder จุด — review-4 V1); ทุก folder ถูก list ครั้งเดียว (ชุด `visited` ร่วม) — review-2 R4
- BFS ความลึก ≤ config `maxDepth` (F-001, ค่าเริ่มต้น 3 — ครอบตัวอย่างลึกสุดใน §9) จาก root; ต่อ folder: `lstat` → ข้าม symlink / junction / reparse point ทุกชนิด (บันทึกใน `skipped` เป็น `link`) → `opendir` → อ่าน entry (≤ 5 000 ต่อ folder, เกิน = `skipped: too-many-entries`)
- กัน TOCTOU (folder ถูกสลับเป็น junction ระหว่าง `lstat` กับ `opendir`): หลังเปิด `realpath` ต้องเท่ากับ path ที่คาด และอยู่ใน root → ไม่ตรง = ข้าม + `skipped: changed`
- ไม่ลง: ชื่อใน config `ignore` (ไม่สนตัวพิมพ์) และ `node_modules`, `.git`, `.hg`, `.svn`, `vendor`, `.venv`, `venv`, `env`, `__pycache__`, `target`, `dist`, `build`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `coverage`, `.cache`, `.turbo`, `bin`, `obj`, `Library`, folder ที่ขึ้นต้นด้วย `.` (ยกเว้นอ่านไฟล์ marker ระดับ project), `$RECYCLE.BIN`, `System Volume Information`
- folder เป็น candidate เมื่อมี marker ของ profile ใด ๆ หรือ marker ทั่วไป (`package.json`, `index.html`, `compose*.y(a)ml` / `docker-compose*.y(a)ml`, `Dockerfile`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `manage.py`, `composer.json`, `Gemfile`, marker ไม่ใช่เว็บ §6.3) → ยังเดินลงต่อเพื่อหา monorepo / project ซ้อน (ภายในความลึกรวม); Unity: folder `ProjectSettings/` ก็นับเป็น marker
- ขีดจำกัดรวมต่อ scan: folder ≤ 20 000, อ่านไฟล์รวม ≤ 64 MB, ไฟล์เดียว ≤ 256 KB (manifest), เวลา ≤ 60 วิ → เกิน = หยุด, `truncated` + เหตุผล (+ `root` ที่ถูกตัด) — ผลที่ได้ถึงตอนนั้นยังใช้ได้: folder ที่เจอแล้วถูก detect ต่อด้วยโควตาสำรอง (เวลา 1/6, byte / folder 1/8) ครั้งเดียว; หมดโควตาสำรอง → ที่เหลือเป็น `unknown` (review-1 C1)
- เดิน root แบบ round robin (ทีละ folder ต่อ root) และ detect แบบ round robin ตาม root — root กว้าง / มี candidate ปลอมเป็นพัน ไม่กินขีด folder / candidate / byte / เวลาของ root อื่น (security-1 S3, review-2 R1 / R2 — แทนการแบ่งโควตาต่อ root ของรอบ 1 ซึ่งตัดผลผิดเมื่อมี root ที่ใช้ไม่ได้)
- sub-folder ที่ view อ่านเพิ่มก็กรองชื่อแปลกเหมือน walk (review-1 C9)
- ชื่อ entry ที่มี control char / ไม่ใช่ UTF-16 ที่ถูกต้อง → ข้าม + `skipped: bad-name` (กัน log / terminal injection)

### 3.2 ProjectView บน disk (`src/scanner/view.ts`)
- จำกัดอยู่ใน folder ของ candidate: `rel` ผ่าน schema ของ F-005 แล้ว (ไม่มี `..` / absolute) + ตรวจ `isInside` อีกชั้น; ทุก segment ต้องไม่ใช่ link (`lstat`)
- อ่านไฟล์: `lstat` → regular file, ไม่ใช่ link → `open(O_RDONLY)` → `fstat` ino ตรงกัน → อ่าน ≤ `maxBytes` (แบบเดียวกับ F-005 loader); ไม่เขียน ไม่ล็อก ไม่เปลี่ยน attribute
- `caseInsensitive: true` บน Windows
- `deps()`: `package.json` (`dependencies` + `devDependencies` + `peerDependencies`, ค่าเป็น string), `requirements.txt` (`name==x` / `name>=x` / ชื่อเปล่า; ข้าม `-r` / `-e` / URL), `pyproject.toml` (`[project].dependencies` + `[tool.poetry.dependencies]` — parser TOML แบบจำกัดเฉพาะ 2 ตารางนี้ ไม่ใช้ dependency ใหม่ — Q6); deps ≤ 2 000 รายการ, ชื่อ ≤ 214 ตัวอักษร
- cache อ่านไฟล์ต่อ candidate ใน scan เดียว (หลาย profile อ่านไฟล์เดิม)

### 3.3 Detect + runner (`src/scanner/scan.ts` `detect`, `src/scanner/view.ts`, `hints.ts`, `compose.ts`)
1. ทุก profile (`loadProfiles` ครั้งเดียวต่อ scan; problem ของ profile → `problems`) → `evaluateDetect` → เรียงคะแนน
2. กฎไม่ใช่เว็บ (§6.3) → `kind: "not-web"` (แม้มี profile match — เหตุผลทั้งสองฝั่งเก็บไว้ให้ผู้ใช้เห็น, F-007 ให้ผู้ใช้เพิ่มเองได้)
3. คะแนนสูงสุด < 50 → `kind: "unknown"` (มี marker แต่ไม่มี profile) — แสดงใน pending ได้เพื่อ add manual (§21.3)
4. `effectiveProfile` (variants ตาม deps) → `start` / `static` / `port` / `devServer` ของ service
5. compose: หาไฟล์ `compose.y(a)ml`, `docker-compose.y(a)ml` (+ `*.override.*`) ที่ root ของ candidate → parse (YAML safe ของ F-005: ยอม anchor / merge `<<` ตาม Q6: alias ≤ 100, `maxAliasCount` 100, node cap เดียวกับ F-005; ข้อความ error ไม่ยกเนื้อไฟล์) → service ที่มี `build` = app, ที่มี `image` ของ DB/cache ที่รู้จัก = infra; volume ที่ mount `.` / `./…` เข้า app = mount source
6. runner ตาม §9 (ดู §1)
7. compose ใน folder เดียว: อ่านเหมือน `docker compose` — ไฟล์ base แรกที่เจอ (`compose.yaml` → `compose.yml` → `docker-compose.yaml` → `docker-compose.yml`) + override แรก; base อื่นที่เกิน → problem; ไม่มี base → ไม่มี compose (review-5 W1); รวม service ตามชื่อก่อนจัด app / infra (review-4 V2), ≤ 200 service (review-5 W2); monorepo (compose ที่ parse ไม่ได้ไม่ถูกนับ + อยู่ใน `problems`; service ชื่อซ้ำระหว่างแม่กับลูกนับครั้งเดียว — review-2 R3; folder แม่ต้องอยู่ใน scan root เดียวกัน — ไม่สร้าง site นอก root, security-1 S4; compose ที่ folder แม่ — `build: ./frontend` — เป็นตัวกำหนด runner / `compose` ก่อน, review-1 C4): candidate ลูกที่ชื่อตรง pattern frontend / backend ใต้ parent เดียว (parent ไม่มี marker เว็บเอง หรือมีแค่ compose) → รวมเป็น candidate ของ parent; ลูกแต่ละตัวเป็น service
8. ซ้อน (folder ที่ยังไม่ได้อ่านเพราะหมดเวลา / byte ไม่ถูกซ่อน — review-4 V3; non-site ซ่อนใต้ candidate ใดก็ได้ — Unity `Packages/`, Python sub-package, review-3 Q3; site ซ่อนใต้ `site` เท่านั้น — `requirements.txt` หลงที่ root ไม่ซ่อน project ข้างล่าง, review-1 C6): `unknown` / `not-web` / static (`index.html` ใน project — `public/`, `docs/`) → ไม่แสดง (เป็นส่วนของ project แม่) — เช็คก่อน duplicate (review-1 C3); `site` ที่ไม่ใช่ static: fingerprint (§1) เท่ากับ candidate ที่แสดงอยู่และไม่ใช่ duplicate (ไม่ซ้อนกัน) → `duplicate`, ไม่ตรง → candidate ปกติ
9. port / via / publicDir / runtime hint ตาม §1 (ไม่เจอ port → `port` ของ profile, source `profile <id>`)
10. ชื่อ: site ได้ชื่อเปล่าก่อน, duplicate / อื่น ๆ ได้ `-2`, `-3` (เรียงตาม path)

### 3.4 ผล scan (`data/scan.json`, schemaVersion 1)
```ts
interface ScanResult {
  schemaVersion: 1;
  scanId: string;               // random 16 hex
  startedAt: string; finishedAt: string;
  truncated: false | { reason: "time" | "folders" | "bytes" | "candidates" }; // ขีดแรกที่ชนเท่านั้น (review-2 R5: ไม่บอกทุกเหตุ / ทุก root — ผลบางส่วนยังใช้ได้)
  roots: { path: string; status: "ok" | "missing" | "not-a-folder" | "link" | "no-access" | "inside-home" | "inside-root" }[];
  candidates: Candidate[];      // เรียงตาม path
  skipped: { path: string; reason: "link" | "too-many-entries" | "changed" | "bad-name" | "no-access" }[]; // ≤ 500 (bad-name: path ของ folder แม่ ไม่ใช่ชื่อแปลก)
  problems: { file: string; message: string }[];   // profile ที่โหลดไม่ผ่าน, compose parse ไม่ได้ (ไม่ยกเนื้อไฟล์)
}
interface Candidate {
  key: string;                  // sha256(realpath ตัวเล็ก) 16 hex — คงที่ข้าม scan (F-007 ใช้จับคู่)
  name: string;                 // slug ที่เสนอ
  path: string;                 // absolute
  kind: "site" | "not-web" | "unknown" | "duplicate";
  score: number;
  profile?: string; alternatives: { profile: string; score: number }[];
  reasons: string[]; notWeb: string[];
  runner?: "static" | "native" | "compose" | "hybrid";
  compose?: { files: string[]; app: string[]; infra: string[]; mountsSource: boolean };
  services: Record<string, {
    cwd: string;                // relative ใน candidate
    profile: string;
    port?: { value: number; via: "arg" | "env" | "fixed"; env?: string; source: string };
    publicDir?: string;
    runtime?: { lang: string; hint: string; source: string }[];
  }>;
  duplicateOf?: string;         // key
  fingerprint: string;
}
```
- ค่า string ทุกตัวที่มาจาก project (ชื่อ, เหตุผล, path) ถูก sanitize ตอนแสดงใน CLI (F-004) และ escape ใน dashboard; ใน JSON เก็บตามจริง
- **ไม่เก็บค่า `.env`** นอกจากเลข port ของ key `PORT` / `*_PORT` (Q5); `.env*` อ่านครั้งเดียวไม่เข้า cache ของ view (`readOnce`) — ไฟล์: `.env`, `.env.local`, `.env.development`, `.env.development.local`
- ขนาดไฟล์ ≤ 5 MB (ขีดของ store) → candidate ≤ 2 000; ผลแบบที่ store เขียน (JSON pretty, review-3 Q1) เกิน 5 MB − 256 KB → ตัด candidate ท้ายทีละ 10 % + `truncated: candidates` แทนการล้มทั้ง scan (review-1 C11)
- ข้อความจาก project ถูกตัดตามขีดของ schema ตอนสร้าง (ชื่อไฟล์ในข้อความ ≤ 60, reason ≤ 400, notWeb ≤ 200, ชื่อ + `-N` ≤ 40); candidate ที่ยังผิด schema → ตัดทิ้ง + problem; ผลทั้งก้อนผ่าน `ScanResult.parse` ก่อนบันทึก / ส่ง (security-1 S2)
- Dockerfile อ่าน ≤ 64 KB, จับ `EXPOSE` / `FROM` ทีละบรรทัด (`[ \t]` ไม่ใช่ `\s`, ไม่มี flag `m`) — regex หลายบรรทัดเป็น O(n²) (security-1 S1)

### 3.5 Interface
- lib: `scan(paths, { scanRoots, maxDepth?, ignore?, scanId?, signal?, limits?, onProgress? }): Promise<ScanResult>` — limit → ผลบางส่วน + `truncated`; abort → throw
- REST (auth เหมือน route อื่น):
  - `POST /api/v1/scan` → `202 { scanId }`; มีงานอยู่ → `409 SCAN_RUNNING` + `scanId` เดิม; daemon กำลังปิด → `503`
  - `GET /api/v1/scan` → `{ running: { scanId, startedAt, folders, candidates } | null, last: ScanResult | null, lastError: { scanId, code, message } | null }` (message คงที่ ไม่มี path); `?result=0` → `last: null` ขณะมีงานรัน (CLI poll ไม่ต้องดึงผลทั้งก้อน, review-1 C14)
  - `DELETE /api/v1/scan[?scanId=]` → ยกเลิกงานที่รัน (abort) — ผลบางส่วนไม่บันทึก; มี `scanId` ไม่ตรงงานที่รัน → `{cancelled:false}` (CLI ส่งเสมอ — Ctrl+C ไม่ยกเลิกงานของคนอื่น, review-1 C13); DELETE ที่มาถึงตอนกำลังเขียนไฟล์ → ตอบ `cancelled:true` แต่ผลถูกบันทึกแล้ว (ไม่มีผลเสีย: ผลครบ)
  - CLI เจอ `409` แล้วงานนั้นจบไปก่อน → POST ใหม่ (≤ 3 ครั้ง)
- CLI: `webhub scan` (เริ่ม → poll ทุก 500 ms + แสดงความคืบหน้าบน stderr → ตาราง name / kind / profile / runner / port / path), `--json`, `--last` (ไม่ scan ใหม่ แค่แสดงผลล่าสุด); Ctrl+C → `DELETE`; exit 0 ปกติ, 2 ถ้า `truncated` หรือมี problem
- daemon ปิดระหว่าง scan → abort + รอจบ (ก่อนปล่อย lock), ไม่เขียนผลครึ่ง ๆ; การรอ config ก็ยกเลิกได้

### 3.6 Platform
- Windows: case-insensitive, junction = link (ข้าม), path ยาว > 260 (Node รองรับ), ชื่อสงวน (`CON`, `NUL`, …) ข้าม + `bad-name`
- OneDrive / cloud placeholder: การอ่านไฟล์อาจทำให้ดาวน์โหลด — อ่านแค่ไฟล์ manifest เล็ก ๆ (ยอมรับ; บันทึกเป็นข้อจำกัด)
- Lite mode: เหมือนกัน (ไม่ใช้ Docker)

## 4. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | อ่านอย่างเดียว ไม่รันอะไร (R0 + R6); ใช้ rule ของ profile ทั้งหมด (ไม่มี logic เฉพาะภาษาในโค้ดนอกจาก deps / port / runtime hint); งานเบื้องหลังไม่ติด request timeout; ผลมี `key` คงที่ให้ F-007 จับคู่ข้าม scan; แยก deep detect ทำให้ item นี้ test ได้ครบ |
| ผลเสีย | ขีดความลึก (`maxDepth`, ค่าเริ่มต้น 3) อาจพลาด project ที่ลึกกว่า (แก้ได้ด้วยเพิ่ม scan root หรือ `webhub add`); ไม่ตาม link → project ที่อยู่หลัง junction ไม่เจอ; heuristics monorepo / runner ผิดได้ → ผู้ใช้แก้ใน F-007; F-006 ยังไม่มี route / DB / URL env → site ที่ใช้ `/api` ต้องรอ F-006b ก่อน routing จริง |
| ทางเลือกที่ไม่เลือก | (1) scan แบบ sync ใน request — ชน 30 วิ timeout; (2) ใช้ `docker compose config` อ่าน compose — รันโปรแกรม + ต้องมี Docker; (3) ใช้ glob library — ตาม link / ควบคุม limit ยาก; (4) ไม่เก็บผล (memory อย่างเดียว) — dashboard / CLI เปิดใหม่แล้วหาย, F-007 ต้อง scan ซ้ำ; (5) ทำ deep detect ใน item เดียว — ใหญ่เกิน review ไม่ทั่ว |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done แล้ว | ไม่ (เพิ่มอย่างเดียว) | route / command ใหม่; `data/scan.json` ไฟล์ใหม่ (F-001 store รองรับ); ใช้ API ของ F-005 ตามที่ export ไว้ |
| Zero-touch | ต้องพิสูจน์ | อ่านอย่างเดียว (`O_RDONLY`), ไม่สร้างไฟล์ใน project; test ใช้ hash ก่อน/หลัง (fixture harness) ทุก fixture; atime อาจเปลี่ยน (NTFS ปิดไว้เป็นค่าเริ่มต้นบน Windows 10+) — ไม่ถือเป็นการแก้ |
| Security | ใหม่ | อ่านไฟล์ของ project ที่อาจไม่น่าไว้ใจ (repo ที่ clone มา) → ดู §6 |
| Performance / resource | ปานกลาง | จำกัด folder / byte / เวลา; งานเดียวต่อครั้ง; CPU ของ YAML compose จำกัดด้วยขีดของ parser F-005 |
| Config / data เดิม | ไม่ | อ่าน `scanRoots`; ไม่แก้ config |

## 6. Threat model (R6)
| Asset | ผู้โจมตี / ช่องทาง | ป้องกันด้วย | เทส |
|---|---|---|---|
| ไฟล์นอก scan root (home ของ user, ไฟล์ระบบ) | repo ที่ clone มามี symlink / junction ชี้ออกนอก (เช่น `C:\Users\x\.ssh`) | ไม่ตาม link ทุกชนิด, `realpath` ต้องอยู่ใน root, ตรวจ ino ตอนเปิดไฟล์ | link → `skipped`, ไม่มีเนื้อหาจาก target ในผล |
| Zero-touch (project ของผู้ใช้) | bug ที่เขียน / สร้างไฟล์ | เปิด `O_RDONLY` อย่างเดียว, ไม่มีโค้ดเขียนใน `src/scanner/`, ไม่รันโปรแกรม | hash ก่อน/หลังทุก fixture; grep test ว่า scanner ไม่ import API เขียนไฟล์ |
| ความลับใน project (`.env`, credential ใน compose) | ผล scan ถูกอ่านโดย browser / ไฟล์ `data/scan.json` | `.env` เก็บแค่เลข port; compose เก็บแค่ชื่อ service / image / ports; `scan.json` อยู่ใน `data/` (ACL ของ F-001); API ผ่าน auth | fixture ที่มี secret → ไม่มีใน JSON / API |
| daemon (CPU / memory / disk) | tree ลึก / กว้างมาก, ไฟล์ใหญ่, compose bomb, ชื่อไฟล์ยาว, deps นับหมื่น | ขีดความลึก / folder / entry / byte / เวลา / deps; parser YAML ของ F-005 (node cap, ไม่มี alias bomb); งานเดียว | tree ใหญ่ → `truncated` ภายในเวลา; compose ใหญ่ → problem |
| terminal / dashboard ของผู้ใช้ | ชื่อ folder / ค่าใน `package.json` มี ANSI escape / control char | ข้ามชื่อที่มี control char; CLI sanitize (F-004); dashboard escape | ชื่อมี ESC / `\x9b` → ไม่ถึง terminal |
| การรันโค้ดของ project | scanner ไปโหลด `vite.config.ts` / `next.config.js` เพื่ออ่าน port | ไม่ execute / import ไฟล์ project เด็ดขาด — อ่านเป็น text + regex แบบจำกัด (ไม่มี backtracking ซ้อน) | config ที่มีโค้ดอันตราย → ไม่ถูกรัน |
| ผลที่ผิดชวนให้รัน | profile / compose ที่ออกแบบให้ detect เป็นอย่างอื่น | F-006 แค่เสนอ; การรันต้องผ่าน run approval (F-007) ที่แสดง argv จริง | — |
| state ของ scan | request ยกเลิก / เริ่มซ้อนจาก browser หลาย tab | single-flight, `409`, abort ไม่บันทึกผลครึ่ง ๆ; route ใช้ auth + CSRF ของ F-003 | 2 POST พร้อมกัน → 1 งาน |

Security checklist (WORKFLOW §8) ข้อที่เกี่ยว: input จากภายนอก (ไฟล์ project) validate + จำกัดขนาด; path traversal / link; ไม่มี secret ใน log / output; ไม่รัน shell; DoS (limits); output encoding (CLI sanitize).

## 7. คำถามถึงผู้ใช้ (ขั้น ②)
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|
| Q1 | ขอบเขต F-006 | (A) แกน: walk + profile + score + not-web + runner + monorepo + duplicate + port/via + publicDir + runtime hint; route prefix / DB / URL env / dev services / shared service แยกเป็น **F-006b** (ก่อน F-009) · (B) ทั้งหมดใน F-006 | A | A |
| Q2 | ความลึกในการเดิน | 3 · **4** · 6 · ไม่จำกัด (แค่ขีด folder / เวลา) | 4 (ตัวอย่างลึกสุดใน §9 = `craft-anything/apps/craft-anything-web` = 3) | 4 → **แก้ 2026-11-15**: ใช้ config `maxDepth` / `ignore` ที่ F-001 มีอยู่แล้ว (ค่าเริ่มต้น 3) — พบตอน W3 E1 ว่า spec ไม่ตรงระบบเดิม, ผู้ใช้เลือก "ใช้ config เดิม" |
| Q3 | เก็บผล scan | (A) `data/scan.json` ผลล่าสุด (แทนที่ทุกครั้ง) · (B) memory อย่างเดียว | A | A |
| Q4 | API / CLI | (A) งานเบื้องหลัง: `POST` เริ่ม / `GET` สถานะ+ผล / `DELETE` ยกเลิก; CLI รอ + ความคืบหน้า · (B) request เดียวรอจนจบ (จำกัด < 30 วิ) | A | A |
| Q5 | `.env*` | (A) อ่าน หา key `PORT` / `*_PORT` เก็บแค่เลข port ค่าอื่นทิ้งทันที · (B) ไม่อ่าน `.env` เลย (port จาก `.env` → ผู้ใช้ใส่เองใน F-007) | A | A |
| Q6 | compose + pyproject | (A) อ่าน compose ด้วย `yaml` (มีอยู่แล้ว) โดย**ยอม anchor / merge (`<<`)** แต่จำกัด alias ≤ 100 + node cap; `pyproject.toml` ด้วย parser จำกัดของเราเอง (ไม่เพิ่ม dependency) · (B) ไม่รับ anchor ใน compose (compose ที่ใช้ → problem) · (C) เพิ่ม dependency TOML | A | A |

## 8. Test plan
| # | กรณี | ประเภท |
|---|---|---|
| 1 | ทุก fixture เดิม (7) → profile / runner / port / publicDir ตามคาด; hash ก่อน/หลังเท่ากัน (Zero-touch) | fixture |
| 2 | fixture ใหม่: monorepo (frontend + backend), compose build (→ `compose`), compose mount + infra (→ `hybrid`), duplicate ซ้อน, not-web (extension, Unity, electron, Python script), `.env` PORT + secret | fixture |
| 3 | symlink / junction ชี้ออกนอก root → `skipped: link`, ไม่มีข้อมูลจาก target; folder ถูกสลับเป็น junction ระหว่างเดิน (inject) → `changed` | security |
| 4 | ขีดจำกัด: ความลึก, entry ต่อ folder, folder รวม, byte รวม, เวลา (นาฬิกาปลอม) → `truncated` + ผลบางส่วน | unit |
| 5 | ไฟล์ใหญ่ / compose bomb / deps 100k / ชื่อยาว / control char / ชื่อสงวน Windows | security |
| 6 | `.env` ที่มี `SECRET=...` → ไม่มีใน `scan.json` / API / CLI `--json` | security |
| 7 | API: 401 ไม่มี auth; POST ซ้อน → 409; DELETE ยกเลิก → ไม่บันทึก; GET ระหว่างรัน → ความคืบหน้า | integration |
| 8 | CLI: `webhub scan`, `--json`, `--last`, sanitize ESC / `\x9b`, exit code | integration |
| 9 | deps parser: `package.json` แปลก (ไม่ใช่ object, ค่าไม่ใช่ string), requirements (comment, `-r`, extras, markers), pyproject (PEP 621 + poetry) | unit |
| 10 | port parser: `vite.config` literal / ไม่ใช่ literal, compose `${VAR:-N}`, `EXPOSE`, script `--port N` / `-p N` | unit |
| 11 | Node 22.12 รันชุด scanner ผ่าน | regression |

## 9. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/F-006/test-1.md) 35/35 (+ ชุดเต็ม: เทสเดิมล่มเพราะโหลดเครื่อง — develop ล่มแบบเดียวกัน) | [review-1](../reports/F-006/review-1.md) FAIL 4 major | [security-1](../reports/F-006/security-1.md) FAIL 1 critical + 2 major | แก้ S1, C1/S3, C2/S2, C3, C4 |
| 2 | [test-2](../reports/F-006/test-2.md) 40/40 | [review-2](../reports/F-006/review-2.md) (code + security) FAIL 2 major (R1 regression, R2) + 3 minor | (รวมใน review-2) | แก้ R1 / R2 (round robin), minor ที่ผู้ใช้เลือก: C5 C6 C9 C11 C12 C13 C14 S4 S5 S6 C19; ที่เหลือ → PLAN follow-up |
| 3 | [test-3](../reports/F-006/test-3.md) 45/45, ชุดเต็ม 498/498 | [review-3](../reports/F-006/review-3.md) FAIL 1 major (Q1) + 3 minor | (รวม) | แก้ Q1; R3 R4 (ผู้ใช้เลือก), R5 → doc; Q2 Q3 Q4 (ผู้ใช้เลือกแก้ทั้ง 3) |
| 4 | [test-4](../reports/F-006/test-4.md) 49/49, ชุดเต็ม 502/502 | [review-4](../reports/F-006/review-4.md) FAIL 2 major (V1, V2) + 1 minor | (รวม) | แก้ V1, V2; V3 (ผู้ใช้เลือกแก้) |
| 5 | [test-5](../reports/F-006/test-5.md) 51/51 | [review-5](../reports/F-006/review-5.md) **PASS** (code + security) — 2 minor (W1, W2) | (รวม) | ผู้ใช้เลือกแก้ W1, W2 แล้ว merge |
| 6 | [test-6](../reports/F-006/test-6.md) 53/53 | [review-6](../reports/F-006/review-6.md) (diff W1/W2) | (รวม) | |

## 10. เอกสารที่อัปเดต (R4)
- [x] DESIGN.md §9, §12, §17  - [x] PLAN.md  - [x] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-15 | W1 ① | ร่าง spec |
| 2026-11-15 | W3 E1 | spec ไม่ตรงระบบ: config F-001 มี `maxDepth` (3) + `ignore` อยู่แล้ว → ผู้ใช้เลือก "ใช้ config เดิม" (Q2 แก้) |
| 2026-11-15 | W3 E2 | implement `src/scanner/*` (fsread, view, deps, compose, hints, scan, schema, routes), `webhub scan`, fixtures ×5 ใหม่ → `testing` |
| 2026-11-15 | W1 ②–④ | ผู้ใช้ตอบ Q1–Q6 ตามแนะนำ (แยก F-006b, ลึก 4, `data/scan.json` + งานเบื้องหลัง, `.env` เก็บแค่ port, compose anchor จำกัด + TOML parser เอง) → `planned` |
