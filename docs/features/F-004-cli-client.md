# F-004 — CLI client + `webhub daemon start|stop|status|logs`

| | |
|---|---|
| Status | `review` |
| Phase | MVP-1 (PLAN.md) |
| DESIGN.md | §13 CLI, §10.3 (auth), §12 (daemon) |
| Depends on | F-001 (home, lock, json-store), F-002 (process info / killTree), F-003 (daemon, `DaemonClient`) |
| Owner อนุมัติ | ผู้ใช้ / 2026-11-13 (Q1–Q6 ตามที่แนะนำ; อนุมัติ spec + "ทำเลย") |

## 1. เป้าหมาย / ขอบเขต
**ทำ (in scope)**
- โครง CLI ที่คำสั่งอื่น (F-005+) จะเสียบเพิ่ม: parse argv (`node:util` `parseArgs`, ไม่มี dependency ใหม่), ตาราง command, `--help` ต่อคำสั่ง, `--json`, exit code กลาง, แสดง error (`WebhubError` / `ServerError`) แบบเดียวกับ daemon (`message` + details + hint)
- `webhub daemon start` — spawn daemon แบบ detached, รอจนพร้อม, idempotent
- `webhub daemon stop [--force]` — `POST /api/v1/shutdown` แล้วรอจน process ออก
- `webhub daemon status [--json]` — running / not running + PID, port, version, uptime
- `webhub daemon logs [-n N] [-f]` — อ่านไฟล์ log ของ daemon ตรงจาก disk (ไม่ผ่าน API)
- helper `ensureDaemon()` สำหรับคำสั่งในอนาคตที่ต้องใช้ daemon (นโยบาย auto-start ตาม Q3)
- log ของ daemon จำกัดขนาดเป็น byte (ตาม Q1)

**ไม่ทำ (out of scope)**
- คำสั่งอื่นใน §13 (`scan`, `up`, `ports`, …) — แต่ละ feature เพิ่มเองบนโครงนี้
- `webhub ui` / เปิด login link ใน browser — ตาม Q2 (แนะนำย้ายไป F-009 พร้อมการตรวจ listener บน http port)
- autostart ตอน login Windows (MVP-6, `webhub autostart`)
- `logs <site> -f` ของ site (route แบบ stream) — feature ของ runner; ข้อกำหนด keep-alive byte ย้ายไปแถวนั้น (ดู §5)

## 2. ระบบเดิมรองรับยังไง (R2)
- F-003: `connectDaemon(paths)` → `DaemonClient` (proof ก่อนส่ง token, reload auth.json เมื่อ daemon restart), `exitCodeFor`, `ServerError` (`DAEMON_NOT_RUNNING`, `DAEMON_IMPOSTOR`, `DAEMON_UNREACHABLE`, `API_ERROR`), route `status` / `shutdown`, `main()` ใน `dist/daemon.js`
- F-001: `resolvePaths` / `ensureHome` (`logs/` อยู่ใต้ home ที่ ACL เฉพาะ user), lock file (`pid` + `startedAt` ของ process)
- F-002: `process.info(pid)`, `process.killTree(pid, expectStartedAt)` (ฆ่าเฉพาะเมื่อ start time ตรง — กัน PID reuse)
- F-000: `src/cli.ts` เป็น stub (`--version`, `--help`) — F-004 ขยายไฟล์นี้; พฤติกรรมเดิมคงไว้ (เทสเดิมต้องผ่าน)
- DESIGN §13 ไม่มี `webhub daemon …` → เพิ่มบรรทัด + §17 Review log

## 3. Design

### 3.1 Interface (CLI)
```
webhub daemon start  [--json]          # 0 = started หรือรันอยู่แล้ว
webhub daemon stop   [--force] [--json]# 0 = stopped หรือไม่ได้รันอยู่
webhub daemon status [--json]          # 0 = running, 3 = not running
webhub daemon logs   [-n N] [-f]       # N default 50, max 10000
webhub --help | --version | <cmd> --help
```

