# F-002 — Platform layer (Windows): ports, process, elevate, notify

| | |
|---|---|
| Status | `in-progress` |
| Phase | MVP-1 (PLAN.md) |
| DESIGN.md | §21.1 (Platform layer), §2 (daemon), §15 (ports), §20 (security) |
| Depends on | F-000, F-001 (`execFile`, `powershell`, `systemExe`, `processState`, `WebhubError`) |
| Owner อนุมัติ | ผู้ใช้ / 2026-11-07 |

## 1. เป้าหมาย / ขอบเขต
- in scope — interface `Platform` (DESIGN §21.1) ส่วนที่ MVP-0/1 ต้องใช้ + implementation Windows:
  - `ports`: ใครฟัง port ไหน (`listening`), ช่วงที่ Windows กันไว้ (`reserved`), bind ได้จริงไหม (`canBind`), หา port ว่างในช่วง (`findFree`)
  - `process`: ข้อมูล process (`info`: ชื่อ, exe, start time, parent), ฆ่าทั้ง tree (`killTree`), CPU/RAM (`usage`)
  - `elevate(task)`: ทำงานที่ต้องสิทธิ์ admin ผ่าน UAC แบบ **allowlist ของงาน** ไม่ใช่รันคำสั่งอิสระ
  - `notify(title, body)`: toast Windows
  - `capabilities()`: `resolvesLocalhostSubdomains`, `dockerTopology` (คืนค่าคงที่ตาม DESIGN, ยังไม่ตรวจ Docker จริง)
- out of scope (feature อื่น):
  - `hosts.writeBlock` (งาน elevate ตัวแรกที่ใช้จริง) → feature hosts sync (MVP-2); F-002 วางกลไก elevate + task kind `noop` สำหรับทดสอบ
  - `autostart`, `tray` → MVP-6
  - macOS/Linux → phase 13 (มีแค่ stub ที่ throw `PLATFORM_UNSUPPORTED`)

## 2. ระบบเดิมรองรับยังไง (R2)
- F-001 มีของที่ใช้ต่อ: `execFile` (ไม่มี shell, stdin), `powershell` (-EncodedCommand), `systemExe` (path เต็ม), `processState` (CIM start time)
- **ไม่ย้าย** ของจาก F-001 เข้า `src/platform/` (F-001 done แล้ว → ย้าย = ต้อง CR). Platform เรียกใช้ของ F-001 ตรงๆ
- DESIGN §21.1 ต้องเพิ่ม: รายละเอียด elevate (allowlist + กลไก), `findFree`, ข้อจำกัด toast

## 3. Design
```ts
// src/platform/types.ts
interface PortOwner { port: number; address: string; pid: number; family: 4 | 6 }
interface PortRange { start: number; end: number; administered: boolean }
interface ProcInfo { pid: number; name: string; exe?: string; startedAt?: string; parentPid?: number }
interface Usage { cpuSeconds: number; workingSetBytes: number }
type ElevatedTask = { kind: "noop" }            // MVP-2 เพิ่ม { kind: "hosts.writeBlock"; entries: HostEntry[] }

interface Platform {
  readonly name: "win32" | "darwin" | "linux";
  ports: {
    listening(opts?: { fresh?: boolean }): Promise<PortOwner[]>;
    reserved(): Promise<PortRange[]>;
    canBind(port: number): Promise<boolean>;
    findFree(range: [number, number], avoid?: ReadonlySet<number>): Promise<number>;
  };
  process: {
    info(pid: number): Promise<ProcInfo | undefined>;
    killTree(pid: number, expectStartedAt: string): Promise<void>;
    usage(pids: readonly number[]): Promise<Map<number, Usage>>;
  };
  elevate(task: unknown): Promise<void>;          // validate เอง (allowlist) ก่อน UAC
  notify(title: string, body: string): Promise<boolean>;  // ไม่ throw
  capabilities(): { resolvesLocalhostSubdomains: boolean; dockerTopology: "host-gateway" | "host-network" };
}
getPlatform(): Platform   // เลือกตาม process.platform; ไม่ใช่ win32 → stub ที่ throw PLATFORM_UNSUPPORTED
```

