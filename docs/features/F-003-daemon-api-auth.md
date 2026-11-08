# F-003 — Daemon + API server + auth

| | |
|---|---|
| Status | `review` |
| Phase | MVP-1 (PLAN.md) |
| DESIGN.md | §2 (API + Dashboard), §10.3 (auth), §12 (`src/daemon.ts`, `src/server/`), §13 (CLI = client), §21.6 |
| Depends on | F-000, F-001 (home, lock, json-store, config), F-002 (ports — ตรวจว่าใครถือ port) |
| Owner อนุมัติ | ผู้ใช้ / 2026-11-08 (Q1–Q4 ตามที่แนะนำ) |

## 1. เป้าหมาย / ขอบเขต
**ทำ**
- `src/daemon.ts`: process หลักของ webhub — เปิด home, ถือ single-writer lock (F-001), เปิด API, ปิดสะอาด
- API server bind `127.0.0.1:7400` เท่านั้น (REST, JSON) + โครง route ที่ feature ต่อไปเสียบเพิ่มได้
- auth ครบชุดตาม §10.3: master token, Host allowlist (กัน DNS rebinding), Origin / Fetch-Metadata (กัน CSRF), session cookie host-only, one-time login link, Host ภายใน `webhub.internal`
- client library (`src/server/client.ts`) ที่ CLI (F-004) ใช้: หา daemon, พิสูจน์ว่าเป็น daemon ตัวจริงก่อนส่ง token, เรียก API
- endpoint ชุดแรก: health, hello (proof), status, shutdown, สร้าง login link, `/_webhub/login`, `/_auth`

**ไม่ทำ**
- คำสั่ง CLI (`webhub daemon start|stop|status`, start daemon อัตโนมัติ) → F-004 (ดู Q4)
- WebSocket endpoint จริง → feature ที่ต้องใช้ (dashboard F-027); F-003 ให้ฟังก์ชันตรวจ upgrade request ไว้ใช้ร่วม
- nginx / `hub.localhost` จริง → F-009; `/_wake` → F-013; session ของเครื่องมือเสริม (`sql.` …) → F-026
- โหมด `lan` / tunnel / password → phase หลัง; autostart → F-028

## 2. ระบบเดิมรองรับยังไง (R2)
- F-001: `resolveHome` / `ensureHome` / `pathsFor` (มี `paths.auth` = `data/auth.json` อยู่แล้ว), `acquireLock` (daemon ตัวเดียว), `writeDoc` (atomic + ACL เฉพาะ user), `loadConfig`
- F-002: `ports.listening()` → ระบุ PID ที่ถือ 7400 เมื่อ bind ไม่ได้ (บอกผู้ใช้ว่าโปรแกรมไหนชน)
- DESIGN §2 เลือก Fastify ไว้แล้ว (Q1 ยืนยันอีกครั้งเพราะเป็น dependency ใหญ่ตัวแรก)
- DESIGN ที่ต้องปรับ: §10.3 เพิ่ม "token เปลี่ยนทุกครั้งที่ daemon เริ่ม" (ถ้า Q2 เลือก) + handshake พิสูจน์ daemon; §12 เพิ่ม `src/server/client.ts`

## 3. Design