`--json` พิมพ์ JSON บรรทัดเดียวลง stdout (เช่น `{"running":true,"pid":1234,"port":7400,"version":"0.1.0","startedAt":"…"}`); error → stderr เป็น `{"error":{"code":"…","message":"…","details":[…],"hint":"…"}}` (`details` / `hint` มีเมื่อมีค่า; `message` ไม่มี prefix `webhub: `); `webhub --json daemon` (ไม่มีคำสั่งย่อย) → JSON error `USAGE` exit 2

เปลี่ยนจาก F-000: option ระดับบนที่ไม่รู้จักทำให้ exit 1 เสมอ แม้มี `--version` ด้วย (`webhub --version --bogus` เดิม exit 0 → ตอนนี้ 1 — parse ทั้งชุดก่อน); `webhub logs -f | head`: ผู้อ่านปิด pipe → จบเงียบ (ไม่มี stack EPIPE)

**Exit code (ทุกคำสั่ง)**
| code | ความหมาย |
|---|---|
| 0 | สำเร็จ |
| 1 | error อื่น (รวม `DAEMON_IMPOSTOR`, `DAEMON_UNREACHABLE`, timeout) และ**คำสั่ง / option ระดับบนที่ไม่รู้จัก** (คงพฤติกรรม F-000) |
| 2 | ใช้คำสั่งย่อย / option ของคำสั่งผิด, config / home ผิด (`CONFIG_INVALID`, `JSON_PARSE`, `HOME_INVALID`, …); `webhub daemon` เฉยๆ = แสดง usage + 2 |
| 3 | daemon ไม่ได้รัน (`status`, และคำสั่งที่ต้องใช้ daemon เมื่อ auto-start ปิด) |
| 4 | port ของ API ไม่ว่าง (`DAEMON_PORT_BUSY`) |

### 3.2 Interface (TypeScript, `src/cli/`)
```ts
// src/cli.ts — parse global options (--json, --no-start, --help, --version) + dispatch
interface Io { out(line: string): void; err(line: string): void }   // เดิม
interface RunOptions { env?: NodeJS.ProcessEnv; signal?: AbortSignal; onFollow?: () => void }
interface CommandContext { io; env; json; noStart; signal; following(): void; paths(): Paths }  // paths lazy: --help ไม่ต้องมี home
export function run(argv: readonly string[], io: Io, opts?: RunOptions): Promise<number>;  // เดิม sync → async

// src/cli/daemon-control.ts
interface ControlOptions { env?; platform?; daemonJs?: string; timeoutMs?: number }
export function daemonStatus(paths: Paths): Promise<DaemonStatus | undefined>;   // proven (handshake); undefined = ไม่รัน
export function startDaemonProcess(paths, opts?): Promise<{ pid; port; alreadyRunning }>;
export function stopDaemon(paths, opts?: ControlOptions & { force?: boolean }): Promise<{ wasRunning; forced }>;
export function ensureDaemon(paths, opts?: ControlOptions & { noStart?: boolean; onStart?: () => void }): Promise<DaemonClient>;
export function spawnPlan(...) / daemonEnv(env)   // ตัวเลือก spawn (export ให้ test)

// src/cli/daemon-logs.ts — tailLogs(paths, n), followLogs(paths, out, signal)
// src/cli/output.ts — EXIT, CliError, exitCodeOf, errorLines, sanitize
```
Ctrl+C: ออกทันที (exit 130) ยกเว้นระหว่าง `logs -f` — ครั้งแรกจบ follow แบบปกติ, ครั้งที่สองออกทันที. Ctrl+C ระหว่าง `start`: daemon (detached) เริ่มต่อไป; ไฟล์ stderr ชั่วคราว rename เป็น `daemon.err` ทันที (ไม่ทิ้งไฟล์ temp)
`run()` เปลี่ยนเป็น async — test เดิม (`cli.test.ts`) ปรับเป็น `await` (behavior เท่าเดิม)