### 3.1 ports (Windows)
- `listening()`: CIM `MSFT_NetTCPConnection` `State=2` (Listen) → `{LocalAddress, LocalPort, OwningProcess}` เป็น JSON (~0.4 วิ, **ไม่ขึ้นกับภาษา Windows** — `netstat` แปลคำว่า LISTENING ตามภาษา). cache 2 วิ
- `reserved()`: `netsh int ipv4 show excludedportrange protocol=tcp` + ipv6 → parse เฉพาะบรรทัดที่เป็นตัวเลข 2 ตัว (`*` = administered) — ตัวเลขไม่ขึ้นกับภาษา
- `listening({fresh})`: cache 2 วิ (ข้ามได้ด้วย `fresh`), คืน copy (caller แก้ cache ไม่ได้), เรียกพร้อมกันใช้ query เดียว
- `canBind(port)`: true เฉพาะเมื่อ (1) `listening({fresh:true})` ไม่มีใครฟัง port นี้ที่ address ไหนเลย และ (2) bind ได้ทั้ง `127.0.0.1` และ `::1` (ไม่มี IPv6 stack → ข้าม). review-1 C1: บน Windows listener ที่ `0.0.0.0` / `::` / `::1` ไม่ทำให้ bind `127.0.0.1` ล้ม → ต้องเช็ค listening ด้วย. ไม่ bind `0.0.0.0` เพราะเด้ง Windows Firewall prompt (ตัด param `host` ออก)
- `findFree(range, avoid)`: ตัด reserved + listening (fresh) + avoid → ลอง bind loopback ทีละตัวจากต้นช่วง; ไม่เหลือ → `PORT_EXHAUSTED` (บอกช่วงที่หมด)
- ไม่ฆ่า/ไม่แตะ process ที่ถือ port อยู่ (แค่รายงาน)

### 3.2 process (Windows)
- `info(pid)`: CIM `Win32_Process` (Name, ExecutablePath, CreationDate, ParentProcessId); ไม่มี → `undefined`
- `killTree(pid, expectStartedAt)`: **ต้องส่ง start time ที่จำไว้ตอน spawn** (caller เอาจาก record ของ webhub เท่านั้น ไม่ใช่จาก `info()` ของ PID ใดๆ — S6) → อ่านตาราง process ทั้งหมด (CIM 1 ครั้ง) → root ไม่มี = สำเร็จ; start time อ่านไม่ได้ = `PLATFORM_TOOL` (C7); ไม่ตรง = ไม่ฆ่า + `PROCESS_MISMATCH` → หา descendant เอง โดยนับเฉพาะลูกที่เกิด**หลัง**พ่อ (กัน ParentProcessId ที่ชี้ PID reuse — S5) → `taskkill.exe /F /PID a /PID b …` (ไม่ใช้ `/T`) → รอจนตายทั้ง tree ภายใน **5 วิ (deadline จริง — C2)**; taskkill ล้ม + root ยังอยู่ = ล้มทันที `PROCESS_KILL_FAILED`
- format start time = UTC ISO `'o'` เหมือน F-001 `processState` (test ยืนยันตรงกัน)
- `usage(pids)`: CIM `Win32_PerfFormattedData_PerfProc_Process` ไม่แม่น/ช้า → ใช้ `Win32_Process` (KernelModeTime + UserModeTime, WorkingSetSize) batch เดียว
- ทุก PID ผ่าน `Number.isInteger` ก่อนเข้า script (เหมือน F-001)

### 3.3 elevate (Windows)
- งานที่ยกสิทธิ์ได้ = **allowlist ของ `kind`** ที่ define ในโค้ด webhub เท่านั้น; ไม่มี "รันคำสั่งนี้แบบ admin"
- กลไก (ตาม Q2): `ProcessStartInfo{Verb=runas, UseShellExecute}` (PowerShell, script คงที่, ข้อมูลทาง stdin) เรียก `node <dist>/platform/elevated.mjs <token>` → UAC แสดงชื่อ Node.js
  - elevated.mjs **self-contained** (security-2 T3): import ได้แค่ `node:*` (test บังคับ + trace การโหลดจริง) — ไม่มี zod / ไม่มี package.json lookup; validate allowlist ด้วยโค้ดเขียนเอง (เข้มกว่าหรือเท่า zod schema ฝั่ง user — parity test) → ทำงาน → exit code **10 ok** / 2 task ไม่ถูก / 3 token หมดอายุ / 1 ล้ม — ไม่ใช้ 0 เป็น success เพราะ 0 = node จบโดยไม่ได้รัน main (review-3 E4; `EXIT:0` → `ELEVATION_FAILED`); ไม่อ่านไฟล์ที่ user เขียนได้เพื่อตัดสินใจ; ไม่มี top-level await (import ด้วย `require()` ได้ — E9); token ยาวเกิน 8192 → ปฏิเสธก่อน UAC (E7)
  - task ห้ามมี secret (อยู่ใน argv ของ process admin)
  - path ของ node/elevated.mjs = **real path** (`realpathSync.native`, resolve link — T4) ของ `process.execPath` + ตำแหน่ง package; path เดียวกันใช้ทั้งตรวจและเปิด (ไม่หาใน PATH)
