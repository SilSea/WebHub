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
- auth ครบชุดตาม §10.3: master token, Host allowlist (กัน DNS rebinding), Origin / Fetch-Metadata (กัน CSRF), browser session = cookie host-only **+ key ใน header** (security-2 L1), one-time login link, Host ภายใน `webhub.internal`
- client library (`src/server/client.ts`) ที่ CLI (F-004) ใช้: หา daemon, พิสูจน์ว่าเป็น daemon ตัวจริงก่อนส่ง token, เรียก API
- endpoint ชุดแรก: health, hello (proof), status, shutdown, สร้าง login link, `/_webhub/login`, logout

**ไม่ทำ**
- `/_auth` (nginx `auth_request` ของเครื่องมือเสริม) → ย้ายไป F-026 (security-2 L1/L4: cookie อย่างเดียวรั่วได้ + nginx ต้อง fail closed / ยืนยันตัว daemon — ต้องออกแบบเอง)
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
     → หยุดรับ connection ใหม่ (request ที่ค้างได้ 503) → รอ ≤ 5 วิ (close ทั้งหมดจำกัด 6 วิ แม้ hook ค้าง — M3) → ลบ auth.json (เฉพาะถ้ายังเป็นของเรา) → release lock → exit 0 (close ล้ม/ค้าง → exit 1)
     → signal ครั้งที่ 2 ระหว่างปิด = ออกทันที (exit 1, hook `exit` ลบ auth.json)
crash: uncaughtException (ติดตั้งก่อน start, `on` + กันซ้ำ, log แค่ชื่อ class แม้ `throw null` — M4) → พยายาม stop แล้ว exit 1; hook `exit` ลบ auth.json แบบ sync (K2); stdout ปิด (EPIPE) ไม่ทำให้ล้ม;
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
| `webhub.internal` | เฉพาะ `/_webhub/login` (`/_wake` ใน F-013, `/_auth` ใน F-026) — path อื่น = 404 |
- เทียบแบบ exact (ตัวพิมพ์เล็ก, ตัด `.` ท้าย); ไม่มี / ซ้ำ / ไม่ตรง → **421** ก่อน auth ใดๆ, ไม่ส่งข้อมูลกลับ (HTTP/1.1 ไม่มี Host ก็ 421 — ปิด `requireHostHeader` ของ Node — J3)
- `localhost:7400`, IP อื่น, `0.0.0.0` → ไม่รับ (ตาม §10.3)
- `httpPort` มาจาก option ของ server (default 80) — ยังไม่มี key ใน config (F-001 done) → feature ที่เลือก HTTP port (F-008/F-014) ส่งค่าเข้ามา

### 3.3 Authentication
| วิธี | ใครใช้ | กติกา |
|---|---|---|
| `Authorization: Bearer <token>` | CLI / script | เทียบแบบ constant-time; ไม่ตรง → 401 (หน่วง 50 ms ต่อครั้งที่ผิด, ไม่บอกเหตุผล) |
| cookie `webhub_session` **+** header `X-Webhub-Session: <key>` | browser (dashboard) | **ต้องมีทั้งคู่ + เป็น session เดียวกัน** (security-2 L1); **เฉพาะ host ชื่อ `hub.`/`db.<suffix>`** (`sessionHosts`) — ไม่ออก/ไม่รับบน `127.0.0.1` (K1) → login ผ่าน browser ได้หลังมี nginx (F-009); id + key random 32 bytes คนละค่า, เก็บในหน่วยความจำ (daemon restart = login ใหม่), ผูกกับ Host ที่ออกให้ (ของ `hub.` ใช้กับ `db.` ไม่ได้), idle 2 ชม. / อายุสูงสุด 24 ชม.; cookie `HttpOnly; SameSite=Strict; Path=/`, ไม่มี `Domain` (host-only), **ไม่มี `Max-Age`** (หายเมื่อปิด browser), ไม่ใส่ `Secure` (http ใน MVP) |