### 3.3 `daemon start` flow
1. `ensureHome(paths)` (F-001) — home ผิด → exit 2
2. มี daemon อยู่แล้ว? `connectDaemon` + `status()` สำเร็จ → พิมพ์ "already running (PID x)" → exit 0
3. หา `dist/daemon.js` จาก `import.meta.url` ของ CLI เอง (ไม่ใช้ PATH / cwd)
4. `spawn(process.execPath, [daemonJs, ...logArgs], { detached: true, windowsHide: true, cwd: paths.home, stdio: ["ignore", "ignore", errFd], env })`
   - `env` = env ของผู้ใช้ **ตัดตัวแปรที่ node / libuv / OpenSSL อ่านตอนเริ่ม** (`NODE_*` ยกเว้น `NODE_ENV`, `OPENSSL_*`, `SSL_CERT_*`, `UV_*`, `ICU_*` — ไม่สนตัวพิมพ์; ชื่อที่มีอักษรนอก ASCII ตัดด้วย เพราะ Windows อาจ map เป็นชื่อเหล่านี้) และไม่ส่ง `execArgv` ของ CLI — กัน `--inspect` / `--require` / `OPENSSL_CONF` (โหลด DLL) ติดไปที่ process ที่ถือ token และกัน `NODE_DEBUG` เขียน stderr ทุก connection (security-1 D1)
   - `errFd` = ไฟล์ใหม่ `logs/daemon-start-<สุ่ม>.err` เปิดแบบ `wx` (สร้างใหม่เท่านั้น: ไม่ตาม/ทับ link ที่วางไว้; start พร้อมกันไม่ชนไฟล์กัน) — **ไม่มี pipe** (Y2). start สำเร็จ → rename เป็น `logs/daemon.err`; ไม่สำเร็จ → อ่านแล้วลบ; ไฟล์ค้างจาก CLI ที่ตายกลางทาง (> 1 ชม.) ลบตอน start ครั้งถัดไป
   - ขนาด `daemon.err`: daemon ไม่เขียน stderr ระหว่างทำงานปกติ (log ทั้งหมดไป `--log-file` ที่มี cap) — stderr มีแค่ error ตอน start, ชื่อ class ตอน crash และ warning ของ Node ครั้งเดียว; ตัวที่ทำให้เขียนต่อเนื่อง (`NODE_DEBUG`) ถูกตัดจาก env แล้ว → ไม่มีทางให้ request จากภายนอกทำให้โต. ไม่มี byte cap ของไฟล์นี้เอง (ต้องแก้ F-003 ให้ส่ง stderr ผ่าน writer ที่มี cap — ไม่คุ้มเมื่อไม่มีผู้เขียนที่ไม่จำกัดเหลือ; ทบทวนถ้า daemon เริ่มเขียน stderr)
   - `cwd` = home → daemon ไม่ถือ folder ที่ผู้ใช้อยู่ (Windows ลบ folder ไม่ได้)
   - `child.unref()`; จด `startedAt` ของ child จาก `process.info(pid)` ทันที (ใช้ kill ตอนไม่สำเร็จ)
5. poll ทุก 100 ms สูงสุด 20 วิ:
   - child `exit` ก่อนพร้อม → code 3 = มีอีกตัวชนะ lock (start พร้อมกัน) → รอตัวนั้นพร้อม → "already running"; ไม่พร้อมใน timeout → exit 1 พร้อม stderr ของ child + hint `stop --force`. code อื่น → อ่านไฟล์ stderr ชั่วคราว (≤ 4 KB, sanitize) แยกเป็น message / details (`  - …`) / hint (`  hint: …`) ตามรูปแบบ `describe()` ของ daemon แสดง + exit ตาม code ของ daemon (2/4/1)
   - status ที่ผ่าน proof มี **`pid === child.pid`** (H16 — pid มาจาก daemon ที่พิสูจน์แล้ว) → พิมพ์ "started (PID x, port y)" → exit 0
   - error ระหว่าง poll: เฉพาะ `DAEMON_NOT_RUNNING` / `DAEMON_IMPOSTOR` / `DAEMON_UNREACHABLE` = "ยังไม่พร้อม"; อื่นๆ (home / ACL / config) → หยุดทันทีและแสดง error นั้น