- ผู้ใช้กด No ใน UAC → `ELEVATION_DENIED` (ไม่ retry เอง) — เฉพาะ Win32 error 1223 เท่านั้น; error อื่น = `ELEVATION_FAILED` (C3/S4). เปิดด้วย `ProcessStartInfo{Verb=runas, UseShellExecute, WorkingDirectory=System32}` (S2 กัน DLL planting จาก cwd)
- script ที่รันแบบ admin = `<package>/dist/platform/elevated.mjs` เสมอ (แม้รันจาก source, C6); ไม่มีไฟล์ → `ELEVATION_FAILED` + hint. `.mjs` ทำให้ต้องแก้ pack test ของ F-000 → [CR-001](../changes/CR-001-pack-mjs.md) (ผู้ใช้อนุญาต)
- **Token มีอายุ 5 นาที** (`{v:1, iat, task}`); elevated.mjs เจอ token หมดอายุ → exit 3 ไม่ทำอะไร → `ELEVATION_EXPIRED`. PowerShell รอ 5.5 นาที → หมดเวลา = `ELEVATION_FAILED` "timed out" — กด Yes ทีหลังก็ไม่มีผล (S3/C9). MVP-2 (`hosts.writeBlock`): timeout นี้รวมเวลารันงานด้วย → ต้องแยกเวลารอ prompt กับเวลารันงาน (review-2 D12)
- **Pre-elevation guard (S1, ผู้ใช้เลือก 2026-11-07 "Guards now + CR later")**: ก่อนเด้ง UAC ตรวจ → ถ้าเจอปัญหา = `ELEVATION_UNSAFE` (ไม่ถาม UAC) พร้อมรายการ + hint ให้ติดตั้งใน `C:\Program Files`:
  - ไฟล์ที่ process admin โหลด = `node.exe` + โฟลเดอร์ของมัน (DLL search) + ทุก `*.dll` / `*.manifest` / `*.local` ที่อยู่ในโฟลเดอร์นั้นแล้ว (security-3 U3) + `elevated.mjs` + โฟลเดอร์ของมัน (real path; resolve ไม่ได้ด้วยเหตุอื่นที่ไม่ใช่ไฟล์หาย = `ELEVATION_UNSAFE` — E6): owner ต้องเป็น SYSTEM/Administrators/TrustedInstaller และไม่มี ACE Allow ของคนอื่นที่เขียน/เพิ่มไฟล์/แก้ attribute/EA/ลบ/เปลี่ยนสิทธิ์ได้ (T5)
  - ทุก ancestor ของ path ข้างบน: คนอื่นต้องลบ/rename/เปลี่ยนสิทธิ์ไม่ได้ (เพิ่มไฟล์ได้ ok)
  - env ห้ามมีชื่อขึ้นต้น `NODE_` (ยกเว้น `NODE_ENV`), `OPENSSL_` (provider DLL — T1), `SSL_CERT_`, `UV_`, `ICU_` (U2) และ**ห้ามชื่อที่มีอักขระ non-ASCII** (security-3 U1: OpenSSL อ่าน env ผ่าน CRT narrow `getenv` → Windows best-fit แปลง `ＯPENSSL_CONF`, `OPENŚSL_CONF` … เป็น `OPENSSL_CONF`) — ตรวจจาก `HKLM\...\Session Manager\Environment`, `HKCU\Environment`, `HKCU\Volatile Environment` + subkey ทุก session (T2) และ env ของ process webhub เอง (กันกรณีสืบทอด). **ใช้ denylist ตาม prefix ไม่ใช่ allowlist** (R3): ตัวแปรอื่น (JAVA_HOME, GOPATH …) มีทั่วไปในเครื่อง dev และ node.exe ไม่อ่าน — allowlist จะปฏิเสธเกือบทุกเครื่อง
  - ผล: dev checkout / npm global ใต้โฟลเดอร์ user = elevate ไม่ได้ (ตั้งใจ). CR ทีหลัง: helper ติดตั้งใน Program Files