- **ทำไมต้องมี key** (L1, ยืนยันกับ Chrome จริง): cookie ไม่แยก port และ `*.localhost` ไปถึง loopback ทุก port → โปรแกรมใดๆ ที่ฟัง `127.0.0.1:<Q>` (เช่น dev server ของ project) สั่ง browser ไป `http://hub.localhost:<Q>` ได้เองแล้วได้ cookie ของ hub (SameSite=Strict กันแค่ navigation แรก) → key อยู่ใน `sessionStorage` ซึ่งแยกตาม scheme + host + **port** → โปรแกรมบน port อื่นอ่านไม่ได้
- key ไปถึงหน้าเว็บทาง fragment: `303 Location: /#k=<key>` (fragment ไม่ถูกส่งไป server / ไม่อยู่ใน Referer) → dashboard (F-027) ย้ายเข้า `sessionStorage` แล้ว `history.replaceState` ลบออกจาก URL; tab ใหม่ = `webhub ui` ใหม่ (ผู้ใช้เลือก sessionStorage)
- header เองต้อง preflight ข้าม origin → `OPTIONS` 405 = กัน CSRF อีกชั้น
- WebSocket ตั้ง header ไม่ได้ → ส่ง key เป็น subprotocol `webhub-key.<key>` **คู่กับ** `webhub.v1` (`checkUpgrade`); `checkUpgrade` คืน `protocol: "webhub.v1"` ให้ server ตอบ — ห้าม echo ตัว key; bearer ผิด → `delay: true` (ผู้เรียกหน่วง 50 ms เหมือน HTTP) (M8)
- cookie หลายค่า (port อื่นยัด cookie ของตัวเอง — tossing): ลอง 8 ค่าแรก — จับคู่ได้เฉพาะค่าที่ผูกกับ key → **ไม่มี fixation**; แต่ **logout ได้** (เขียนทับ cookie ชื่อ/path เดียวกันจาก port อื่น หรือดันค่าจริงเกิน 8) = residual risk ที่ยอมรับ (security-3 N3 / review-3 M2) จนกว่าจะมี HTTPS + `__Host-`

- **token**: ตาม Q2 (แนะนำ: สุ่มใหม่ทุกครั้งที่ daemon เริ่ม เก็บใน `data/auth.json` ACL เฉพาะ user, ลบตอนปิด)
- **login link**: `POST /api/v1/login-links {host?}` (bearer เท่านั้น; host ต้องเป็น session host, default `hub.<suffix>`) → code random 32 bytes, ใช้ครั้งเดียว, อายุ 60 วิ, ผูกกับ host → `http://<host>/_webhub/login?t=<code>`
  - **ปิดอยู่จนมี nginx ของ webhub** (option `browserLogin`, default ปิด → 503 `LOGIN_UNAVAILABLE`); F-009 เปิดเมื่อเขียน proxy secret ลง nginx แล้ว (security-3 N1 — ผู้ใช้เลือก "proxy secret + ปิดจน F-009")
  - **แลก code ได้เฉพาะผ่าน nginx ของ webhub**: request ต้องมี `X-Webhub-Proxy: <proxySecretFor(token)>` (HMAC ของ token, เปลี่ยนทุก start) — ตรวจก่อนแตะ code → โปรแกรมที่ยึด http port (port 80 ว่างก่อน F-009 / nginx ล่ม / Docker / IIS / user อื่น — Windows ไม่มี privileged port) ได้ link ไปก็แลกเองที่ 7400 ไม่ได้
  - ข้อกำหนดถึง F-009: nginx ใส่ `X-Webhub-Proxy` ทุก request ที่ส่งเข้า daemon และ**ลบค่าที่ client ส่งมา** (`proxy_set_header` ทับ); config ที่มี secret = ACL เฉพาะ user; เขียนใหม่ทุกครั้งที่ daemon start (secret เปลี่ยน); ห้าม log request header; ส่ง secret ไปที่ daemon เท่านั้น (Q5)
  - ข้อกำหนดถึง F-009 (security-4 Q1 — ผู้ใช้เลือกเป็นข้อกำหนด): proxy secret พิสูจน์แค่ว่า request ผ่าน nginx ไม่ได้พิสูจน์ว่า browser ของผู้ใช้ส่งมา — Windows ให้โปรแกรมอื่น bind http port เดียวกันบน address อื่นได้ (`[::1]:S` คู่ nginx บน `127.0.0.1:S` — Chrome ใช้ `::1` ก่อน; หรือ `127.0.0.1:S` คู่ nginx บน `0.0.0.0:S`) แล้ว relay link ผ่าน nginx ได้ session (ยืนยันกับ Chrome) → nginx ต้อง bind **ทุก address ที่ `hub.<suffix>` resolve ไป** (`127.0.0.1:S` **และ** `[::1]:S`) ห้าม wildcard อย่างเดียว; ก่อนเปิด `browserLogin` และ**ก่อนออกทุก login link** daemon ตรวจว่า**ทุก listener บน port S** (v4/v6, wildcard + เจาะจง) เป็น nginx ของ webhub ไม่งั้น 503; race ระหว่างตรวจกับ browser เปิด link = residual ที่ต้องบันทึกใน F-009
  - ข้อกำหนดถึง F-004 (`webhub ui`): ก่อนเปิด link ตรวจแบบเดียวกัน (ทุก listener บน http port = nginx ของ webhub, F-002 `ports.listening` + PID) — กันหน้า login ปลอม (phishing)
  - ข้อกำหนดถึง F-004 (security-1 K3): `webhub ui` ห้ามส่ง URL ที่มี code ผ่าน argv ของโปรแกรมเปิด browser (process อื่นอ่าน command line ได้) → เปิดผ่าน temp file เฉพาะ user / OS opener ที่ไม่โชว์ argv หรือให้หน้า GET POST code ต่อ
  - `GET /_webhub/login?t=` บน host นั้น (หรือ `webhub.internal` + `X-Forwarded-Host` ที่อยู่ใน allowlist) → ใช้ code → `Set-Cookie` → `303` ไป `/#k=<key>`; code ผิด/หมดอายุ/ใช้แล้ว → 401 หน้า text ธรรมดา; `HEAD` ไม่มี (404) → link preview ไม่เผา code (J4)
  - response: `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (code ไม่หลุดผ่าน Referer / cache)
- **logout**: `POST /api/v1/logout` ลบ session ปัจจุบัน
- ข้อกำหนดถึง F-009 / F-026 (security-2 L4): ตอน daemon ไม่รัน user อื่นยึด 7400 ได้ — CLI ปลอดภัย (handshake) แต่ nginx จะส่ง dashboard / `auth_request` ไปตัวปลอม → nginx ต้อง fail closed และ link nginx→daemon ต้องยืนยันตัว daemon (pipe + ACL หรือ proof ต่อ response); `/_auth` ใช้ cookie อย่างเดียวไม่ได้ (L1)
- ข้อกำหนดถึง F-009 / F-027 (security-3 N5): `/` ของ hub. **ห้าม redirect** (fragment `#k=` ตาม redirect ไปด้วย); dashboard ย้าย key เข้า sessionStorage + ลบออกจาก URL เป็นอย่างแรก; CSP เข้มทั้ง hub. และ db. (DB Studio แสดงข้อมูลที่ไม่น่าเชื่อถือ → XSS = ขโมย key); nginx เสิร์ฟเฉพาะเนื้อหาของ daemon บน 2 origin นี้