6. ไม่สำเร็จ (timeout หรือ error) และ child ยังไม่ออก → `killTree(child.pid, startedAt)` (อ่าน start time ใหม่ถ้ารอบแรกอ่านไม่ได้); ยังอ่านไม่ได้ → `child.kill()` ผ่าน handle ของ child เอง (ไม่โดน PID ที่ถูกใช้ซ้ำ) → exit 1 "did not become ready in 20 s" + stderr ของ child เป็น details

### 3.4 `daemon stop` flow
1. `connectDaemon` + `status` → ไม่มี auth.json / port ปฏิเสธ → "not running" → exit 0
2. proof ไม่ผ่าน (`DAEMON_IMPOSTOR`) หรือไม่ตอบ (`DAEMON_UNREACHABLE`) → ดูว่า PID ใน auth.json เป็นใคร:
   - auth.json กับ lock file ชี้ PID เดียวกัน และ PID นั้นยังมี start time ตรงกับ lock → daemon ของเราที่ค้าง / กำลังปิด (ระหว่างปิดตอบ 503; `stop` อีกตัวสั่งไปแล้ว) → ข้ามไปรอข้อ 4
   - ไม่มี auth.json หรือ PID ตาย / start time ไม่ตรง (daemon ออกไปแล้ว) → ถาม status อีกครั้ง: ไม่รัน / ไม่ตอบ → "stopped" exit 0 (ลบ auth.json ค้างถ้ายังชี้ PID นั้น); มี daemon ใหม่ตอบ → stop ตัวนั้น; ยังไม่ผ่าน proof → โปรแกรมอื่นบน port
   - อ่าน process table ไม่ได้ / lock กับ auth.json ไม่ตรงกัน → ไม่ถือว่าเป็นของเรา
   - โปรแกรมอื่นบน port → ไม่ส่ง token, ไม่ kill อะไร (แม้มี `--force`), exit 1 ทันที (ไม่รอ 10 วิ) + แสดง PID/ชื่อ process ที่ listen (F-002 `ports.listening`)
3. ตอบปกติ → `POST /api/v1/shutdown` (bearer หลัง proof) → 202; connection ปิดกลางทาง / proof ไม่ผ่าน (เริ่มปิดแล้ว → 503) / ไม่รันแล้ว → ไปรอข้อ 4 เหมือนกัน (ทำให้ `stop` หลายตัวพร้อมกัน exit 0 ทุกตัว)
4. รอจน PID ตาย (`process.info`; start time ไม่ตรง lock = PID ถูกใช้ซ้ำ = daemon ออกแล้ว; อ่าน process table ไม่ได้ = ไม่รู้ → รอต่อ ไม่ถือว่าตาย), poll 100 ms สูงสุด 10 วิ (daemon เอง force exit ที่ ~7 วิ) → ลบ auth.json ค้าง (daemon ที่ถูก kill แรงๆ ไม่ได้ลบ) **เฉพาะเมื่อยังชี้ PID นั้น**
5. ไม่ออกใน 10 วิ: ไม่มี `--force` → exit 1 + hint `webhub daemon stop --force`; มี `--force` → PID ต้องตรงกับ lock file → `killTree(pid, lock.startedAt)` (F-002 ตรวจ start time ซ้ำก่อน kill) → ลบ auth.json เฉพาะเมื่อยังชี้ PID ที่ kill (ไม่ลบของ daemon ใหม่ที่เพิ่ง start); start time ไม่ตรง / lock ไม่ตรง → ไม่ kill, exit 1 (`DAEMON_FORCE_REFUSED`); kill ไม่สำเร็จ (access denied ฯลฯ) → exit 1 (`DAEMON_KILL_FAILED`) + details

### 3.5 `daemon status`
- `connectDaemon` + `status()` → `running` + pid/port/version/startedAt/uptime → exit 0; รูปร่างของ status ตรวจก่อนใช้ (pid เป็น int บวก, string ผ่าน `sanitize` ทั้งข้อความและ `--json`) — `DAEMON_BAD_STATUS` ถ้าไม่ตรง
- `DAEMON_NOT_RUNNING` → "not running" → exit 3
- `DAEMON_IMPOSTOR` → "port 7400 is used by another program (PID x name)" → exit 1