- ก่อนเรียก: ส่งคืน `describe(task)` ข้อความบอกผู้ใช้ว่าจะทำอะไร (dashboard/CLI แสดงก่อนกด) — ตาม PLAN "แสดงสิ่งที่จะทำ"

### 3.4 notify (Windows)
- ตาม Q3: toast ผ่าน PowerShell WinRT (`Windows.UI.Notifications.ToastNotificationManager`) ใช้ AppUserModelID ของ PowerShell; title/body ส่งทาง stdin (ไม่ต่อ string เข้า script), escape เป็น XML text
- ล้มเหลว (Focus Assist, policy, Windows Server ไม่มี WinRT) → ไม่ throw, คืน `false` + log; การแจ้งเตือนไม่ใช่ทางเดียวที่ข้อมูลไปถึงผู้ใช้ (dashboard มีเสมอ)

### 3.5 Errors เพิ่ม
`PLATFORM_UNSUPPORTED`, `PLATFORM_TOOL` (output ของ CIM/netsh ผิดรูป / tool เริ่มไม่ได้ / start time อ่านไม่ได้), `PORT_INVALID` (port/ช่วงไม่ถูก), `PORT_EXHAUSTED`, `PID_INVALID` (PID ไม่ใช่จำนวนเต็มบวก), `PROCESS_MISMATCH`, `PROCESS_KILL_FAILED` (taskkill แล้วยังไม่ตายใน 5 วิ), `ELEVATION_INVALID` (task ไม่อยู่ใน allowlist), `ELEVATION_EXPIRED`, `ELEVATION_UNSAFE`, `ELEVATION_DENIED`, `ELEVATION_FAILED`

- error จาก tool ที่เริ่มไม่ได้ (spawn / `SYSTEM_TOOL` ของ F-001) ถูกห่อเป็น `PLATFORM_TOOL` เสมอ (C10)
- stub OS อื่น: method async คืน Promise ที่ reject (ไม่ throw ตรง — C8); `capabilities()` throw
- ทุก PowerShell script ตั้ง `[Console]::OutputEncoding` = UTF-8 (S8: path ภาษาไทยไม่เป็น `??`); ข้อมูลเข้าทาง stdin เป็นบรรทัด `f:<base64>` (ค่าว่างไม่หาย — C5/S7)
- `notify` ล้มเหลว → `false` + ส่งข้อความเข้า `setPlatformLog()` (C10); `cleanText` ตัดอักขระที่ XML ห้าม + surrogate เดี่ยว, นับความยาวเป็น code point (C16/S10)

- ใช้ class `PlatformError` (`src/platform/types.ts`) แยกจาก `WebhubError` ของ F-001 — เพราะเพิ่ม code ใน `src/errors.ts` = แก้ feature ที่ done (R1). รวมเป็นตัวเดียวทีหลังผ่าน CR
- รายละเอียด implement ที่ต่างจากร่าง: `notify()` คืน `Promise<boolean>` (ไม่ throw); `elevate()` รับ `unknown` แล้ว validate เอง; exe/script/token ส่งเข้า PowerShell ทาง stdin (script คงที่); exit code ของ elevated.mjs ดู §3.3