### 3.4 CSRF / cross-origin
- ไม่ส่ง CORS header ใดๆ เลย; `OPTIONS` → 405 (preflight ไม่ผ่าน → browser ส่ง `Authorization` / JSON ข้าม origin ไม่ได้)
- request ที่ไม่ใช่ `GET`/`HEAD` และ auth ด้วย session: ต้องมี `Origin` = `http://<Host ของ request>` **และ** ถ้ามี `Sec-Fetch-Site` ต้องเป็น `same-origin` → ไม่งั้น 403
- request ที่ auth ด้วย bearer: ถ้ามี `Origin` ต้องตรงแบบเดียวกัน (CLI ไม่ส่ง Origin)
- `GET`/`HEAD` ไม่เปลี่ยนข้อมูลเด็ดขาด (กติกาสำหรับทุก feature ต่อไป — review checklist)
- body: JSON เท่านั้น (`Content-Type: application/json`, อย่างอื่น 415; body ว่าง = ไม่มี body), สูงสุด 1 MB (ค่า default; feature อัปโหลดกำหนดเองทีหลัง)
- request target ต้องเป็น `/path` (absolute-form `http://other/…` → 400 — K5); error ก่อน routing (URL encoding ผิด) และ error ของ parser ของ Node ใช้รูปแบบ error + header เดียวกัน, Host ผิด → 421 (H3/K8); ระหว่างปิด → 503 `SHUTTING_DOWN` (H4); error ของ parser ระหว่างที่ response ก่อนหน้ายังค้าง (pipelining) → หยุดอ่าน socket แล้วตอบ 400 **ครั้งเดียว** หลัง response ที่ค้าง**ทุกตัว**เสร็จ (รอต่อเป็นทอด ทีละ 1 คู่ listener — ไม่สลับลำดับ ไม่ทิ้ง response — L5, review-5 R2; error ซ้ำของ socket เดิมไม่ทำอะไร → ไม่สะสม listener — security-4 Q3); หลังเขียน error แล้ว socket ถูก destroy เสมอ (เมื่อ flush เสร็จ + timer สำรอง 2 วิ) — socket ที่หยุดอ่านไม่เห็น FIN ของ client จะค้างใน connection count ตลอดไป (security-5 S1); URL ผิดถูก log เป็น `(invalid target)` + status จริง ไม่มี `ms` (ไม่มีเวลาเริ่ม — P5) (J5)
- กัน slowloris: `headersTimeout` 10 วิ, `requestTimeout` 30 วิ, ตรวจทุก 1 วิ (`connectionsCheckingInterval` — default 30 วิทำให้ตัดจริงที่ 30 วิ — L2/J1), `maxConnections` 256 (K4)
- WebSocket (feature ถัดไป): ตรวจ upgrade ด้วย `checkUpgrade()` ใน `auth.ts` — กติกาเดียวกับ request ที่แก้ข้อมูล (Host, bearer/session + key, Origin) (H6)
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
- **proof ผูกกับ connection** (security-3 N2 — ผู้ใช้เลือก): ทุก `request()` เปิด connection keep-alive ใหม่ 1 เส้น (`OneConnectionAgent` — เปิดได้เส้นเดียว) → hello + ตรวจ proof → ส่ง bearer **บนเส้นเดียวกัน**; ถ้าเส้นนั้นหลุด request ล้ม (`DAEMON_UNREACHABLE`) → token ถูกเขียน**เฉพาะบน connection ที่พิสูจน์แล้ว**เท่านั้น (ถ้า daemon ตัดเส้นนั้นพอดีหลัง proof อาจได้ ECONNRESET หลังเขียน — เส้นเดิม ปลายทางเดิม — P4); โปรแกรมที่แย่ง port หลัง daemon ปิดได้แค่ nonce
- คำตอบ 101 / connection ปิดโดยไม่มีคำตอบ → error (`DAEMON_UNREACHABLE`) ไม่ค้างเงียบ (security-4 Q2)
- client ใช้ `node:http` ตรง (ไม่ต้องมี dependency ฝั่ง client), deadline รวม 10 วิ (ไม่ใช่แค่ idle — H13), ไม่ตาม redirect; proof ไม่ผ่าน / ถูกปฏิเสธ → อ่าน `auth.json` ใหม่ 1 ครั้งแล้วพิสูจน์ใหม่ (daemon restart = token/port ใหม่ → request แรกหลัง restart ก็ผ่าน, ไม่รายงานผิดว่า impostor — J7/M6); ไฟล์หาย = `DAEMON_NOT_RUNNING`; อ่านไฟล์ error อื่น (path ไม่ปลอดภัย / เสีย) → แจ้ง error นั้นตรงๆ (M7)
- ข้อกำหนดถึง F-004: daemon เขียน `auth.json` **ก่อน** listen (H16) → หลัง spawn ให้รอจน `auth.pid` = PID ที่ spawn และ port ตอบ; ไฟล์ค้างจาก crash + port ปฏิเสธ = "ไม่ได้รัน" (K2)