### 3.6 Log ของ daemon (ตาม Q1, แนะนำ A)
- ไฟล์ `logs/daemon.log` (JSON lines เดิมของ F-003) + `logs/daemon.log.1`
- daemon เขียนเอง ผ่าน `--log-file <path>` ของ `dist/daemon.js` (**ต้องเปิด CR-003 กับ F-003** — เพิ่ม option, ไม่เปลี่ยนพฤติกรรมเดิมเมื่อไม่ส่ง): ก่อนเขียนบรรทัดที่ทำให้ไฟล์เกิน 5 MB → rename เป็น `.1` (ทับของเก่า) แล้วเปิดไฟล์ใหม่ → รวมไม่เกิน ~10 MB; เขียนแบบ append fd; เขียนพลาด (disk เต็ม) → ทิ้งบรรทัด ไม่ล้ม
- path ต้องอยู่ใน `logs/` ของ home (`assertSafePath`), ไม่ตาม symlink (F-001)
- `daemon logs`: อ่านย้อนจากท้ายไฟล์ปัจจุบันทีละ 64 KB จนได้ N บรรทัด (ไม่พอ → ต่อจากท้าย `.1`), อ่านไม่เกิน 8 MB ต่อไฟล์ (`.1` เก่าที่ใหญ่เกินไม่ถูกอ่านทั้งไฟล์; บรรทัดที่ถูกตัดที่ขอบไม่แสดง); `-f` = poll ไฟล์ทุก 500 ms (อ่านพลาดชั่วคราว เช่น antivirus ถือไฟล์ → ข้ามรอบนั้น ไม่จบ): file id (ino) เปลี่ยน = rotate → อ่านส่วนที่เหลือของ `.1` ก่อนแล้วเริ่มไฟล์ใหม่; size ลด = truncate → เริ่มที่ 0; ตัวอักษรหลาย byte ที่ถูกตัดระหว่างสองรอบอ่านไม่เพี้ยน (`StringDecoder`) — ข้อจำกัด: truncate แล้วเขียนกลับจนขนาด ≥ ตำแหน่งเดิมภายใน 500 ms ตรวจไม่เจอ (บรรทัดช่วงนั้นหาย — เกิดเฉพาะตอน rename ไม่ได้); ไม่ผ่าน daemon → ไม่มี route stream ใน F-004; ทุกบรรทัดผ่าน `sanitize` (path ใน log มาจาก client ภายนอก → กัน terminal escape injection)
- `sanitize`: แทนด้วย `?` — C0 (ยกเว้น tab), DEL, C1 (รวม CSI 8-bit 0x9b), U+2028/2029, bidi U+202A–202E / U+2066–2069, bidi mark U+061C / U+200E / U+200F, zero-width U+200B / U+FEFF (ZWNJ / ZWJ คงไว้ — ใช้ในภาษา / emoji); ใช้กับทุกข้อความจาก daemon, log, error และ argument ที่ echo กลับ

### 3.7 `ensureDaemon()` (ตาม Q3, แนะนำ auto-start)
- daemon ไม่รัน → พิมพ์ "starting daemon…" ลง stderr → `startDaemonProcess` → คืน client
- `--no-start` (global flag) หรือ env `WEBHUB_NO_AUTOSTART=1` → exit 3 "daemon is not running; run `webhub daemon start`"

### 3.8 Platform
- Windows: `detached` + `windowsHide` (ไม่มี console window; daemon ไม่ได้ SIGHUP เมื่อปิด terminal ของผู้ใช้)
- Linux/macOS (phase 13): `detached` = `setsid` → ทำงานเหมือนกัน; ยังไม่ประกาศรองรับ