## 4. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | core ไม่เรียก PowerShell/netsh ตรง → เพิ่ม OS อื่นไม่ต้องรื้อ; ใช้ CIM ได้ผลเหมือนกันทุกภาษา Windows; elevate แบบ allowlist ปิดช่อง "admin รันอะไรก็ได้"; killTree ตรวจ start time → ไม่ฆ่าผิดตัว |
| ผลเสีย | CIM ช้ากว่า netstat (~0.4 วิ vs 0.06) → ต้อง cache; UAC prompt แสดงชื่อ "Node.js" ไม่ใช่ "webhub" (ผู้ใช้อาจสงสัย — แก้ด้วยข้อความ describe ก่อนกด); toast ผ่าน AUMID ของ PowerShell แสดงชื่อ "Windows PowerShell" |
| ทางเลือกที่ไม่เลือก | `netstat -ano` parse — เร็วแต่ข้อความขึ้นกับภาษา; native addon (node-ffi / Win32 API ตรง) — ต้อง build script ซึ่ง F-000 บล็อก; `node-notifier` — แบก SnoreToast.exe (binary ใน dependency = supply chain risk); elevate ด้วย scheduled task ที่รันเป็น SYSTEM ค้างไว้ — สะดวกแต่เปิดช่อง privilege ถาวร |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done (F-000, F-001) | ไม่ | ไฟล์ใหม่ใน `src/platform/`, `test/`; เรียกใช้ export ของ F-001 โดยไม่แก้ |
| Zero-touch | ไม่ | ไม่แตะไฟล์ project; ports/process อ่านอย่างเดียว ยกเว้น killTree (เฉพาะ process ที่ webhub spawn เอง + start time ตรง) |
| Security | มี | elevate, killTree, input เข้า PowerShell — ดู §6 |
| Performance | เล็กน้อย | CIM ~0.4 วิต่อครั้ง, cache |
| Config / data | ไม่ | ไม่มีไฟล์ใหม่ใน `$WEBHUB_HOME` |
| Dependency | ไม่ | ไม่เพิ่ม |

## 6. Threat model
| Asset | ผู้โจมตี / ช่องทาง | ป้องกันด้วย | เทส |
|---|---|---|---|
| สิทธิ์ admin | ข้อมูลจาก project/config ถูกส่งเข้า elevate → รันคำสั่งเป็น admin | allowlist kind: zod strict ฝั่ง user + validator เขียนเองใน elevated.mjs (parity test); ไม่มี kind ที่รับคำสั่ง/path อิสระ | test task ไม่รู้จัก / field เกิน / `__proto__` → ปฏิเสธ (ทั้งสองฝั่ง) |
| สิทธิ์ admin | ไฟล์ที่ user เขียนได้ถูกสลับระหว่าง validate กับ execute (TOCTOU) | elevated.mjs ไม่อ่านไฟล์ตัดสินใจ — ข้อมูลมาใน argv เท่านั้น | review |
| สิทธิ์ admin | PATH hijack ตอนเรียก node/powershell แบบ admin | path เต็ม (`process.execPath`, `systemExe`) | test path absolute |
| process อื่นของผู้ใช้ | PID reuse → killTree ฆ่าโปรแกรมอื่น | ต้องส่ง start time, ตรวจก่อนฆ่า | test start time ไม่ตรง → ไม่ฆ่า |
| shell | ชื่อ/ข้อความ notify มีอักขระพิเศษ → injection ใน PowerShell | ข้อมูลทาง stdin + XML escape; script คงที่ | test ข้อความมี `'";$(...)<>` |
| ข้อมูล | output ของ CIM/netsh ผิดรูป → parse พลาด | parse เข้ม (JSON / regex ตัวเลข), ผิดรูป = error ไม่เดา | test fixture output |

| สิทธิ์ admin | **user อื่นในเครื่อง / ติดตั้งแบบไม่ปลอดภัย**: แก้ `elevated.mjs`, `node.exe`/โฟลเดอร์ หรือตั้ง `NODE_OPTIONS`/`OPENSSL_CONF` ใน env → รอผู้ใช้กด Yes ใน UAC (S1, T1–T5) | pre-elevation guard: owner/ACL ของ node.exe + elevated.mjs + โฟลเดอร์ + ancestor (real path), env denylist ทุกแหล่ง → `ELEVATION_UNSAFE` | test temp folder / `C:\Users\Public` ไม่ผ่าน; volatile env ถูกอ่าน; repo dev → `ELEVATION_UNSAFE` ไม่เด้ง UAC; elevated.mjs โหลดแค่ตัวเอง |
| สิทธิ์ admin | UAC ค้างเกิน timeout แล้วกด Yes ทีหลัง (S3) | token อายุ 5 นาที, timeout 5.5 นาที | test expiry |
| สิทธิ์ admin | DLL planting จาก cwd ของ process admin (S2) | WorkingDirectory = System32 | review |