### 3.1 Daemon lifecycle
```
start: resolveHome → ensureHome → acquireLock (มีตัวอื่นถืออยู่ → DAEMON_RUNNING, exit 3)
     → loadConfig (ผิด → exit 2 + รายการจุดผิด) → สร้าง token ใหม่ (32 bytes random)
     → เขียน data/auth.json { schemaVersion:1, token, pid, port, startedAt } (ACL เฉพาะ user) — ก่อน listen (H16)
     → listen 127.0.0.1:7400 (EADDRINUSE → DAEMON_PORT_BUSY + PID/ชื่อโปรแกรมที่ถือ; EACCES = port ใน excluded range ของ Windows → DAEMON_PORT_BUSY + hint; exit 4; ลบ auth.json)
     → พร้อม (log "ready")
stop:  SIGINT / SIGTERM / SIGBREAK (Ctrl+Break) / SIGHUP (ปิดหน้าต่าง console) / POST /api/v1/shutdown
     → signal ที่มาระหว่าง start = ปิดทันทีที่ ready (handler ติดตั้งก่อน start — H8)
     → หยุดรับ connection ใหม่ (request ที่ค้างได้ 503) → รอ ≤ 5 วิ → ลบ auth.json (เฉพาะถ้ายังเป็นของเรา) → release lock → exit 0
crash: uncaughtException → พยายาม stop แล้ว exit 1; hook `exit` ลบ auth.json แบบ sync (K2); stdout ปิด (EPIPE) ไม่ทำให้ล้ม;
       lock ของ F-001 ตรวจ PID + start time → daemon ใหม่ยึดต่อได้; auth.json เก่าถูกเขียนทับ (token เก่าใช้ไม่ได้แล้ว)
```
- entry: `node dist/daemon.js` (foreground, log ไป stdout/stderr) — CLI F-004 จะ spawn แบบ detached + เขียน log ลง `logs/`
- exit code: 0 ปกติ, 2 config ผิด, 3 มี daemon อยู่แล้ว, 4 port ไม่ว่าง, 1 อื่นๆ
- env `WEBHUB_API_PORT` = สำหรับ test/dev เท่านั้น (ตั้งได้แค่ user เดียวกัน — security-1 K11) (integration test รันหลาย daemon พร้อมกัน); client อ่าน port จาก `auth.json` จึงตามได้เสมอ

### 3.2 Host allowlist (กัน DNS rebinding)
| Host ที่รับ | ใช้ทำอะไร |
|---|---|
| `127.0.0.1:7400` | CLI เท่านั้น — **bearer อย่างเดียว ไม่มี browser session** (security-1 K1: cookie ไม่แยก port → cookie ของ `127.0.0.1` ถูกส่งไปทุก dev server ที่ `127.0.0.1:<port>`) |
| `hub.localhost`, `db.localhost` (+ `:<httpPort>` เมื่อ ≠ 80) | ผ่าน nginx (F-009) |
| `webhub.internal` | เฉพาะ `/_auth`, `/_webhub/login` (`/_wake` ใน F-013) — path อื่น = 404 |
- เทียบแบบ exact (ตัวพิมพ์เล็ก, ตัด `.` ท้าย); ไม่มี / ซ้ำ / ไม่ตรง → **421** ก่อน auth ใดๆ, ไม่ส่งข้อมูลกลับ
- `localhost:7400`, IP อื่น, `0.0.0.0` → ไม่รับ (ตาม §10.3)
- `httpPort` มาจาก option ของ server (default 80) — ยังไม่มี key ใน config (F-001 done) → feature ที่เลือก HTTP port (F-008/F-014) ส่งค่าเข้ามา

### 3.3 Authentication
| วิธี | ใครใช้ | กติกา |
|---|---|---|
| `Authorization: Bearer <token>` | CLI / script | เทียบแบบ constant-time; ไม่ตรง → 401 (หน่วง 50 ms ต่อครั้งที่ผิด, ไม่บอกเหตุผล) |
| cookie `webhub_session` | browser (dashboard) | **เฉพาะ host ชื่อ `hub.`/`db.<suffix>`** (`sessionHosts`) — ไม่ออก/ไม่รับบน `127.0.0.1` (K1) → login ผ่าน browser ได้หลังมี nginx (F-009); id random 32 bytes, เก็บในหน่วยความจำ (daemon restart = login ใหม่), ผูกกับ Host ที่ออกให้ (cookie ของ `hub.` ใช้กับ `db.` ไม่ได้), idle 12 ชม. / อายุสูงสุด 7 วัน; `HttpOnly; SameSite=Strict; Path=/`, ไม่มี `Domain` (host-only), ไม่ใส่ `Secure` (http ใน MVP) |