### 3.6 Endpoints (F-003)
| Method | Path | Auth | ผล |
|---|---|---|---|
| GET | `/api/v1/health` | ไม่มี | `{ ok: true }` (ไม่มี version/pid) |
| GET | `/api/v1/hello?n=` | ไม่มี | `{ proof }` (§3.5) |
| GET | `/api/v1/status` | bearer/session | `{ version, pid, startedAt, home, mode }` |
| POST | `/api/v1/shutdown` | bearer | 202 แล้วปิด (ปิดแม้ client ตัดก่อนได้คำตอบ — H10; มาก่อน ready → เข้าคิว — H5) |
| POST | `/api/v1/login-links` | bearer | `{ url, expiresAt }`; 503 `LOGIN_UNAVAILABLE` จนมี nginx (F-009) |
| POST | `/api/v1/logout` | session | 204 |
| GET | `/_webhub/login?t=` | code + `X-Webhub-Proxy` (nginx) | 303 + cookie, `Location: /#k=<key>` |
- path อื่น → 404 JSON; error ทุกตัวรูปแบบ `{ error: { code, message } }` ไม่มี stack / path ภายใน
- route ของ feature ต่อไปลงทะเบียนผ่าน `registerRoutes(app, ctx)` ใต้ `/api/v1/` → ได้ Host/auth/CSRF อัตโนมัติ (default = ต้อง auth; route สาธารณะต้องประกาศชัด)

### 3.7 Errors
`ServerError` (`src/server/errors.ts`) แยกจาก `WebhubError` ของ F-001 แบบเดียวกับ `PlatformError` (R1 — รวมทีหลังผ่าน CR): `DAEMON_RUNNING`, `DAEMON_PORT_BUSY`, `DAEMON_NOT_RUNNING`, `DAEMON_IMPOSTOR`, `DAEMON_UNREACHABLE`, `API_ERROR` (client ได้ error จาก API)