## 4. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | CLI บางจริง (ทุกอย่างผ่าน daemon ยกเว้นอ่าน log ไฟล์); start idempotent → ใช้ใน script ได้; ไม่มี pipe → daemon ไม่ค้างเพราะ CLI; log จำกัดขนาด → flood (residual ของ F-003) ไม่กิน disk; ไม่มี dependency ใหม่ |
| ผลเสีย | cap ต้องแก้ F-003 (CR-003, งานเพิ่ม); log rotate แบบ 2 ไฟล์ = ข้อมูลเก่าหาย; `logs -f` แบบ poll มี delay ≤ 500 ms; `run()` เป็น async (เทส F-000 ปรับ) |
| ทางเลือกที่ไม่เลือก | **B** CLI rotate ตอน start เท่านั้น + stdout ไปไฟล์ — ระหว่างรันโตไม่จำกัด (ไม่ผ่านข้อกำหนด Y1/U4); **C** process แยก (log pump) อ่าน pipe แล้วเขียนไฟล์ — ซับซ้อน, pump ค้าง = daemon ค้าง (Y2 เดิม); **D** entry ใหม่ `daemon-bg.js` เรียก `startDaemon({log})` — ต้องลอก signal/crash handling ของ `main()` (โค้ดซ้ำ, ความปลอดภัยแยกกัน 2 ที่); parser lib (commander/yargs) — dependency + supply chain, `parseArgs` พอ |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done แล้ว | ใช่ | F-000 `cli.ts` stub → ขยาย (behavior เดิมคงที่, `run` async); F-003 → **CR-003** เพิ่ม `--log-file` (ตาม Q1) |
| Zero-touch | ไม่ | เขียนแค่ใน `$WEBHUB_HOME/logs` |
| Security | ใช่ | ดู §6 |
| Performance / resource | น้อย | log ≤ ~10 MB; poll 100 ms ช่วง start/stop เท่านั้น |
| Config / data เดิม | ไม่ | ไม่มี schema ใหม่ |
| PLAN | ใช่ | ข้อกำหนด "ตรวจทุก listener ก่อนเปิด link" + "login URL ไม่ผ่าน argv" → F-009 (ถ้า Q2 = ย้าย); "route stream ส่ง keep-alive byte" → feature `logs <site> -f` (runner) |