ข้อจำกัดที่รู้ (ยอมรับ, บันทึกไว้):
- **โปรแกรมที่รันเป็น user เดียวกันอยู่แล้ว ป้องกันไม่ได้จริง (T6)**: มันเด้ง UAC ของ node.exe (signed ของจริง) พร้อม argument ของมันเองได้ หรือแก้ตัว guard ที่รันด้วยสิทธิ์ user (PSModulePath, HKCU SystemRoot → `systemExe` ของ F-001). guard นี้กัน user อื่น + การติดตั้งที่ไม่ปลอดภัย ไม่ใช่ malware ที่ได้สิทธิ์ user แล้ว — แก้จริงด้วย helper ใน Program Files ที่มี identity ของตัวเอง (CR ทีหลัง). ช่วงระหว่างตรวจกับ UAC (TOCTOU) ยอมรับ
- `canBind` แต่ละครั้งใช้ CIM สด (~1 วิ): เช็คหลาย port ให้เรียกพร้อมกัน (แชร์ query) หรือใช้ `findFree` (review-2 D6)
- env ของ process webhub ถูกตรวจด้วย (กันกรณีสืบทอด) → เปิด webhub ผ่าน shim ของ package manager ที่ตั้ง `NODE_PATH` (เช่น pnpm `.cmd`) = elevate ไม่ได้ (fail safe, hint บอก) (review-3 E10)
- node.exe build มี `MODULESDIR` = `c:\ws\…` ฝังไว้ และ user ทั่วไปสร้าง `C:\ws` ได้ — ใช้เฉพาะ provider ที่โหลดด้วยชื่อ (ต้อง `--openssl-legacy-provider` ซึ่งถูกบล็อกทาง `NODE_OPTIONS` หรือ `openssl.cnf` ของ admin) → ไม่ exploit ได้ตามค่า default (security-3 U4)
- `CreateEnvironmentBlock` อ่าน `C:\autoexec.bat` ได้เมื่อ `ParseAutoexec=1` — สร้างไฟล์นี้ได้แค่ admin → ไม่ใช่ช่องของ non-admin (U5)
- killTree ยังเป็นแบบ PID: ช่วงสั้นๆ ระหว่างอ่านตารางกับ taskkill; หลาน ที่พ่อตายไปก่อน (orphan) หาไม่เจอ (C11) → Job Object ตอน spawn (CR / feature daemon)
- เทียบ start time เป็น string จาก CIM local → UTC ใน F-001 `processState` — เปลี่ยน timezone / DST ช่วง fall-back อาจทำให้ไม่ตรง (fail safe = ไม่ฆ่า) (C12, ต้อง CR ของ F-001)

Checklist ที่เกี่ยว: Input, Privilege, Process, Zero-touch

## 7. คำถามถึงผู้ใช้
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|
| Q1 | อ่าน port ที่ถูกใช้ | CIM `MSFT_NetTCPConnection` / `netstat -ano` | **CIM** — ไม่ขึ้นกับภาษา Windows, ช้ากว่า (~0.4 วิ) แก้ด้วย cache | **CIM** |
| Q2 | กลไก elevate | `Start-Process -Verb RunAs` เรียก node + task ใน argv (allowlist) / scheduled task ที่ติดตั้งครั้งเดียวแล้วรันเป็น admin เมื่อเรียก | **RunAs + allowlist** — ถาม UAC ทุกครั้ง แต่ไม่มีช่อง admin ค้างในเครื่อง | **UAC ทุกครั้ง + allowlist** |
| Q3 | notification | toast ผ่าน PowerShell (ชื่อแสดงเป็น PowerShell) / ไม่ทำ toast ใน MVP-0 (dashboard อย่างเดียว) | **toast ผ่าน PowerShell** — ไม่มี dependency; ล้มเหลวเงียบได้ | **toast ผ่าน PowerShell** |