- **token**: ตาม Q2 (แนะนำ: สุ่มใหม่ทุกครั้งที่ daemon เริ่ม เก็บใน `data/auth.json` ACL เฉพาะ user, ลบตอนปิด)
- **login link**: `POST /api/v1/login-links {host?}` (bearer เท่านั้น; host ต้องเป็น session host, default `hub.<suffix>`) → code random 32 bytes, ใช้ครั้งเดียว, อายุ 60 วิ, ผูกกับ host → `http://<host>/_webhub/login?t=<code>`
  - ข้อกำหนดถึง F-004 (security-1 K3): `webhub ui` ห้ามส่ง URL ที่มี code ผ่าน argv ของโปรแกรมเปิด browser (process อื่นอ่าน command line ได้) → เปิดผ่าน temp file เฉพาะ user / OS opener ที่ไม่โชว์ argv หรือให้หน้า GET POST code ต่อ
  - `GET /_webhub/login?t=` บน host นั้น (หรือ `webhub.internal` + `X-Forwarded-Host` ที่อยู่ใน allowlist) → ใช้ code → `Set-Cookie` → `303` ไป `/`; code ผิด/หมดอายุ/ใช้แล้ว → 401 หน้า text ธรรมดา
  - response: `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (code ไม่หลุดผ่าน Referer / cache)
- `/_auth` (สำหรับ nginx `auth_request` — F-026 ใช้): Host `webhub.internal` เท่านั้น, ตรวจ cookie ของ `X-Forwarded-Host` → 204 / 401
- **logout**: `POST /api/v1/logout` ลบ session ปัจจุบัน

### 3.4 CSRF / cross-origin
- ไม่ส่ง CORS header ใดๆ เลย; `OPTIONS` → 405 (preflight ไม่ผ่าน → browser ส่ง `Authorization` / JSON ข้าม origin ไม่ได้)
- request ที่ไม่ใช่ `GET`/`HEAD` และ auth ด้วย cookie: ต้องมี `Origin` = `http://<Host ของ request>` **และ** ถ้ามี `Sec-Fetch-Site` ต้องเป็น `same-origin` → ไม่งั้น 403
- request ที่ auth ด้วย bearer: ถ้ามี `Origin` ต้องตรงแบบเดียวกัน (CLI ไม่ส่ง Origin)
- `GET`/`HEAD` ไม่เปลี่ยนข้อมูลเด็ดขาด (กติกาสำหรับทุก feature ต่อไป — review checklist)
- body: JSON เท่านั้น (`Content-Type: application/json`, อย่างอื่น 415; body ว่าง = ไม่มี body), สูงสุด 1 MB (ค่า default; feature อัปโหลดกำหนดเองทีหลัง)
- request target ต้องเป็น `/path` (absolute-form `http://other/…` → 400 — K5); error ก่อน routing (URL encoding ผิด) และ error ของ parser ของ Node ใช้รูปแบบ error + header เดียวกัน, Host ผิด → 421 (H3/K8); ระหว่างปิด → 503 `SHUTTING_DOWN` (H4)
- กัน slowloris: `headersTimeout` 10 วิ, `requestTimeout` 30 วิ, `maxConnections` 256 (K4)
- WebSocket (feature ถัดไป): ตรวจ upgrade ด้วย `checkUpgrade()` ใน `auth.ts` — กติกาเดียวกับ request ที่แก้ข้อมูล (Host, bearer/session, Origin) (H6)
- ทุก response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store` (API), CSP เข้มสำหรับหน้า HTML (`default-src 'none'`) — dashboard F-027 กำหนด CSP ของตัวเอง

### 3.5 พิสูจน์ daemon ก่อนส่ง token (client)
ปัญหา: daemon ไม่รัน → โปรแกรมอื่นของ user ใดๆ เปิด 7400 รอ → CLI ส่ง token ไปให้มัน
```
client: อ่าน auth.json (ไม่มี → DAEMON_NOT_RUNNING)
     → GET /api/v1/hello?n=<nonce 32 bytes>   (ไม่มี auth)
     ← { proof: HMAC-SHA256(token, "webhub-hello:" + nonce) }   (ไม่มี pid — K7)
     → ตรวจ proof (constant-time) → ไม่ตรง = DAEMON_IMPOSTOR (ไม่ส่ง token)
     → request จริงพร้อม Bearer