### 3.8 Logging
- บรรทัด JSON ไป stdout: method, path (**ไม่มี query string**, absolute-form = `(invalid target)`), status, ms; ไม่ log header `Authorization`/`Cookie`/`Set-Cookie`/`X-Webhub-Session`, body, code, token, key (redact + test)
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
| master token | user อื่นแย่ง bind 7400 หลัง daemon ปิด/crash ขณะ client ตัวเดิมยังใช้อยู่ (security-3 N2 — major) | proof ใหม่ทุก request บน connection เดียวกับ bearer; connection หลุด = ล้มก่อนส่ง | proof แล้ว server ปิด socket → request ล้ม, token ไม่ถูกส่ง; proof + request = 1 connection |
| session | โปรแกรมยึด http port (ก่อนมี nginx / nginx ล่ม) ได้ login link แล้วแลกเองที่ 7400 (security-3 N1 — critical) | แลก code ต้องมี `X-Webhub-Proxy` (secret ที่มีแต่ nginx ของ webhub); login-links ปิดจน F-009; F-004 ตรวจเจ้าของ port ก่อนเปิด link | ไม่มี/ผิด proxy header → 401 ไม่เผา code; `browserLogin` ปิด → 503 |
| session | โปรแกรม bind http port บน address อื่น (`[::1]`) คู่ nginx แล้ว relay link ผ่าน nginx (security-4 Q1 — major latent, critical เมื่อเปิด login) | ข้อกำหนด F-009/F-004: nginx bind ทุก address ของ `hub.<suffix>`; ตรวจทุก listener บน port ก่อนเปิด login + ทุก link; ยังไม่ live (login ปิด) | F-009 / F-004 |
| daemon | connection เดียวส่งขยะทีละ byte หลัง request ช้า → listener สะสม → event loop ค้าง (security-4 Q3 — major latent) | ตอบ error ครั้งเดียวต่อ socket + หยุดอ่าน | 60 chunk หลัง route ช้า → 200, 400 เดียว, ไม่มี MaxListenersExceededWarning |
| daemon | process local ไม่มี auth: health ×3 pipelined + ขยะ แล้วออก → socket ที่หยุดอ่านค้าง half-open ตลอดไป; 256 ครั้ง = daemon ใช้ไม่ได้จน restart (security-5 S1 — critical ตาม R6, เกิดจาก fix Q3) | destroy socket หลังเขียน error (flush + timer 2 วิ) | 5 client × (health ×3 + ขยะ) → `getConnections()` = 0 ใน 1 วิ, `app.close()` < 500 ms |
| CLI | ตัวปลอมตอบ 101 → client ค้าง, CLI exit 0 เงียบ (Q2) | settle ครั้งเดียว, `close` ไม่มีคำตอบ / `upgrade` = error | 101 → `DAEMON_UNREACHABLE` < 3 วิ |
| data | close ค้าง (hook `preClose`) → ปล่อย lock แต่ port ยังเปิด → daemon 2 ตัว (Q4/P1) | close จำกัดเวลา + ปิด listener บังคับ; `main()` ออกเสมอเมื่อไม่ clean | preClose ค้าง → `{clean:false}`, port ว่าง, daemon ใหม่ start ได้ |
| master token | user อื่นในเครื่อง / ไฟล์ backup | `auth.json` ACL เฉพาะ user (F-001 writeDoc); token ใหม่ทุก start; ลบตอนปิด | ACL ของไฟล์; token เปลี่ยนหลัง restart |
| master token / code | หลุดทาง log, Referer, history, cache | ไม่ log query/header ลับ; `no-referrer`, `no-store`; code ใช้ครั้งเดียว 60 วิ | log ไม่มี token/code/cookie; code ใช้ซ้ำ → 401 |
| session | cookie รั่วไปเว็บ `<site>.localhost` ของ project (โค้ด project อ่าน/ส่งต่อ) | host-only (ไม่มี `Domain`), HttpOnly, ผูก session กับ host | cookie ของ hub ใช้กับ db ไม่ได้ |
| session | dev server ของ project ที่ `127.0.0.1:<port>` ได้ cookie ของ `127.0.0.1` (cookie ไม่แยก port; ทุก port = same-site) แล้ว replay (security-1 K1 — critical) | session มีเฉพาะ `hub.`/`db.<suffix>`; `127.0.0.1:<apiPort>` = bearer เท่านั้น | link/login บน IP host → 400/401; session ของ hub ส่งมากับ Host IP → 401 |
| session | โปรแกรมบน `127.0.0.1:<Q>` บังคับ browser ไป `hub.localhost:<Q>` แล้วได้ cookie ของ hub ไป replay (security-2 L1 — critical, ยืนยันกับ Chrome) | session = cookie **+ key** ใน header (key อยู่ใน sessionStorage แยกตาม port, ส่งทาง fragment); cookie ไม่มี Max-Age; idle 2 ชม. / สูงสุด 24 ชม. | cookie อย่างเดียว / key ของ session อื่น / key ผิด → 401; Location มี `#k=`; ไม่มี Max-Age |
| session | port อื่นของ host เดียวกันยัด / เขียนทับ `webhub_session` (cookie tossing — N3/M2) | ลอง 8 ค่าแรก — ค่าที่ไม่ผูกกับ key ไม่มีผล (ไม่ fixation); **logout ได้ = residual risk ที่ยอมรับ** | 7 ค่าปลอม + จริง → 200; 8 ค่าปลอม + จริง → 401 (บันทึกพฤติกรรม) |
| daemon | slowloris / เปิด socket ค้างจาก process ในเครื่อง | `headersTimeout` 10 วิ ตรวจทุก 1 วิ, `requestTimeout` 30 วิ, `maxConnections` 256 | integration: header ค้าง → 408 ใน ~10 วิ |
| daemon | user อื่นเปิด socket ค้างเกิน 256 → CLI ต่อไม่ได้ (security-2 L3 — DoS) | timeout จริง 10 วิ ลดเวลาถือ socket; **ยอมรับเป็น residual risk** (แก้เต็มไม่ได้บน TCP loopback) | — |
| session | เดา id / brute force token | 32 bytes random; constant-time; หน่วงเมื่อผิด | — (review) |
| `webhub.internal` | process ในเครื่องตั้ง Host เอง | endpoint ภายในทำได้แค่ใช้ code (ต้องรู้ code อยู่แล้ว); browser ตั้ง Host นี้ไม่ได้ | path อื่นบน internal → 404 |
| daemon | request ใหญ่ / ค้าง (slowloris) | body ≤ 1 MB, header/request timeout, keep-alive timeout | body เกิน → 413 |
| data | daemon 2 ตัวเขียนพร้อมกัน | F-001 lock → ตัวที่ 2 exit 3 | integration |
| ข้อมูลภายใน | error เผย path / stack | error JSON รูปแบบเดียว ไม่มี stack | test |