## 6. Threat model (R6)
| Asset | ผู้โจมตี / ช่องทาง | ป้องกันด้วย | เทส |
|---|---|---|---|
| token | argv / env ของ daemon ที่ process อื่นอ่านได้ | ไม่ส่ง token ใดๆ ให้ daemon (daemon สุ่มเอง); CLI อ่านจาก auth.json (ACL) | spawn args/env ไม่มี token |
| token | โปรแกรมปลอมบน 7400 | `DaemonClient` proof ก่อนส่ง token (F-003) | impostor → exit 1, server ปลอมไม่ได้รับ `authorization` |
| process ที่ถือ token | `NODE_OPTIONS=--inspect` / `--require` / `OPENSSL_CONF` / `NODE_PATH` / `execArgv` ของ CLI ติดไป daemon → debugger port / code / DLL แปลกปลอม | ตัด `NODE_*` (ยกเว้น `NODE_ENV`), `OPENSSL_*`, `SSL_CERT_*`, `UV_*`, `ICU_*`, ชื่อนอก ASCII; ไม่ส่ง execArgv; path ของ daemon จาก `import.meta.url` | env ของ child ไม่มีตัวแปรเหล่านี้ (unit + child จริง) |
| disk | `NODE_DEBUG` ใน env ผู้ใช้ + เว็บใดก็ได้ยิง request มาที่ 7400 → daemon เขียน debug ลง stderr ทุก connection → `daemon.err` โตไม่จำกัด (security-1 D1) | ตัด `NODE_*` จาก env ของ daemon; daemon ไม่เขียน stderr ระหว่างทำงานปกติ | child จริงไม่เห็น `NODE_DEBUG` |
| daemon availability | CLI ถือ pipe แล้วหยุดอ่าน (Y2) | stdio = `ignore` / file fd เท่านั้น | spawn options ไม่มี `pipe`; CLI ออกแล้ว daemon ยังตอบ |
| process อื่นของผู้ใช้ | `stop --force` / timeout kill ผิดตัว (PID reuse), หรือ kill ตามข้อมูลของโปรแกรมปลอมบน port | `killTree(pid, lock.startedAt)` + PID ต้องตรง lock + auth.json; ไม่มีการ kill จากข้อมูลของโปรแกรมที่ไม่ผ่าน proof; start timeout ที่อ่าน start time ไม่ได้ → kill ผ่าน handle ของ child | unit (mock platform): startedAt ไม่ตรง / lock ไม่ตรง / table อ่านไม่ได้ / impostor → `killTree` ไม่ถูกเรียก; `--force` เรียกด้วย (pid, lock.startedAt) เท่านั้น |
| daemon ใหม่ | `--force` / stop ลบ auth.json ของ daemon ที่เพิ่ง start | ลบเฉพาะเมื่อ auth.json ยังชี้ PID ที่หยุด | unit: auth.json ใหม่ยังอยู่ |
| disk | flood request → log โตไม่จำกัด (U4/Y1) | cap 5 MB × 2 (Q1) | เขียนเกิน cap → ไฟล์ ≤ 5 MB + `.1` |
| terminal ผู้ใช้ | path ใน log มี ESC sequence (มาจาก request ภายนอก) | `sanitize` ตัด C0/C1 (ยกเว้น `\t`) ก่อนพิมพ์ | log ที่มี `\x1b]…` → พิมพ์ไม่มี ESC |
| log file | user อื่นอ่าน log | อยู่ใน home (ACL user เดียว — F-001), `--log-file` ต้องอยู่ใน `logs/` | path นอก `logs/` / symlink → ปฏิเสธ |
| start ซ้อน | `daemon start` 2 ตัวพร้อมกัน | lock ของ F-001 → ตัวแพ้ exit 3 → CLI ตัวนั้นรายงาน "already running" | 2 start พร้อมกัน → daemon 1 ตัว, CLI ทั้งคู่ exit 0 |

Security checklist (WORKFLOW §8): secrets ไม่อยู่ใน argv/log/error ✓, input validation (`-n` int 1–10000, path) ✓, ไม่รันคำสั่งผ่าน shell ✓ (`spawn` ไม่มี `shell`), ไฟล์ใน home เท่านั้น ✓, dependency ใหม่ ไม่มี ✓

## 7. คำถามถึงผู้ใช้ (ขั้น ②)
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|
| Q1 | จำกัดขนาด log ยังไง | A CR-003: daemon รับ `--log-file` เขียน+rotate เอง / B CLI rotate ตอน start เท่านั้น / C process log pump | **A** | **A** → CR-003 |
| Q2 | `webhub ui` (เปิด login link) | ย้ายไป F-009 พร้อมตรวจ listener / ทำใน F-004 (ตอนนี้ได้ 503 เสมอ) | **ย้ายไป F-009** | ย้ายไป F-009 |
| Q3 | คำสั่งที่ต้องใช้ daemon ทำไงเมื่อ daemon ไม่รัน | auto-start (+ `--no-start`) / บอกให้รัน `daemon start` เอง | **auto-start** | auto-start |
| Q4 | `daemon stop --force` | มี (kill เมื่อ PID + start time ตรง) / ไม่มี | **มี** | มี |
| Q5 | ขนาด log | 5 MB × 2 / 1 MB × 3 / 20 MB × 2 | **5 MB × 2** | 5 MB × 2 |
| Q6 | `daemon logs` | มี (`-n`, `-f` อ่านไฟล์ตรง) / ไม่มี (เปิดไฟล์เอง) | **มี** | มี |

