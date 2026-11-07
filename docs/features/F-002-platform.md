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
interface ProcInfo { pid: number; name: string; exe?: string; startedAt: string; parentPid?: number }
interface Usage { cpuSeconds: number; workingSetBytes: number }
type ElevatedTask = { kind: "noop" }            // MVP-2 เพิ่ม { kind: "hosts.writeBlock"; entries: HostEntry[] }

interface Platform {
  readonly name: "win32" | "darwin" | "linux";
  ports: {
    listening(): Promise<PortOwner[]>;
    reserved(): Promise<PortRange[]>;
    canBind(port: number, host?: "127.0.0.1" | "0.0.0.0"): Promise<boolean>;
    findFree(range: [number, number], avoid?: ReadonlySet<number>): Promise<number>;
  };
  process: {
    info(pid: number): Promise<ProcInfo | undefined>;
    killTree(pid: number, expectStartedAt: string): Promise<void>;
    usage(pids: readonly number[]): Promise<Map<number, Usage>>;
  };
  elevate(task: ElevatedTask): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  capabilities(): { resolvesLocalhostSubdomains: boolean; dockerTopology: "host-gateway" | "host-network" };
}
getPlatform(): Platform   // เลือกตาม process.platform; ไม่ใช่ win32 → stub ที่ throw PLATFORM_UNSUPPORTED
```

### 3.1 ports (Windows)
- `listening()`: CIM `MSFT_NetTCPConnection` `State=2` (Listen) → `{LocalAddress, LocalPort, OwningProcess}` เป็น JSON (~0.4 วิ, **ไม่ขึ้นกับภาษา Windows** — `netstat` แปลคำว่า LISTENING ตามภาษา). cache 2 วิ
- `reserved()`: `netsh int ipv4 show excludedportrange protocol=tcp` + ipv6 → parse เฉพาะบรรทัดที่เป็นตัวเลข 2 ตัว (`*` = administered) — ตัวเลขไม่ขึ้นกับภาษา
- `canBind(port, host)`: ลอง `net.createServer().listen({port, host, exclusive: true})` แล้วปิดทันที — ความจริงสุดท้าย (excluded / ถูกใช้ / firewall)
- `findFree(range, avoid)`: ตัด reserved + listening + avoid → ลอง `canBind` ทีละตัวจากต้นช่วง; ไม่เหลือ → `PORT_EXHAUSTED` (บอกช่วงที่หมด)
- ไม่ฆ่า/ไม่แตะ process ที่ถือ port อยู่ (แค่รายงาน)

### 3.2 process (Windows)
- `info(pid)`: CIM `Win32_Process` (Name, ExecutablePath, CreationDate, ParentProcessId); ไม่มี → `undefined`
- `killTree(pid, expectStartedAt)`: **ต้องส่ง start time ที่จำไว้ตอน spawn** → ตรวจด้วย `processState` ก่อนว่ายังเป็น process เดิม (กัน PID reuse ฆ่าผิดตัว) → `taskkill.exe /PID n /T /F` (path เต็ม) → ตรวจซ้ำว่าตายจริง; process เดิมหายไปแล้ว = สำเร็จ; start time ไม่ตรง = ไม่ฆ่า + `PROCESS_MISMATCH`
- `usage(pids)`: CIM `Win32_PerfFormattedData_PerfProc_Process` ไม่แม่น/ช้า → ใช้ `Win32_Process` (KernelModeTime + UserModeTime, WorkingSetSize) batch เดียว
- ทุก PID ผ่าน `Number.isInteger` ก่อนเข้า script (เหมือน F-001)

### 3.3 elevate (Windows)
- งานที่ยกสิทธิ์ได้ = **allowlist ของ `kind`** ที่ define ในโค้ด webhub เท่านั้น; ไม่มี "รันคำสั่งนี้แบบ admin"
- กลไก (ตาม Q2): `Start-Process -Verb RunAs -Wait` เรียก `node <dist>/platform/elevated.js <base64-json>` → UAC แสดงชื่อ Node.js
  - elevated.js: parse + validate ด้วย zod strict ตาม kind → ทำงาน → exit code; ไม่อ่านไฟล์ที่ user เขียนได้เพื่อตัดสินใจ (ข้อมูลทั้งหมดมาใน arg ที่ validate แล้ว)
  - task ห้ามมี secret (อยู่ใน argv ของ process admin)
  - path ของ node/elevated.js = path เต็มจาก `process.execPath` + ตำแหน่ง package (ไม่หาใน PATH)
- ผู้ใช้กด No ใน UAC → `ELEVATION_DENIED` (ไม่ retry เอง)
- ก่อนเรียก: ส่งคืน `describe(task)` ข้อความบอกผู้ใช้ว่าจะทำอะไร (dashboard/CLI แสดงก่อนกด) — ตาม PLAN "แสดงสิ่งที่จะทำ"

### 3.4 notify (Windows)
- ตาม Q3: toast ผ่าน PowerShell WinRT (`Windows.UI.Notifications.ToastNotificationManager`) ใช้ AppUserModelID ของ PowerShell; title/body ส่งทาง stdin (ไม่ต่อ string เข้า script), escape เป็น XML text
- ล้มเหลว (Focus Assist, policy, Windows Server ไม่มี WinRT) → ไม่ throw, คืน `false` + log; การแจ้งเตือนไม่ใช่ทางเดียวที่ข้อมูลไปถึงผู้ใช้ (dashboard มีเสมอ)

### 3.5 Errors เพิ่ม
`PLATFORM_UNSUPPORTED`, `PORT_EXHAUSTED`, `PROCESS_MISMATCH`, `ELEVATION_DENIED`, `ELEVATION_FAILED`

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
| สิทธิ์ admin | ข้อมูลจาก project/config ถูกส่งเข้า elevate → รันคำสั่งเป็น admin | allowlist kind + zod strict ใน process admin; ไม่มี kind ที่รับคำสั่ง/path อิสระ | test task ไม่รู้จัก / field เกิน → ปฏิเสธ (ทั้งฝั่ง user และ elevated) |
| สิทธิ์ admin | ไฟล์ที่ user เขียนได้ถูกสลับระหว่าง validate กับ execute (TOCTOU) | elevated.js ไม่อ่านไฟล์ตัดสินใจ — ข้อมูลมาใน argv เท่านั้น | review |
| สิทธิ์ admin | PATH hijack ตอนเรียก node/powershell แบบ admin | path เต็ม (`process.execPath`, `systemExe`) | test path absolute |
| process อื่นของผู้ใช้ | PID reuse → killTree ฆ่าโปรแกรมอื่น | ต้องส่ง start time, ตรวจก่อนฆ่า | test start time ไม่ตรง → ไม่ฆ่า |
| shell | ชื่อ/ข้อความ notify มีอักขระพิเศษ → injection ใน PowerShell | ข้อมูลทาง stdin + XML escape; script คงที่ | test ข้อความมี `'";$(...)<>` |
| ข้อมูล | output ของ CIM/netsh ผิดรูป → parse พลาด | parse เข้ม (JSON / regex ตัวเลข), ผิดรูป = error ไม่เดา | test fixture output |

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
| 9 | elevate: task ไม่รู้จัก / field เกิน → ปฏิเสธก่อนเรียก UAC และใน elevated.js; argv ไม่มี path ที่หาจาก PATH | unit |
| 10 | elevate จริง (UAC) | **manual** (CI กด UAC ไม่ได้) — บันทึกใน test report |
| 11 | notify: ข้อความมีอักขระพิเศษ → script ไม่ถูกแทรก (ตรวจ stdin/script แยกกัน); ล้มเหลวไม่ throw | unit + integration |
| 12 | non-win32 → `PLATFORM_UNSUPPORTED` | unit |
| 13 | regression F-000 + F-001 | regression |

## 9. Reports
| รอบ | test | review | security | ผล |
|---|---|---|---|---|

## 10. เอกสารที่อัปเดต (R4)
- [ ] DESIGN.md §21.1 (elevate allowlist + กลไก, findFree, toast)  - [ ] PLAN.md queue  - [ ] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-07 | W1 ① | ร่าง spec |
| 2026-11-07 | W1 ②③④⑤ | Q1 CIM, Q2 UAC + allowlist, Q3 toast PowerShell; อนุมัติ + ทำต่อเลย → W3 |