ข้อจำกัดที่รู้ (ยอมรับ):
- cookie ของ `hub.<suffix>` ยังถูกส่งไป `hub.<suffix>:<port อื่น>` (ไม่แยก port) — แต่ cookie อย่างเดียวใช้ไม่ได้แล้ว (ต้องมี key — L1); XSS บนหน้า dashboard เองอ่าน key ได้ → CSP เข้มของ F-027 สำคัญ
- URL `/#k=<key>` ถูกบันทึกใน history ถาวรของ browser (และ history sync) — `replaceState` แก้แค่ entry ปัจจุบัน ไม่ลบ visit (M9/N4); ต้องมี cookie ด้วยถึงใช้ได้ และ process ของ user เดียวกันอ่าน `auth.json` ได้อยู่แล้ว → ยอมรับ; F-027 พิจารณาแลก key ผ่าน POST (cookie + Origin → key ใน JSON) แทน fragment
- cookie ไม่มี Max-Age แต่ Chrome "เปิดต่อจากที่ค้างไว้" กู้ทั้ง cookie และ sessionStorage → อยู่ได้ถึงเพดาน 24 ชม. (N4)
- browser บางตัวอาจยอม `Domain=localhost` จาก `<site>.localhost` (ยังไม่ทดสอบ — K6) → ไม่มี fixation (cookie ที่ไม่ผูก key ถูกข้าม) แต่ logout ได้ (ข้างบน); `__Host-` prefix ต้องใช้ Secure (http ใช้ไม่ได้) → ทบทวนตอนทำ HTTPS
- process ที่ถือ session (cookie + key) อยู่แล้วต่ออายุได้ด้วยการเรียกเรื่อยๆ (สูงสุด 24 ชม. — K9)
- DoS ด้วย socket ค้างจาก user อื่น (L3) — ยอมรับ; ย้าย CLI ไป named pipe + ACL ได้ในอนาคตผ่าน CR

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
| 4 | login link: ใช้ได้ครั้งเดียว, หมดอายุ 60 วิ, ผูก host (ใช้กับ host อื่น → 401), cookie flags ครบ, ไม่มี `Domain` / `Max-Age`, `Location: /#k=<key>`; HEAD ไม่เผา code | unit |
| 5 | session: ผูก id + key + host, idle/absolute expiry (นาฬิกาปลอม), logout; cookie อย่างเดียว / key ของคนอื่น → 401; cookie ปลอมมาก่อน → ยัง 200 | unit |
| 6 | `webhub.internal`: เฉพาะ `/_webhub/login` (`/_auth` → 404); `X-Forwarded-Host` นอก allowlist / หลายค่า / IP → 401 | unit |
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
| 17 | raw socket: ไม่มี Host (HTTP/1.0 และ 1.1) → 421, absolute-form → 400 (ไม่ log host); config ผิด → exit 2 + ไม่มีไฟล์ค้าง; in-process: abort signal (ก่อน/หลัง ready) + API shutdown → `stopped`, ไฟล์หาย | integration |
| 18 | socket จริง: header ค้าง → 408 ใน 9–12.5 วิ; request ที่เสร็จระหว่างปิด → 503; shutdown แล้วตัดทันที → ยังปิด; garbage ตาม pipelining ไม่ตอบสลับลำดับ; client deadline (server หยดช้า → ETIMEDOUT) | integration (`api-socket.test.ts`) |
| 19 | close ล้ม (onClose hook throw) → ไม่มี unhandled rejection, `stopped = {clean:false}`, ไฟล์ + lock หาย; `onAuthFile` remover; client reload `auth.json` หลัง restart (ไม่ใช่ impostor), ไฟล์หาย → NOT_RUNNING; login-links body ว่าง / `__proto__` / `constructor` | integration + unit |
| 20 | N1: แลก code ไม่มี/ผิด `X-Webhub-Proxy` (direct + internal) → 401 ไม่ออก cookie, code ยังใช้ได้ผ่าน nginx; `browserLogin` ปิด → 503 | unit |
| 21 | N2: proof ใหม่ทุก request บน agent เดียวกับ request; server proof แล้วปิด socket → `DAEMON_UNREACHABLE`, token ไม่ถูกส่ง; API จริง: proof + request = 1 connection | unit + integration |
| 22 | M1: chunk เสียของ request ตัวเอง → 400, body ไม่ครบ → 408; L5: 200 ก่อนแล้วค่อย 400 เสมอ; M3: onClose ค้าง → `{clean:false}` < 9 วิ, ไฟล์หาย; M4: crash 2 ครั้ง / `throw null` ใน daemon จริง → exit 1, ไม่มี message/stack, ไฟล์ + lock หาย; M5: log 400/421 ตามจริง; M8: subprotocol ต้องมี `webhub.v1`, คืน `protocol`, key ของ session อื่น → 401 | integration + unit |
| 23 | Q3: ขยะ 60 chunk หลัง route ช้า → `["200","400"]`, ไม่มี MaxListenersExceededWarning; L5 เข้มเป็น `["200","400"]` (P3); Q2: 101 → error; P1/Q4: preClose ค้าง → port ว่าง, start ใหม่ได้ | integration |
| 24 | S1/R1: pipelined ×3 + ขยะ → `[200,200,200,400]`, server ปิด socket, connection = 0; R2: slow 200 ms + slow 600 ms + ขยะ → `[200,200,400]` ครบทั้งสอง body; R3: 101 → `details = [EUPGRADE]`; R4: daemon จริงที่ `close()` ค้าง (fixture `hang-close-daemon.mjs`) + shutdown → exit 1 < 10 วิ, ไฟล์ + lock หาย | integration |