## 8. Test plan
| # | กรณี | ประเภท |
|---|---|---|
| 1 | `--help`, `--version`, unknown → exit 1 (เทส F-000 เดิม) + `daemon --help` | unit |
| 2 | arg ผิด (`-n 0`, `-n abc`, flag แปลก) → exit 2 | unit |
| 3 | `start` → `status` running (pid = auth.pid) → `stop` → `status` exit 3; auth.json หาย | integration |
| 4 | `start` ซ้ำ → exit 0 "already running", daemon ตัวเดิม | integration |
| 5 | `start` ×2 พร้อมกัน → daemon 1 ตัว, ทั้งคู่ exit 0 | integration |
| 6 | port 7400 ไม่ว่าง (server อื่น) → `start` exit 4 + ข้อความ PID | integration |
| 7 | impostor บน port + auth.json เก่า → `status`/`stop` exit 1, server ปลอมไม่เห็น `authorization` | integration/security |
| 8 | daemon ไม่พร้อมใน timeout (fixture preload ค้าง) → kill + exit 1, ไม่มี process ค้าง | integration |
| 9 | stop ค้าง (fixture `hang-close-daemon.mjs`) → ไม่มี `--force` exit 1; `--force` → process ออก | integration |
| 10 | `--force` เมื่อ startedAt ไม่ตรง → ไม่ kill; impostor / lock ไม่ตรง / table อ่านไม่ได้ → ไม่ kill; daemon กำลังปิด (503) → รอ; auth.json ของ daemon ใหม่ไม่ถูกลบ | unit (mock platform) |
| 10a | `stop` ×4 พร้อมกัน → ทุกตัว exit 0 | integration |
| 10b | env ของ child ไม่มี `NODE_DEBUG` / `OPENSSL_CONF` / … | unit + integration |
| 11 | spawn: env ไม่มี `NODE_OPTIONS`, stdio ไม่มี `pipe`, cwd = home, args ไม่มี token | unit |
| 12 | CLI ออกแล้ว daemon ยังตอบ (ไม่มี parent ถือ pipe) | integration |
| 13 | log cap: เขียน > 5 MB → rotate, ≤ 5 MB + `.1`; ไม่มี `--log-file` → stdout เหมือนเดิม (CR-003) | unit + regression F-003 |
| 14 | `--log-file` นอก `logs/` / symlink → daemon exit 2 | security |
| 15 | `daemon logs -n 5` ข้าม rotate; `-f` เห็นบรรทัดใหม่ + หลัง rotate | integration |
| 16 | `sanitize`: ESC/CSI/OSC/C1 ถูกตัด, ไทย/emoji คงอยู่ | unit/security |
| 17 | `ensureDaemon`: auto-start; `--no-start` → exit 3 | integration |
| 18 | `--json` ทุกคำสั่ง parse ได้, error JSON ไป stderr | unit |
| 19 | Node 22.12 รัน suite F-004 | compat |

## 9. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/F-004/test-1.md) 346/6 | [review-1](../reports/F-004/review-1.md) FAIL (C1, C2 major) | [security-1](../reports/F-004/security-1.md) FAIL (D1 critical) | แก้ทั้งหมด (ผู้ใช้เลือก "แก้ทั้งหมด") |

## 10. เอกสารที่อัปเดต (R4)
- [x] DESIGN.md §13 (+ `webhub daemon …`), §17  - [x] PLAN.md (status)  - [x] features/README.md (status)  - [ ] reports/README.md (ตอน done)  - [x] CR-003 (Q1 = A, done)

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-13 | W1 ① | ร่าง spec |
| 2026-11-13 | W1 ② | ผู้ใช้ตอบ Q1–Q6 ตามที่แนะนำทั้งหมด (Q1 = A → CR-003) |
| 2026-11-13 | W1 ③④⑤ | อนุมัติ spec + CR-003, เข้า Plan queue `planned` (CR-003 ก่อน), "ทำเลย" → W3 |
| 2026-11-13 | W3 | implement + test-1 → `review`; review-1 FAIL (C1, C2), security-1 FAIL (D1) |
| 2026-11-14 | W3 | ผู้ใช้เลือก "แก้ทั้งหมด": env denylist, stop idempotent + ไม่ใช่ของเรา = impostor, kill fallback, start errors, tail อ่านท้ายไฟล์, JSON error, sanitize bidi mark, Ctrl+C / EPIPE; เทส mock platform + stop พร้อมกัน |