```
- โปรแกรมที่ไม่รู้ token สร้าง proof ไม่ได้; nonce ใหม่ทุกครั้ง → replay ไม่ได้; ใช้ ~1 ms ไม่ต้องเรียก CIM
- client ใช้ `node:http` ตรง (ไม่ต้องมี dependency ฝั่ง client), deadline รวม 10 วิ (ไม่ใช่แค่ idle — H13), ไม่ตาม redirect; connection error / 401 → พิสูจน์ใหม่ก่อน request ถัดไป
- ข้อกำหนดถึง F-004: daemon เขียน `auth.json` **ก่อน** listen (H16) → หลัง spawn ให้รอจน `auth.pid` = PID ที่ spawn และ port ตอบ; ไฟล์ค้างจาก crash + port ปฏิเสธ = "ไม่ได้รัน" (K2)

### 3.6 Endpoints (F-003)
| Method | Path | Auth | ผล |
|---|---|---|---|
| GET | `/api/v1/health` | ไม่มี | `{ ok: true }` (ไม่มี version/pid) |
| GET | `/api/v1/hello?n=` | ไม่มี | `{ proof }` (§3.5) |
| GET | `/api/v1/status` | bearer/cookie | `{ version, pid, startedAt, home, mode }` |
| POST | `/api/v1/shutdown` | bearer | 202 แล้วปิด (ปิดแม้ client ตัดก่อนได้คำตอบ — H10; มาก่อน ready → เข้าคิว — H5) |
| POST | `/api/v1/login-links` | bearer | `{ url, expiresAt }` |
| POST | `/api/v1/logout` | cookie | 204 |
| GET | `/_webhub/login?t=` | code | 303 + cookie |
| GET | `/_auth` | cookie (internal) | 204 / 401 |
- path อื่น → 404 JSON; error ทุกตัวรูปแบบ `{ error: { code, message } }` ไม่มี stack / path ภายใน
- route ของ feature ต่อไปลงทะเบียนผ่าน `registerRoutes(app, ctx)` ใต้ `/api/v1/` → ได้ Host/auth/CSRF อัตโนมัติ (default = ต้อง auth; route สาธารณะต้องประกาศชัด)

### 3.7 Errors
`ServerError` (`src/server/errors.ts`) แยกจาก `WebhubError` ของ F-001 แบบเดียวกับ `PlatformError` (R1 — รวมทีหลังผ่าน CR): `DAEMON_RUNNING`, `DAEMON_PORT_BUSY`, `DAEMON_NOT_RUNNING`, `DAEMON_IMPOSTOR`, `DAEMON_UNREACHABLE`, `API_ERROR` (client ได้ error จาก API)

### 3.8 Logging
- บรรทัด JSON ไป stdout: method, path (**ไม่มี query string**, absolute-form = `(invalid target)`), status, ms; ไม่ log header `Authorization`/`Cookie`/`Set-Cookie`, body, code, token (redact + test)
- error 5xx: log แค่ชื่อ class / code ของ error ไม่ log message (อาจมี path / secret ของ feature ถัดไป — H2)

### 3.9 Platform
- ไม่มีโค้ดเฉพาะ OS นอกจาก `SIGBREAK` และข้อความ port busy (F-002 `ports.listening`); bind loopback ไม่เด้ง firewall prompt

## 4. ผลดี / ผลเสีย (R3)
| | รายละเอียด |
|---|---|
| ผลดี | ทุก feature ต่อจากนี้ได้ Host/auth/CSRF ฟรีผ่าน `registerRoutes` (default ปิด); token เปลี่ยนทุก start → ไฟล์ backup/sync หลุดก็ใช้ไม่ได้; CLI ไม่เคยส่ง token ให้โปรแกรมปลอม; ไม่มี CORS เลย = ผิวโจมตีจาก browser แคบ |
| ผลเสีย | Fastify + dependency ย่อย (~40 package) = supply chain ใหญ่ขึ้น (pin exact + audit); session อยู่ในหน่วยความจำ → restart daemon แล้วต้องเปิด `webhub ui` ใหม่; port 7400 ตายตัวใน F-003 (Q3) |
| ทางเลือกที่ไม่เลือก | Named pipe (`\\.\pipe\webhub`) สำหรับ CLI — ACL ของ Windows กันคนอื่นได้ไม่ต้องมี token แต่ browser ใช้ไม่ได้ ยังต้องมี HTTP + auth อยู่ดี = 2 ช่องทางให้ดูแล; JWT — ไม่จำเป็นกับ server ตัวเดียว + เพิ่มความเสี่ยงตั้งค่าผิด; CORS allowlist — ไม่มีใครต้องเรียกข้าม origin |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done (F-000–F-002) | ไม่ | ใช้ export เดิม ไม่แก้; ไฟล์ใหม่ `src/daemon.ts`, `src/server/*`; pack test (F-000) ยอม `dist/*.js` ที่ build จาก src อยู่แล้ว |
| Zero-touch | ไม่ | ไม่แตะ project |
| Security | มี | เปิด port แรกของ webhub — ดู §6 |
| Performance | เล็กน้อย | daemon idle ~50 MB RAM; handshake ~1 ms |
| Config / data | เพิ่ม | `data/auth.json` (มีใน `Paths` แล้ว), schemaVersion 1; ไม่เพิ่ม key ใน config |
| Dependency | เพิ่ม | ตาม Q1 (แนะนำ `fastify` pin exact, ปล่อยมาแล้ว ≥ 14 วัน); cookie parse/serialize เขียนเอง (cookie เดียว) |

## 6. Threat model (R6)
| Asset | ผู้โจมตี / ช่องทาง | ป้องกันด้วย | เทส |
|---|---|---|---|
| API ทั้งหมด | เว็บที่ผู้ใช้เปิด + DNS rebinding (`evil.com` → 127.0.0.1) | Host allowlist exact → 421 ก่อนทุกอย่าง | Host ไม่ตรง / ไม่มี / ซ้ำ / `localhost:7400` / `127.0.0.1:7400.evil.com` → 421 |
| การแก้ข้อมูล | CSRF จากเว็บอื่น (form POST, fetch no-cors) | SameSite=Strict + Origin ตรง + Sec-Fetch-Site + JSON only (415) + ไม่มี CORS | POST ไม่มี/ผิด Origin, `text/plain`, `cross-site` → 403/415 |
| master token | โปรแกรมอื่นแอบฟัง 7400 ตอน daemon ไม่รัน | handshake proof ก่อนส่ง (§3.5) | server ปลอมไม่รู้ token → client ไม่ส่ง |
| master token | user อื่นในเครื่อง / ไฟล์ backup | `auth.json` ACL เฉพาะ user (F-001 writeDoc); token ใหม่ทุก start; ลบตอนปิด | ACL ของไฟล์; token เปลี่ยนหลัง restart |
| master token / code | หลุดทาง log, Referer, history, cache | ไม่ log query/header ลับ; `no-referrer`, `no-store`; code ใช้ครั้งเดียว 60 วิ | log ไม่มี token/code/cookie; code ใช้ซ้ำ → 401 |
| session | cookie รั่วไปเว็บ `<site>.localhost` ของ project (โค้ด project อ่าน/ส่งต่อ) | host-only (ไม่มี `Domain`), HttpOnly, ผูก session กับ host | cookie ของ hub ใช้กับ db ไม่ได้ |
| session | dev server ของ project ที่ `127.0.0.1:<port>` ได้ cookie ของ `127.0.0.1` (cookie ไม่แยก port; ทุก port = same-site) แล้ว replay (security-1 K1 — critical) | session มีเฉพาะ `hub.`/`db.<suffix>`; `127.0.0.1:<apiPort>` = bearer เท่านั้น | link/login บน IP host → 400/401; cookie ของ hub ส่งมากับ Host IP → 401 |
| session | เว็บอื่นยัด `webhub_session` ซ้ำ (cookie tossing) | cookie ซ้ำ = ไม่มี session (ไม่ fixation) | test cookie ซ้ำ → 401 |
| daemon | slowloris / เปิด socket ค้างจาก process ในเครื่อง | `headersTimeout` 10 วิ, `maxConnections` 256 | test ค่า server |
| session | เดา id / brute force token | 32 bytes random; constant-time; หน่วงเมื่อผิด | — (review) |
| `webhub.internal` | process ในเครื่องตั้ง Host เอง | endpoint ภายในทำได้แค่ตรวจ cookie / ใช้ code (ต้องรู้ code อยู่แล้ว); browser ตั้ง Host นี้ไม่ได้ | path อื่นบน internal → 404 |
| daemon | request ใหญ่ / ค้าง (slowloris) | body ≤ 1 MB, header/request timeout, keep-alive timeout | body เกิน → 413 |
| data | daemon 2 ตัวเขียนพร้อมกัน | F-001 lock → ตัวที่ 2 exit 3 | integration |
| ข้อมูลภายใน | error เผย path / stack | error JSON รูปแบบเดียว ไม่มี stack | test |

ข้อจำกัดที่รู้ (ยอมรับ):
- cookie ของ `hub.<suffix>` ถูกส่งไป `hub.<suffix>:<port อื่น>` ด้วย (ไม่แยก port) — เกิดเมื่อผู้ใช้เปิด URL แบบนั้นที่โปรแกรมอื่นเสิร์ฟเท่านั้น; Host allowlist ของ daemon ไม่รับ port อื่นอยู่แล้ว
- browser บางตัวอาจยอม `Domain=localhost` จาก `<site>.localhost` (ยังไม่ทดสอบ — K6) → ได้แค่ DoS (cookie ซ้ำ = ไม่มี session); `__Host-` prefix ต้องใช้ Secure (http ใช้ไม่ได้) → ทบทวนตอนทำ HTTPS
- process ที่ถือ session id อยู่แล้วต่ออายุได้ด้วยการเรียกเรื่อยๆ (สูงสุด 7 วัน — K9)

Security checklist (WORKFLOW §6): Input, Auth, Network, Secrets, Logging, Dependency

## 7. คำถามถึงผู้ใช้ (ขั้น ②)
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|
| Q1 | HTTP server | Fastify 5 / `node:http` เขียนเอง / Hono | **Fastify 5** — DESIGN เลือกไว้, ใช้กันมาก, มี body limit / timeout / schema ในตัว; ต้อง pin + audit | **Fastify 5** (pin 5.12.7) |
| Q2 | เก็บ master token | สุ่มใหม่ทุก start ใน `auth.json` (ACL) / token ถาวรเข้ารหัส DPAPI ใน `secrets.json` / token ถาวร plain + ACL | **สุ่มใหม่ทุก start** — CLI อ่านเร็ว (ไม่ต้องเรียก PowerShell ~0.5 วิทุกคำสั่ง), หลุดจาก backup ก็ใช้ไม่ได้ | **สุ่มใหม่ทุก start** |
| Q3 | port 7400 | ตายตัวใน F-003, แก้ได้เมื่อทำ Port Manager (F-014 + CR) / ทำ CR ของ F-001 เพิ่ม key config ตอนนี้ | **ตายตัวก่อน** — ไม่ต้องแก้ feature ที่ done ตอนนี้; ชน → error บอกโปรแกรมที่ถือ port | **ตายตัวก่อน** |
| Q4 | คำสั่งเปิด/ปิด daemon | อยู่ใน F-004 (CLI) / ใส่ใน F-003 | **F-004** — F-003 = daemon + API + client library; เทสด้วย `node dist/daemon.js` | **F-004** |

## 8. Test plan
| # | กรณี | ประเภท |
|---|---|---|
| 1 | Host allowlist: ตรง → ผ่าน; ไม่ตรง/ไม่มี/ซ้ำ/`localhost:7400`/ต่อท้ายโดเมน/ตัวพิมพ์ใหญ่/จุดท้าย → ตามกติกา | unit (inject) |
| 2 | bearer: ถูก/ผิด/ไม่มี/รูปแบบผิด; constant-time compare ใช้ `timingSafeEqual` | unit |
| 3 | CSRF: cookie + POST ไม่มี Origin / Origin อื่น / `Sec-Fetch-Site: cross-site` → 403; `text/plain` → 415; `OPTIONS` → 405; ไม่มี CORS header ในทุก response | unit |
| 4 | login link: ใช้ได้ครั้งเดียว, หมดอายุ 60 วิ, ผูก host (ใช้กับ host อื่น → 401), cookie flags ครบ, ไม่มี `Domain` | unit |
| 5 | session: ผูก host, idle/absolute expiry (นาฬิกาปลอม), logout | unit |
| 6 | `webhub.internal`: เฉพาะ `/_auth` + `/_webhub/login`; `X-Forwarded-Host` นอก allowlist → 401 | unit |
| 7 | handshake: daemon จริงผ่าน; server ปลอม (proof ผิด) → `DAEMON_IMPOSTOR` และ server ปลอมไม่เห็น `Authorization` | integration |
| 8 | lifecycle: start → `auth.json` (ACL เฉพาะ user) → status → shutdown → `auth.json` หาย + lock ปล่อย; daemon ตัวที่ 2 → exit 3; port ไม่ว่าง → exit 4 + PID ที่ถือ | integration (spawn `dist/daemon.js`, `WEBHUB_HOME` temp) |
| 9 | token ใหม่หลัง restart; token เก่า → 401 | integration |
| 10 | log ไม่มี token / code / cookie / query string | unit |
| 11 | body > 1 MB → 413; error ไม่มี stack | unit |
| 12 | route ใหม่ผ่าน `registerRoutes` ได้ auth อัตโนมัติ (ไม่ประกาศ public → 401) | unit |
| 13 | regression F-000–F-002 | regression |
| 14 | ไม่มี session บน IP host (link/login/cookie replay → 400/401); cookie ซ้ำ → 401; Set-Cookie จริงของ 303 ครบ flag | unit |
| 15 | HEAD คง auth; URL ผิด → 400 / 421 รูปแบบเดียว + header; OPTIONS มี `Allow`; header ความปลอดภัยทุก response; JSON body ว่าง = ok | unit |
| 16 | log 5xx ไม่มี message / token; `checkUpgrade` ทุกกรณี; ค่า timeout / maxConnections | unit |
| 17 | raw socket: ไม่มี Host → 421, absolute-form → 400 (ไม่ log host); config ผิด → exit 2 + ไม่มีไฟล์ค้าง; in-process: abort signal (ก่อน/หลัง ready) + API shutdown → `stopped`, ไฟล์หาย | integration |

## 9. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/F-003/test-1.md) | [review-1](../reports/F-003/review-1.md) | [security-1](../reports/F-003/security-1.md) | critical K1 (= major H1); ผู้ใช้: แก้ทั้งหมด |
| 2 | [test-2](../reports/F-003/test-2.md) | | | รอ review รอบ 2 |

## 10. เอกสารที่อัปเดต (R4)
- [ ] DESIGN.md §10.3, §12  - [ ] PLAN.md queue  - [ ] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-08 | W1 ① | ร่าง spec |
| 2026-11-08 | W1 ②③④ | ผู้ใช้: Q1 Fastify 5, Q2 token สุ่มใหม่ทุก start, Q3 port 7400 ตายตัว, Q4 คำสั่ง daemon อยู่ F-004 → DESIGN §10.3/§12, เข้า Plan queue `planned` |
| 2026-11-08 | W3 รอบ 1 | implement + test-1; review-1 (H1–H16), security-1 (K1 critical, K2–K12) |
| 2026-11-08 | W3 รอบ 2 | ผู้ใช้ "แก้ทั้งหมด" → session เฉพาะ hub./db. (K1), framework/client errors, 503, timeouts, log, signal/SIGHUP/exit cleanup, auth.json ก่อน listen, `checkUpgrade`, test เพิ่ม → test-2 |