## 9. Reports (R5)
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/F-003/test-1.md) | [review-1](../reports/F-003/review-1.md) | [security-1](../reports/F-003/security-1.md) | critical K1 (= major H1); ผู้ใช้: แก้ทั้งหมด |
| 2 | [test-2](../reports/F-003/test-2.md) | [review-2](../reports/F-003/review-2.md) | [security-2](../reports/F-003/security-2.md) | review: 0 critical/major (J1–J3 minor, J4–J8 nit); security: **L1 critical** (cookie บน `hub.localhost` รั่วไป port อื่น), L2–L3 minor → ผู้ใช้: L1 = cookie + key ใน sessionStorage, L3 = residual risk, minor/nit แก้ทั้งหมด |
| 3 | [test-3](../reports/F-003/test-3.md) | [review-3](../reports/F-003/review-3.md) | [security-3](../reports/F-003/security-3.md) | review: 0 critical/major (M1–M4 minor, M5–M10 nit); security: **N1 critical** (login code ไปถึงใครก็ได้ที่ฟัง httpPort แล้วแลกเป็น session), **N2 major** (client ส่ง token บน connection ที่ยังไม่พิสูจน์), N3 minor → ครบ 3 รอบ ถามผู้ใช้ → N1 = proxy secret + ปิดจน F-009, N2 = ผูก proof กับ connection, minor/nit แก้ทั้งหมด |
| 4 | [test-4](../reports/F-003/test-4.md) | [review-4](../reports/F-003/review-4.md) | [security-4](../reports/F-003/security-4.md) | review: 0 critical/major (P1–P2 minor, P3–P5 nit); security: **Q1 major latent** (squatter บน `[::1]:80` relay link ผ่าน nginx — critical เมื่อ F-009 เปิด login), **Q3 major latent** (clientError deferral → event loop ค้าง), Q2/Q4 minor → ถามผู้ใช้ → Q1 = ข้อกำหนด F-009/F-004, Q3 = ตอบครั้งเดียว + หยุดอ่าน, แก้ทั้งหมด |
| 5 | [test-5](../reports/F-003/test-5.md) | [review-5](../reports/F-003/review-5.md) | [security-5](../reports/F-003/security-5.md) | review: **R1 major** (socket ที่ pause ไม่ถูกปิด — regression จาก Q3), R2 minor, R3–R4 nit; security: **S1 critical** (= R1, DoS ไม่ต้อง auth), S2 info → ถามผู้ใช้ → end + destroy + timer สำรอง, แก้ทั้งหมด |
| 6 | [test-6](../reports/F-003/test-6.md) | | | รอ review รอบ 6 |