## 8. Test plan
| # | กรณี | ประเภท |
|---|---|---|
| 1 | `listening()` เจอ port ที่ test เปิดเอง พร้อม PID ตัวเอง | integration |
| 2 | parse output CIM/netsh จาก fixture (รวมผิดรูป → error) | unit |
| 3 | `reserved()` คืนช่วงที่ตัวเลขถูก + administered flag | unit (fixture) + integration |
| 4 | `canBind` false เมื่อ port ถูกใช้ / true เมื่อว่าง | integration |
| 5 | `findFree` ข้าม reserved/listening/avoid; หมด → `PORT_EXHAUSTED` | unit (fake) + integration |
| 6 | `info` ของตัวเอง / PID ไม่มี → undefined | integration |
| 7 | `killTree` ฆ่า child + grandchild ที่ spawn เอง; start time ไม่ตรง → ไม่ฆ่า + `PROCESS_MISMATCH` | integration |
| 8 | `usage` คืนค่าตัวเลขของ PID ตัวเอง | integration |
| 9 | elevate: task ไม่รู้จัก / field เกิน → ปฏิเสธก่อนเรียก UAC และใน elevated.mjs; argv ไม่มี path ที่หาจาก PATH | unit |
| 10 | elevate จริง (UAC) | **manual** (CI กด UAC ไม่ได้) — บันทึกใน test report |
| 11 | notify: ข้อความมีอักขระพิเศษ → script ไม่ถูกแทรก (ตรวจ stdin/script แยกกัน); ล้มเหลวไม่ throw | unit + integration |
| 12 | non-win32 → `PLATFORM_UNSUPPORTED` | unit |
| 13 | regression F-000 + F-001 | regression |
| 14 | `canBind` false เมื่อ process อื่นฟัง `::1` / `0.0.0.0` / `::`; findFree ข้าม listener IPv6 ของ process อื่น; ข้าม excluded range | integration |
| 15 | killTree: deadline < 10 วิ; descendant ที่เกิดก่อนพ่อไม่นับ; start time format = F-001 | unit + integration |
| 16 | elevate: token หมดอายุ / อนาคต → `ELEVATION_EXPIRED`, elevated exit 3; outcome: เฉพาะ 1223 = DENIED, timeout แยก | unit |
| 17 | pre-elevation guard: system file ผ่าน; temp folder ของ user ไม่ผ่าน; ไฟล์หาย = missing; `NODE_*` ถูกจับ; repo dev → `ELEVATION_UNSAFE` (ไม่เด้ง UAC) | unit + integration |
| 18 | notify: script คงที่ทุก input, text อยู่ใน stdin base64 เท่านั้น, ค่าว่างไม่หาย, ล้มเหลว → log | unit (runner ปลอม) |
| 19 | env non-ASCII / `ICU_` ถูกปฏิเสธ; DLL ในโฟลเดอร์ node ถูกตรวจ; parity สองทิศ + ทุก kind มี sample; exit 10 / `EXIT:0` = ล้ม; volatile-only names ถูกอ่าน; load trace = 1 module + bad token exit 2 | unit + integration |

## 9. Reports
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/F-002/test-1.md) | [review-1](../reports/F-002/review-1.md) | [security-1](../reports/F-002/security-1.md) | major C1–C4 + S1; ผู้ใช้: S1 guard now + CR later, แก้ minor/nit ทั้งหมดที่แก้ได้ |
| 2 | [test-2](../reports/F-002/test-2.md) | [review-2](../reports/F-002/review-2.md) | [security-2](../reports/F-002/security-2.md) | critical T1/T2 (=D1/D2), major T3/T4 → แก้ + CR-001 |
| 3 | [test-3](../reports/F-002/test-3.md) | [review-3](../reports/F-002/review-3.md) | [security-3](../reports/F-002/security-3.md) | code: 0 crit/major; security: critical U1 → ครบ 3 loop, ผู้ใช้: แก้ + review รอบ 4, แก้ minor/nit ทั้งหมด |
| 4 | [test-4](../reports/F-002/test-4.md) | | | รอ review รอบ 4 |

## 10. เอกสารที่อัปเดต (R4)
- [ ] DESIGN.md §21.1 (elevate allowlist + กลไก, findFree, toast)  - [ ] PLAN.md queue  - [ ] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-07 | W1 ① | ร่าง spec |
| 2026-11-07 | W1 ②③④⑤ | Q1 CIM, Q2 UAC + allowlist, Q3 toast PowerShell; อนุมัติ + ทำต่อเลย → W3 |
| 2026-11-07 | W3 รอบ 1 | implement + test-1; review-1 (C1–C16), security-1 (S1–S11) |
| 2026-11-07 | W3 รอบ 2 | ผู้ใช้: S1 "Guards now + CR later", minor/nit "Fix all fixable" (เว้น C11 Job Object, C12 CR F-001) → แก้ + test-2 |
| 2026-11-07 | W3 รอบ 3 | review-2/security-2 → self-contained elevated.mjs, real path, env denylist + volatile, kill root ก่อน; ผู้ใช้อนุญาต CR-001 → test-3 |
| 2026-11-07 | W3 รอบ 4 | ครบ 3 loop: ผู้ใช้ "Fix + review round 4", minor/nit "Fix all" → U1 non-ASCII env, ICU_, DLL ในโฟลเดอร์ node, exit 10, E1–E10 → test-4 |