## 10. เอกสารที่อัปเดต (R4)
- [ ] DESIGN.md §10.3, §12  - [ ] PLAN.md queue  - [ ] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-08 | W1 ① | ร่าง spec |
| 2026-11-08 | W1 ②③④ | ผู้ใช้: Q1 Fastify 5, Q2 token สุ่มใหม่ทุก start, Q3 port 7400 ตายตัว, Q4 คำสั่ง daemon อยู่ F-004 → DESIGN §10.3/§12, เข้า Plan queue `planned` |
| 2026-11-08 | W3 รอบ 1 | implement + test-1; review-1 (H1–H16), security-1 (K1 critical, K2–K12) |
| 2026-11-08 | W3 รอบ 2 | ผู้ใช้ "แก้ทั้งหมด" → session เฉพาะ hub./db. (K1), framework/client errors, 503, timeouts, log, signal/SIGHUP/exit cleanup, auth.json ก่อน listen, `checkUpgrade`, test เพิ่ม → test-2 |
| 2026-11-08 | W3 รอบ 2 review | review-2 (J1–J8, ไม่มี critical/major), security-2 (L1 critical) |
| 2026-11-08 | W3 รอบ 3 | ผู้ใช้: L1 = cookie + header key (sessionStorage), L3 ยอมรับ, minor/nit แก้ทั้งหมด → session key + fragment, ไม่มี Max-Age, idle 2 ชม./สูงสุด 24 ชม., `/_auth` ย้ายไป F-026, timeout ตรวจทุก 1 วิ, `requireHostHeader: false`, HEAD login, log URL ผิด, stop ไม่ reject, hook ก่อน start, client reload, pipelining → test-3 |
| 2026-11-08 | W3 รอบ 3 review | review-3 (M1–M10, ไม่มี critical/major), security-3 (N1 critical, N2 major, N3 minor) → ครบ 3 รอบ ถามผู้ใช้ |
| 2026-11-08 | W3 รอบ 4 | ผู้ใช้: proxy secret + ปิด login จน F-009 (N1), proof ผูก connection (N2), แก้ทั้งหมด → `X-Webhub-Proxy`, `browserLogin`, `OneConnectionAgent`, stop จำกัดเวลา + signal ที่ 2, uncaught `on` + ชื่อ class, clientError แยก request ปัจจุบัน/ก่อนหน้า (เขียน 400 หลัง response ก่อนหน้าเสร็จ), subprotocol `webhub.v1`, log status จริง, reload error ไม่กลบ, residual tossing → test-4 |
| 2026-11-08 | W3 รอบ 4 review | review-4 (P1–P5), security-4 (Q1, Q3 major latent; Q2, Q4 minor) → ถามผู้ใช้ |
| 2026-11-08 | W3 รอบ 5 | ผู้ใช้: Q1 เป็นข้อกำหนด F-009/F-004, Q3 ตอบครั้งเดียว + หยุดอ่าน, แก้ทั้งหมด → `deferred` WeakSet + `socket.pause()`, `closeBounded` (ปิด listener บังคับ, ใช้ทั้ง stop และ start error), `main()` ออกเมื่อไม่ clean, client settle + `upgrade`, L5 test เข้ม, wording P4/P5 → test-5 |
| 2026-11-08 | W3 รอบ 5 review | review-5 (R1 major, R2 minor, R3–R4 nit), security-5 (S1 critical = R1, S2 info) → ถามผู้ใช้ |
| 2026-11-08 | W3 รอบ 6 | ผู้ใช้: S1 = end + destroy + timer สำรอง, แก้ทั้งหมด → `writeClientError` destroy หลัง flush (+2 วิ), `waitForResponses` รอ response ค้างทุกตัว, test R1–R4 (fixture `hang-close-daemon.mjs`) → test-6 |
