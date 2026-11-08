# webhub — Design v9

ศูนย์รวม website ทุกตัวใน **scan roots ที่ผู้ใช้ตั้ง** (เครื่องผู้พัฒนา: `E:\Workspaces\Project`) — เป็นเครื่องมือทั่วไปใช้กับ project ของใครก็ได้:
scan หา project ที่เป็นเว็บ (ทุกภาษา) → start/stop ให้ → route ผ่าน nginx ไป `http://<name>.localhost` → **แก้ port ได้ทุกตัว** → **รวม database ทุก project ไว้ที่ server เดียว** → **จัดการ SQL / NoSQL / Redis ได้ครบ** — โดย **ไม่แตะ project เลย**

> เอกสารประกอบ: [Workflow + กฎ](docs/WORKFLOW.md) · [Plan](docs/PLAN.md) · [Features](docs/features/README.md) · [Reports](docs/reports/README.md)

---

## 0. Decisions

> **หลักการสูงสุด — Zero-touch:** project ทุกตัวต้อง **เหมือนเดิม 100%** (ไม่แก้ code, `.env`, `vite.config`, `docker-compose.yml`, `package.json` ฯลฯ). ทุกอย่างที่ต่างไปตอนรันผ่าน webhub (port, env, URL, DB, args, host header) ทำผ่าน **ชั้นนอก** เท่านั้น: process env, CLI args, compose override file, nginx, ไฟล์ใน `$WEBHUB_HOME/data/`. ถอด webhub ออก → project รันแบบเดิมได้ทันที. สิ่งที่ทำผ่านชั้นนอกไม่ได้ → webhub **แจ้งข้อจำกัด** ไม่ไปแก้ project

| เรื่อง | ตัดสินใจ |
|---|---|
| งานหลัก | **Launcher + Router**: start/stop project เอง + route ไป `<name>.localhost` |
| Port | **แก้ได้ทุก port** (web, api, db, nginx, dashboard) ผ่าน dashboard/CLI, Port Map รวม + เช็คชน + rollback |
| Env / URL | env ตั้งผ่าน webhub, **Env Sets** (เช่น `local`/`remote`) สลับได้, **URL Rewrite** เสนอแล้วกดยืนยัน |
| Database | **Shared Infra**: postgres / mysql / mariadb / mongo / redis — **1 server ต่อ engine ต่อ major** (ปกติ engine ละตัวเดียว), แต่ละ site ได้ database + user ของตัวเอง; ต่อ site เลือก `shared` / `isolated` / `external` |
| DB tools | **DB Studio** ในตัวที่ `db.localhost`: SQL (pg/mysql/mariadb/sqlite), MongoDB, Redis — browse/edit/query/schema/import-export + guard กันพลาด; ระหว่างสร้าง Studio เปิด **CloudBeaver / RedisInsight** (connection อัตโนมัติ) ให้ใช้ได้ครบตั้งแต่ Data Hub phase (MVP-5); **mongo-express** มาพร้อม Mongo infra (phase 8) |
| ภาษา | **Runtime Profiles** แบบ data-driven (YAML) — built-in หลายภาษา + เพิ่มเองได้ไม่ต้องแก้ code |
| ที่เก็บ config | รวมใน `$WEBHUB_HOME` (default `%APPDATA%\webhub`; ระหว่างพัฒนาตั้ง `WEBHUB_HOME` เป็นโฟลเดอร์นอก scan root เช่น `%APPDATA%\webhub-dev`) — `data/`, `runtimes/`, `logs/`, `nginx/`, `docker/` (generated) — path relative ใน config = relative กับ `$WEBHUB_HOME` (§21.4) |
| Docker project | `docker compose` ด้วย **project name เดิม** + override file; adopt container ที่รันอยู่แล้ว |
| Hot reload | compose ที่ mount source → default `hybrid` (app native); compose ที่ build image → compose + Rebuild; polling เป็น fallback |
| Non-docker | dev mode native ด้วย runtime จาก Runtime Manager (ของเครื่อง หรือ portable); ทำไม่ได้ → `container` |
| Routing backend | **path บน origin เดียวเป็นหลัก** (`/api/`, `/socket.io/`…, `strip` ต่อ route), สลับเป็น subdomain `api.<site>.localhost` ได้ |
| Shared backend | backend ที่ serve หลาย site (Backend-Hobby) = **shared service** + `dependsOn` |
| Start mode | ต่อ site: `manual` / `auto` / `on-demand` |
| เพิ่ม project | scan → `pending` → กด Enable / Ignore |
| Interface | Dashboard + CLI (CLI คุยผ่าน API ของ daemon); daemon auto-start ตอน login (Task Scheduler, ไม่ต้อง admin) + tray icon |
| Dev services | **Mailpit** (mail catcher) + **MinIO** (S3) เป็น shared infra แบบ optional, inject env ให้ site ที่ใช้ (§5.8) |
| Operations | CPU/RAM ต่อ site, แจ้งเตือน crash, backup ตามเวลา + retention, cleanup ของที่ webhub สร้าง, export/import config (§20) |
| Security | API bind `127.0.0.1`, Host/Origin check, **token อัตโนมัติ** ใน cookie; static deny-list |
| nginx | Docker container, resolve upstream ตอน request |
| API tools | **API Studio** ในตัว (แบบ Postman) ผูกกับ site: base URL/env อัตโนมัติ, import OpenAPI/cURL/Postman, REST/GraphQL/WebSocket/socket.io/SSE, ดูผลกระทบใน DB/Redis; เสริม **Hoppscotch** self-hosted ได้ (§22) |
| Version ภาษา | **Runtime Manager**: detect version ที่ project ต้องการ → ใช้ของบนเครื่องถ้าผ่าน range, ไม่ผ่าน → โหลด portable เก็บใน `$WEBHUB_HOME/runtimes/` (ไม่ admin, ไม่แตะ PATH ระบบ), ทำไม่ได้ → `container` (§19.1) |
| Version DB | **server ต่อ major**: pg/redis default ย้ายไป major `default` ที่ตั้งใน config ตัวเดียว, mysql/mongo default pin major เดิม, ทุก site pin ได้ (site ที่ pin major เดียวกันแชร์ server), ห้าม downgrade (§19.2) |
| Redis engine | `redis:7` default, สลับเป็น **Valkey** ได้ใน config (§19.3) |
| Stack ของ webhub | Node + TypeScript (Fastify + Vite/React) |
| ใช้กับ project ใดก็ได้ | ไม่มีอะไรผูกกับ project/path ของผู้พัฒนา; detect ไม่ได้ → **Add site manual** + แก้ทุก field ได้ (§21.3) |
| OS | **Windows ก่อน** แต่ทุกอย่างที่ขึ้นกับ OS ผ่าน **Platform layer** → เพิ่ม macOS/Linux ทีหลังไม่ต้องรื้อ (§21.1) |
| ไม่มี Docker | **Lite mode**: proxy ในตัว (Node) แทน nginx, รัน static/native ได้, DB แค่ external/SQLite; มี Docker → Full mode (§21.2) |
| Distribution | **npm package** (`npm i -g webhub`) ก่อน, single binary ทีหลัง; first-run wizard (§21.4) |

สภาพเครื่อง (2026-11-07): Node 24.20, Bun 1.3.11, pnpm 12.9.1, Python 3.14.3, Docker 29.3.1 + Compose 5.1.1, ไม่มี `trunk`; port 80/443/8080 ว่าง; Windows excluded TCP ranges `50000–50059`, `54288`, `62828–63127`, dynamic range `49152–65535`

---

## 1. Goals

- Scan ลึก 3 ชั้น → จำแนกเว็บ + runtime profile → `pending` รอยืนยัน
- รันได้ 5 แบบ: `static` / `native` / `compose` / `hybrid` / `container`
- **Port Map**: เห็นทุก port ที่ webhub คุม + port ที่ OS/process อื่นใช้/จอง, แก้ได้ทุกตัว, เช็คชนก่อน apply
- **Env & URL**: แก้ env ต่อ site, หลาย env set, rewrite URL ที่ชี้ port เดิมให้เป็น `<site>.localhost`
- **Data Hub**: DB server กลาง (engine ละชุด, แยกเฉพาะ major ที่จำเป็น), provision database/user ต่อ site, import จาก DB เดิม, backup/restore
- **DB Studio**: เครื่องมือ SQL / MongoDB / Redis ครบในตัว
- **Multi-language**: Node, Bun, Deno, Python, PHP, Ruby, Go, Rust, Java, .NET, Elixir, SSG + custom profile; version ภาษาไม่ตรงก็รันได้ (Runtime Manager)
- Gen nginx config ต่อ site → validate → reload (site หนึ่งพังไม่ลากทั้งระบบ)
- Dashboard + CLI ทำได้เท่ากัน; ปลอดภัยจากเว็บอื่นใน browser

Non-goals (MVP): SSL จริง, deploy ขึ้น server, multi-machine, production build

---

## 2. Architecture

```
                 ┌──────────────────────── webhub core (Node, host, daemon) ─────────────────────┐
 Project/ ──────►│ Scanner → Detector ──(profiles/*.yml)──► Registry (data/)                    │
   (read-only)   │                                             │                                 │
                 │   ┌──────────┬───────────┬───────────┬──────┼──────┬───────────┬───────────┐  │
                 │   ▼          ▼           ▼           ▼      ▼      ▼           ▼           ▼  │
                 │ Port      Env/URL     Infra       Nginx   Runners  Supervisor  DB Studio  API │
                 │ Manager   Resolver    Manager     Gen     +Runtime (modes)     backend   :7400│
                 │                       (Data Hub)          Manager                 127.0.0.1  │
                 └──────────────────┬───────────────┬───────────────┬────────────────────────────┘
                                    │               │               │  ▲ CLI (token)
        ┌───────────────────────────▼──┐   ┌────────▼───────────────────────────────┐
        │ webhub-nginx :80             │   │ webhub-infra (docker network "webhub") │
 browser│  <site>.localhost → app      │   │  webhub-postgres-17  webhub-redis-7    │
 ──────►│  hub.localhost → :7400       │   │  webhub-mysql-<M>    webhub-mongo-<M>  │
        │  db.localhost  → :7400/studio│   │  (optional) mailpit, minio,            │
        │                              │   │   cloudbeaver, redisinsight            │
        │  resolver 127.0.0.11         │   └────────────────────────────────────────┘
        └──────────────────────────────┘                ▲ network "webhub"
                 │ host.docker.internal                 │
                 ▼                                      │
        native dev servers :41xx        compose project containers (joined to "webhub")
```

| Module | หน้าที่ |
|---|---|
| Scanner | เดิน folder (read-only), skip ignore list, ตรวจ project ซ้อน/ซ้ำ |
| Detector | match Runtime Profiles → profile, services, routes (prefix/socket), port เดิม + วิธีรับ port, DB, env ที่เป็น URL |
| Registry | `data/sites/<name>.json`, `data/ports.json`, `data/infra.json`, `data/state.json` (เขียนผ่าน daemon เท่านั้น) |
| Port Manager | จอง/แก้/ล็อก port, probe 3 ชั้น (§4.3), apply + rollback |
| Env/URL Resolver | รวม env ตาม precedence + env set + URL rewrite + DB connection → inject |
| Infra Manager | start shared engines (ต่อ major), provision, import/backup/restore, upgrade/pin major, optional services (Mailpit, MinIO, CloudBeaver, RedisInsight) |
| Nginx Generator | template → temp → `nginx -t` → swap → reload; fail = คง config เดิม |
| Runners | รัน site ตาม runner (§7), adopt container/process ที่รันอยู่ |
| Runtime Manager | detect version ภาษาที่ต้องการ → system / portable (`runtimes/`) / container (§19.1) |
| Supervisor | start modes, `dependsOn`, idle stop, restart/backoff, health check |
| DB Studio backend | `DbAdapter` ต่อ engine + guard (§5.7) |
| API + Dashboard | Fastify REST + WS ที่ **7400** bind `127.0.0.1` (ย้ายจาก 4000 เพราะชน werewolf backend), auth §10.3 |

---

## 3. nginx ใน Docker

```yaml
# generated → $WEBHUB_HOME/docker/nginx.compose.yml (template อยู่ใน package; mount เป็น absolute path ทั้งหมด)
services:
  nginx:
    image: nginx:1.27-alpine
    container_name: webhub-nginx
    ports: ["127.0.0.1:80:80"]                  # host port จาก Port Map; `expose: lan` → 0.0.0.0 (§10.3)
    volumes:
      - ${WEBHUB_HOME}/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ${WEBHUB_HOME}/nginx/sites:/etc/nginx/sites:ro
      - ${WEBHUB_HOME}/nginx/webhub:/etc/nginx/webhub:ro   # proxy.conf (header ชุดเต็ม, §10.2)
      - ${WEBHUB_HOME}/nginx/errors:/etc/nginx/errors:ro   # หน้า 502/503/504 ของ webhub
      - E:/Workspaces/Project:/projects/0:ro    # generated: 1 บรรทัดต่อ scan root (`/projects/<index>`)
      - ${WEBHUB_HOME}/logs/nginx:/var/log/nginx
    extra_hosts: ["host.docker.internal:host-gateway"]
    networks:
      webhub:
        aliases: [pos.localhost, questcloud.localhost]   # generated: ทุก site ที่ enabled (§10.1)
    restart: unless-stopped
networks:
  webhub: { external: true }
```

- native app → `host.docker.internal:<port>`; compose app (join network `webhub`) → proxy ด้วยชื่อ container ตรง
- **resolve upstream ตอน request** (`resolver 127.0.0.11` + ตัวแปร) → container ที่ยังไม่รันไม่ทำให้ nginx ทั้งตัวพัง (§10.2)
- Static → `root /projects/<rootIndex>/<folder>/<publicDir>` + deny-list (§10.4)
- ไฟล์นี้ **generate จาก `scanRoots`** (ไม่ hardcode path); เพิ่ม/ลบ root → regen + restart nginx
- ผล spike (§18) เป็นของ Docker Desktop บน Windows — Linux ใช้ topology ต่าง (§21.1)
- HTTP port (80) แก้ได้ใน Port Map → regen + restart nginx (port ≠ 80 → §10.1)
- publish ที่ `127.0.0.1` เสมอ (ไม่เปิด LAN); เปิด LAN ได้เฉพาะผู้ใช้ตั้ง `nginx.http.expose: lan` + บังคับ password (§10.3)

---

## 4. Port Management

### 4.1 Port Map — ทุก port อยู่ที่เดียว

`data/ports.json` เป็น source of truth:

```json
{
  "system": {
    "nginx.http":     { "port": 80,   "locked": true },
    "dashboard":      { "port": 7400, "locked": true },
    "infra.postgres-17": { "port": 5432 },
    "infra.redis-7":     { "port": 6379 },
    "infra.mailpit":     { "port": 8025, "smtp": 1025 },
    "infra.minio":       { "port": 9000, "console": 9001 }
  },
  "sites": {
    "pos": {
      "frontend": { "port": 4105, "target": 4105, "via": "arg", "portArg": "--port {PORT} --strictPort", "expose": "host", "note": "native: CLI ทับ server.port ใน vite.config" },
      "backend":  { "port": 4106, "target": 4106, "via": "env", "portEnv": "BACKEND_PORT", "expose": "host", "note": "native: webhub ตั้ง BACKEND_PORT=port" }
    },
    "backend-hobby": {
      "api": { "port": 3000, "target": 3000, "via": "fixed", "expose": "host", "note": "native: port = target บังคับ" }
    }
  }
}
```

| Field | ความหมาย |
|---|---|
| `port` | port บน host (แก้ได้), `null` = ไม่ publish |
| `target` | port ที่ app ฟังจริง (ใน container หรือ process) |
| `via` | app รับ port ทางไหน: `env` (+`portEnv`), `arg` (+`portArg` เช่น `--port {PORT}`), `fixed` (hardcode ใน code/config) |
| `expose` | default `host` ทั้ง site และ `system.*` (nginx/infra/เครื่องมือเสริม publish ที่ 127.0.0.1). **compose/container:** `host` = publish `127.0.0.1:<port>`, `lan` = `0.0.0.0`, `none` = ภายใน network `webhub` เท่านั้น. **native:** webhub คุมได้แค่ args/env (`--host`, `HOST`) — app ที่ bind `0.0.0.0` ใน code → เสนอ Windows Firewall rule กัน LAN (admin) |
| `locked` | ห้าม auto-reassign |

**native ทุกแบบ:** process ฟังบน host ตรง → `target` = `port` เสมอ (`via: env|arg` → webhub ส่ง port ใหม่ให้, `target` ตามไปด้วย). **`via: fixed` + native:** port บน host = target เสมอ → แก้ไม่ได้, รันพร้อม site อื่นที่ใช้ port เดียวกันไม่ได้ → Port Map ติดป้าย + เสนอสลับเป็น `container` runner (map port ได้)

### 4.2 Default ranges (แก้ได้ใน global config)

| ช่วง | ใช้กับ |
|---|---|
| `80` | nginx |
| `7400` | dashboard/API |
| `4100–4999` | web/api ของ site |
| `14100–14999` | infra แบบ `isolated` ต่อ site |
| ค่ามาตรฐาน: pg 5432, mysql 3306, **mariadb 3307**, mongo 27017, redis 6379 | shared infra major default (ของแต่ละ engine) |
| `15000–15999` (จัดสรร port ว่างถัดไป เช่น pg 15 → `15000`) | shared infra major อื่นที่ถูก pin |
| `1025`/`8025`, `9000`/`9001` | Mailpit (SMTP/UI), MinIO (API/console) |

### 4.3 แก้ port — flow + probe

```
user แก้ port (dashboard / `webhub port pos frontend=4200`)
  → validate
      1. อยู่ใน 1–65535, ไม่ซ้ำใน registry, ไม่ใช่ `via: fixed` + native
      2. ไม่อยู่ใน Windows excluded range (`netsh int ipv4 show excludedportrange`, refresh ทุก start)
      3. ไม่มี process ถือ (`Get-NetTCPConnection` → PID + ชื่อ process)
      4. bind จริงได้ (`net.createServer` แล้วปิด)
  → preview: ไฟล์ที่จะเปลี่ยน (nginx conf, compose override, env, URL rewrite ที่อ้าง port นี้), site ที่ต้อง restart/rebuild
  → apply: เขียน registry → regen → restart เฉพาะส่วนที่กระทบ → health check
  → fail: rollback ค่าเดิมอัตโนมัติ
```

- Port Map page: ตารางรวม + filter + ไฮไลต์ชน + ป้าย "Windows reserved" / "fixed" + ปุ่ม Find free port
- ตอน start webhub: dynamic port range เริ่ม < 10000 → เตือน + แนะนำคำสั่ง `netsh` (ไม่รันเอง); option จองช่วง webhub ล่วงหน้าด้วย `netsh int ipv4 add excludedportrange` (admin)

### 4.4 Compose override

```yaml
# webhub:auto — generated → data/compose/<site>.<group>.override.yml
services:
  app:
    container_name: !reset null              # PPRS hardcode container_name
    ports: !override ["127.0.0.1:4110:3000"]  # PPRS: host 4110 → container 3000
    environment: { ... }                     # env set + URL rewrite + DB (§5.4)
    # <site>.localhost → resolve เป็น nginx ผ่าน network alias บน `webhub` (§3) — ไม่ต้องใส่ extra_hosts ต่อ site
    networks:
      default: {}
      webhub: {}
networks:
  webhub: { external: true }
```

รัน: `docker compose -f <project compose> -f $WEBHUB_HOME/data/compose/<site>.<group>.override.yml up -d` (cwd = dir ของ compose file; path override เป็น absolute)
- **ใช้ project name เดิม** → volume/network เดิมยังอยู่, container ที่ผู้ใช้รันเองคือชุดเดียวกัน. หา name ด้วย `docker compose config --format json` (`.name`) → ได้ลำดับเดียวกับ compose: `COMPOSE_PROJECT_NAME` (env/`.env` ของ dir) → top-level `name:` → ชื่อโฟลเดอร์
- **compose หลายไฟล์คนละ dir** (questcloud: `questcloud-frontend/` + `questcloud-backend/`) → **1 compose project ต่อ dir (group)**: override + project name แยกกัน, start/stop/adopt ทีละ group; `-f` รวมกันเฉพาะไฟล์ใน dir เดียวกัน
- container ใน network `webhub` เรียก `<site>.localhost` → ถึง nginx ผ่าน alias (spike ยืนยันแค่แบบ `extra_hosts` → alias ต้อง spike ซ้ำใน MVP-4; ไม่ผ่าน → fallback `extra_hosts` ต่อ site)
- ใส่ `-p` เฉพาะตอนชื่อโฟลเดอร์ซ้ำกันจริง (เตือนว่าได้ volume ใหม่)
- `container_name` ที่ถูก reset แต่มี env อ้างชื่อเดิม (เช่น `DB_HOST=pos_db`) → ใส่ `networks.default.aliases: [pos_db]` ให้ service นั้น
- **Adopt**: อ่าน `docker compose ls` + label `com.docker.compose.project.working_dir` → container ที่รันจาก folder ของ site อยู่แล้ว = running (ไม่ start ซ้ำ)

---

## 5. Data Hub — รวม Database เป็นที่เดียว

### 5.1 แนวคิด

เดิม: ทุก project ยก postgres/redis ของตัวเอง → ชน port, กิน RAM, ข้อมูลกระจาย
ใหม่: **webhub-infra** มี engine ละ 1 ตัว (แยกเพิ่มเฉพาะ major ที่ถูก pin — §19.2) → แต่ละ site ได้ **database + user แยก** ใน server เดียว

```
webhub-postgres-17
├── db: pos            user: pos
├── db: werewolf       user: werewolf
├── db: herotime       user: herotime
├── db: cloudvps       user: cloudvps
└── db: questcloud     user: questcloud
webhub-redis-7
├── db 0: herotime     (REDIS_URL → /0)
├── db 1: werewolf     (REDIS_URL → /1)
└── cloudvps, questcloud → ใช้ REDIS_HOST/PORT แยกกัน ระบุ db index ไม่ได้ → isolated (§5.3)
```

### 5.2 Engines

| Engine | Image | แยกต่อ site ด้วย |
|---|---|---|
| PostgreSQL | `postgres:17` | database + role (owner, `CREATEDB` สำหรับ Prisma shadow DB) |
| MySQL | `mysql:<major>` (default 8.4) | database + user (GRANT ON db.*) |
| MariaDB | `mariadb:<major>` (engine แยกจาก MySQL) | database + user |
| MongoDB | `mongo:<major>` (default 7) | database + user |
| Redis / Valkey | `redis:7` (หรือ `valkey/valkey:8`) | DB index 0–15 — **เฉพาะ app ที่รับ `REDIS_URL` (ใส่ user/password/index ได้ครบ) หรือมี env key ของ username**; ใช้แค่ `REDIS_HOST/PORT/DB` (ไม่มี username → ACL ต่อ site ใช้ไม่ได้), เกิน 16 site หรือระบุ index ไม่ได้ → `isolated`. user `default` ปิดใน shared redis. index **ไม่ใช่ security isolation** (site เข้าถึง index อื่นได้) → พอสำหรับ dev เท่านั้น |
| SQLite | — | ไฟล์อยู่ใน project, Data Hub/Studio แค่ list/เปิด/backup |

เปิดเฉพาะ engine ที่มี site ใช้ (lazy start); **1 server ต่อ engine ต่อ major** ที่มี site ใช้จริง — policy version ดู §19.2

### 5.3 Mode ต่อ site

| Mode | พฤติกรรม |
|---|---|
| `shared` (default) | ใช้ webhub-infra; ปิด DB service ใน compose ของ project ผ่าน override |
| `isolated` | ใช้ DB ใน compose เดิม แต่ remap port เข้าช่วง `14100–14999` |
| `external` | ผู้ใช้ใส่ connection string เอง (เช่น cloud DB) |

Detector ตัดสิน default ต่อ engine: redis ที่ระบุ index ไม่ได้, version/extension พิเศษ (postgis, pgvector), DB host hardcode ใน code → `isolated`. เปลี่ยนกลับ shared ↔ isolated ได้ (export/import ให้)

ปิด DB service เดิมใน override:
```yaml
services:
  db:
    profiles: ["webhub-disabled"]          # ไม่ถูกรัน
  app:
    depends_on: !override                  # gen ใหม่ให้ทุก service ที่พึ่ง service ที่ถูก disable: ตัดตัวที่ disable, คงตัวอื่น
      redis: { condition: service_started }
    environment:
      DATABASE_URL: postgres://pos:<pw>@webhub-postgres-17:5432/pos
```
- service ที่พึ่ง DB ที่ถูก disable แต่ไม่ใช่ app (เช่น `pgadmin`) → disable ตามด้วย (DB Studio แทน) หรือ override `depends_on` เหมือน app — ไม่งั้น compose error เพราะอ้าง service ที่ไม่ถูกรัน

### 5.4 Env injection

Detector หา env ที่เกี่ยวกับ DB (`DATABASE_URL`, `POSTGRES_*`, `DB_HOST`, `REDIS_URL`, `REDIS_HOST/PORT/PASSWORD`, `MONGO_URI`, `MYSQL_*`…) → webhub เขียนค่าทับให้ (`dbEnv` แก้ได้ต่อ site)

| รันแบบ | host ที่ inject |
|---|---|
| compose / container (join network `webhub`) | `webhub-postgres-<major>:5432` |
| native | `127.0.0.1:<infra.postgres-<major> port>` |

### 5.5 Provision + Import

```
enable site (mode shared)
  → detect engine จาก compose image / deps (pg, prisma, mysql2, mongoose, ioredis, psycopg, sqlalchemy…)
  → CREATE ROLE (CREATEDB) + DATABASE (password สุ่ม → data/secrets.json)
  → มี init script ใน compose (เช่น werewolf `./backend/db/init.sql` → docker-entrypoint-initdb.d) → รันให้
  → มีข้อมูลใน volume เดิมของ project (ชื่อ volume ตาม project name เดิม)? → เสนอ "Import":
       start DB เดิมชั่วคราวใน network ภายใน (ไม่ publish port) → pg_dump --no-owner --no-acl / mysqldump / mongodump
       → restore เข้า shared → ตรวจ row count → ปิด DB ชั่วคราว
  → volume เดิม **ไม่ลบอัตโนมัติ** (ปุ่มลบหลัง import สำเร็จ)
  → migration/seed (prisma migrate, alembic, artisan…) ปุ่มกดเองใน dashboard
```

### 5.6 Data Hub overview

- list ทุก database ทุก engine + ขนาด + site เจ้าของ + mode + connection string
- Backup ทั้งหมด/ต่อ site → `data/backups/<engine>/<site>-<date>.<ext>`; restore, clone (`pos` → `pos_test`), reset
- Connections: shared (auto), isolated DB ของ site (auto), external (เพิ่มเอง: host/port/user/SSL/SSH tunnel)
- ต่อยอด: query ข้าม site ผ่าน `postgres_fdw`

### 5.7 DB Studio — เครื่องมือจัดการ DB ครบในตัว

ที่ `db.localhost` (หรือแท็บ Data Hub). Connection ของทุก site เพิ่มให้อัตโนมัติ ไม่ต้องกรอก password. ใช้ auth เดียวกับ dashboard (§10.3)

**Engine:** PostgreSQL, MySQL, MariaDB, SQLite, MongoDB, Redis/Valkey (ต่อยอด: MSSQL, ClickHouse ผ่าน adapter); รองรับหลาย version ด้วย capability flags (§19.4)

#### SQL (Postgres / MySQL / SQLite)
| หมวด | Feature |
|---|---|
| Browser | tree: connection → database → schema → tables / views / functions / sequences / triggers; search object |
| Data grid | pagination, filter/sort ต่อ column, **แก้ cell / เพิ่ม / ลบ row** (pending changes → Save = 1 transaction), ดู JSON/bytea/array |
| SQL editor | Monaco, **autocomplete** จาก schema จริง, หลาย tab, run selection / run all, หลาย result set, format |
| Query tools | history, saved queries/snippets, parameter `:name`, **EXPLAIN / EXPLAIN ANALYZE** เป็น tree, เวลา + rows affected |
| Schema | create/alter table (UI → gen DDL ให้ดูก่อนรัน), column/index/FK/constraint, ดู DDL, **ER diagram** |
| Transaction | auto-commit on/off, BEGIN/COMMIT/ROLLBACK |
| Import/Export | CSV / JSON / SQL insert / Excel; dump & restore |
| Admin | users/roles/grants, active sessions + kill, ขนาด table/index, vacuum/analyze (pg) |

#### MongoDB
| หมวด | Feature |
|---|---|
| Browser | database → collections → indexes, ขนาด + doc count |
| Documents | table / JSON tree, **แก้ document (JSON editor + validate)**, insert/clone/delete |
| Query | filter/projection/sort builder + raw, **aggregation pipeline builder** (preview ทีละ stage), explain |
| Schema | วิเคราะห์ field/type จาก sample, index create/drop |
| Import/Export | JSON / CSV, mongodump/mongorestore |

#### Redis
| หมวด | Feature |
|---|---|
| Key browser | tree แยก namespace ด้วย `:`, SCAN แบบ pattern (ไม่ใช้ `KEYS *`), filter ตาม type, เลือก DB index |
| Value editor | string / hash / list / set / zset / stream / JSON: ดู + แก้ + เพิ่ม/ลบ member |
| TTL | ดู / ตั้ง / ลบ expire, rename, duplicate |
| Console | Redis CLI ในหน้าเว็บ + autocomplete |
| Monitor | Pub/Sub live, MONITOR (จำกัดเวลา), SLOWLOG, INFO/memory, memory usage ต่อ key |
| Bulk | ลบตาม pattern (preview ก่อน), export/import keys |

#### Guard (ทุก engine)
- Connection ตั้ง **read-only** ได้; external default read-only
- คำสั่งอันตราย (`DROP`, `TRUNCATE`, `DELETE/UPDATE` ไม่มี `WHERE`, `dropDatabase`, `FLUSHDB/FLUSHALL`, ลบ key ตาม pattern) → **พิมพ์ชื่อ DB ยืนยัน**
- ก่อนคำสั่งอันตรายบน shared DB → snapshot backup อัตโนมัติ (ปิดได้)
- statement timeout + row limit default (30s / 1,000 rows) ปรับได้
- Audit log query ที่แก้ข้อมูล → `logs/db-audit.log`
- shared redis: ACL user ต่อ site (`REDIS_URL=redis://<site>:<pw>@…/N`) ตัด `FLUSHALL` / `FLUSHDB` / `CONFIG` / `SHUTDOWN` / `KEYS` (กัน app ล้างของ site อื่น; ACL กันข้าม index ไม่ได้); DB Studio ใช้ admin user → `FLUSHDB` เฉพาะ index ของ site ได้หลังยืนยัน, `FLUSHALL` บน shared ปิด (ไม่ใช้ `rename-command` เพราะจะใช้ไม่ได้ทั้ง server)

#### Implementation
- Backend: `pg`, `mysql2`, `better-sqlite3`, `mongodb`, `ioredis`; interface `DbAdapter` (introspect / query / editRows / export) → engine ใหม่ = adapter ใหม่
- Frontend: Monaco, virtualized grid (TanStack Table / AG Grid community), ER diagram ด้วย React Flow
- Streaming result ผ่าน WebSocket

#### เครื่องมือเสริม (เปิดได้ตั้งแต่ Data Hub phase)
webhub รัน container + เพิ่ม connection ทุก site ให้เอง (เข้าผ่าน nginx + auth เดียวกับ dashboard): **CloudBeaver** → `sql.localhost`, **RedisInsight** → `redis.localhost`, **mongo-express** → `mongo.localhost` (พร้อม Mongo infra, phase 8). ทำให้ได้เครื่องมือ SQL/NoSQL/Redis ครบตั้งแต่ต้น ระหว่าง DB Studio ของเราทยอยทำ (v1 → v2); ปิดได้เมื่อ Studio ครอบคลุมแล้ว

### 5.8 Dev services (optional shared)

| Service | ใช้แทน | inject env |
|---|---|---|
| **Mailpit** (`axllent/mailpit`) → `mail.localhost` | SMTP จริง (cloudvps/questcloud มี `EMAIL_HOST`/`EMAIL_PORT`) | `EMAIL_HOST`/`SMTP_HOST` = `webhub-mailpit` หรือ `127.0.0.1`, port `1025`; ตรวจ key จาก detector, เสนอแล้วกดยืนยันแบบ URL rewrite |
| **MinIO** → `s3.localhost` (console) | volume `uploads` / S3 จริง (herotime) | bucket ต่อ site + access key ต่อ site; `S3_ENDPOINT`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`… ตาม key ที่ detect เจอ |

เปิดต่อ site (default ปิด); ไม่มี key ให้ inject → ไม่เสนอ

---

## 6. Multi-language — Runtime Profiles

### 6.1 Profile format

`profiles/<id>.yml` (built-in) + `data/profiles/*.yml` (ผู้ใช้เพิ่ม/ทับ)

```yaml
id: python-fastapi
language: python
detect:
  all:  [{ file: "requirements.txt|pyproject.toml" }]
  any:  [{ fileContains: ["requirements.txt|pyproject.toml", "fastapi|uvicorn"] }]
  score: 60
runtime:
  lang: python                                   # Runtime Manager เลือก version (§19.1)
  install: "pip install -r requirements.txt"   # ลง venv ที่ data/venvs/<site>/ (ไม่สร้างใน project)
start:
  cmd: "uvicorn {module}:app --reload --host {HOST} --port {PORT}"
  vars: { module: "main" }                       # แก้ได้ต่อ site
port:
  default: 8000
  via: arg                                       # env | arg | fixed
host:
  bind: "127.0.0.1"     # spike ยืนยัน: nginx container เข้าถึง host 127.0.0.1 ผ่าน host.docker.internal ได้ → ไม่เปิด LAN, ไม่มี Firewall popup
devServer:
  hostRewrite: false    # true สำหรับ vite/next: nginx ส่ง Host: localhost:<port> (แทนการแก้ allowedHosts)
health: { path: "/docs", timeout: 60 }
container:                                       # fallback ถ้าเครื่องไม่มี runtime
  image: "python:3.12-slim"
  workdir: /app
  setup: "pip install -r requirements.txt"
db:
  hints: ["psycopg", "sqlalchemy", "asyncpg", "redis"]
routes:
  detectPrefix: ["APIRouter(prefix=", "app.mount("]   # หา prefix จาก code
```

### 6.2 Built-in profiles (เป้าหมาย)

| Language | Profiles | Start (สรุป) |
|---|---|---|
| Static | `static`, `static-spa` | nginx serve ตรง |
| Node | `vite`, `next`, `nuxt`, `sveltekit`, `astro`, `angular`, `cra`, `express`, `nestjs`, `fastify`, `koa` | `npm/pnpm/yarn run dev` (ตาม lockfile) + `--port {PORT}` |
| Bun | `bun-elysia`, `bun-hono`, `bun-generic` | `bun run --watch <entry>`, `PORT` (หรือ `fixed` ถ้า `.listen(N)`) |
| Deno | `deno-fresh`, `deno-generic` | `deno task dev` |
| Python | `django`, `flask`, `fastapi`, `streamlit`, `gradio` | `manage.py runserver {HOST}:{PORT}`, `flask run`, `uvicorn` … (venv ใน project มีอยู่แล้ว → ใช้แบบอ่านอย่างเดียว, ไม่มี → `data/venvs/<site>/`) |
| PHP | `laravel`, `php-plain`, `wordpress` | `php artisan serve`, `php -S {HOST}:{PORT}`; ไม่มี php → container `php:8.3-apache` |
| Ruby | `rails`, `sinatra` | `bin/rails s -b {HOST} -p {PORT}` |
| Go | `go-generic` (gin/echo/fiber/chi) | `go run .` หรือ `air`, `PORT` |
| Rust | `rust-axum`, `rust-actix`, `rust-trunk` | `cargo run`, `trunk serve --port {PORT}` |
| Java/Kotlin | `spring-boot`, `quarkus` | `mvnw spring-boot:run` / `gradlew bootRun`, `SERVER_PORT` |
| .NET | `aspnet` | `dotnet watch run --urls http://{HOST}:{PORT}` |
| Elixir | `phoenix` | `mix phx.server`, `PORT` |
| SSG | `hugo`, `jekyll`, `eleventy` | `hugo server -p {PORT}` … |
| Generic | `dockerfile` | build + run Dockerfile, map `EXPOSE` |

script ใน `package.json` ที่ hardcode port (เช่น `next dev --port 3001`) → profile เรียก binary ตรงด้วย args ของ webhub (`next dev -p {PORT}`) แทน `npm run dev` — ไม่แก้ `package.json`

### 6.3 ตัดคะแนน (ไม่ใช่เว็บ)

`manifest.json` (browser extension), `*.rbxl` (Roblox), `*.uproject` (Unreal), `ProjectSettings/` (Unity), `*.csproj` ที่ไม่มี `Microsoft.AspNetCore`, `electron`/`tauri` ใน deps, Python ที่ไม่มี web framework

### 6.4 Runtime check

Dashboard (แท็บ Runtimes) โชว์ runtime บนเครื่อง + ที่ webhub โหลดไว้ + version + site ที่ใช้; site ที่ไม่มี runtime ตรง → Runtime Manager โหลด portable ให้ (§19.1), ภาษาที่ยังไม่รองรับ portable → `container`

---

## 7. Runners

| Runner | ใช้เมื่อ | ทำอะไร |
|---|---|---|
| `static` | static site | nginx serve จาก `/projects/<rootIndex>/<folder>/<publicDir>` ไม่มี process (Lite mode: proxy ในตัว serve ตรงจาก disk) |
| `native` | runtime จาก Runtime Manager (system/portable) | spawn ตาม profile, inject env/port/DB/URL + `PATH` ของ runtime ที่เลือก, เก็บ PID + log |
| `compose` | compose ที่ **build image** (PPRS, cloudvps, questcloud) | override → `compose up -d`; ปุ่ม **Rebuild** + เตือนเมื่อ source/build-time env เปลี่ยน |
| `hybrid` | compose ที่ **mount source + dev server** (werewolf, Pos) หรือ compose มีแค่ infra (herotime) | app → native (hot reload ไว); DB → shared หรือ compose (isolated) |
| `container` | runtime โหลด portable ไม่ได้ / `via: fixed` ที่ต้องรันพร้อมกัน / profile สั่ง | `docker run` image ตาม profile, mount source, map port |

- polling fallback (สลับต่อ site, สำหรับ compose ที่ยังรัน dev ใน container): `CHOKIDAR_USEPOLLING=true`, `WATCHPACK_POLLING=true`, nodemon `-L` (`bun --watch` ไม่รองรับ)
- deps: ไม่มี `node_modules` / venv → เสนอ install ก่อน start (`node_modules` เป็นสิ่งที่ project สร้างเองตามปกติ ไม่นับเป็นการแก้ project)
  - install แบบ **ไม่แตะ lockfile/manifest**: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`; ไม่มี lockfile → `npm install --no-package-lock` / แจ้งว่า pnpm/yarn/bun จะสร้าง lockfile → ผู้ใช้ยืนยันก่อน
  - env ทุก process ที่ spawn: `COREPACK_ENABLE_AUTO_PIN=0` (corepack ไม่เขียน `packageManager` ลง package.json), `PYTHONDONTWRITEBYTECODE=1` (ไม่สร้าง `__pycache__`)
  - output ของ dev server (`.next/`, `node_modules/.vite`, `dist/`) = artefact ที่ project gitignore อยู่แล้ว → นับแบบเดียวกับ `node_modules`
  - **ข้อจำกัดที่รู้แล้ว:** `next dev` เขียน `next-env.d.ts` และอาจแก้ `tsconfig.json` เอง → webhub ตรวจก่อน start (ไฟล์ไม่มี/ไม่ตรง), แจ้งใน run approval; ต้องการ Zero-touch เคร่ง → แนะนำ `container` runner (mount source read-only + overlay)
- Process บน Windows: kill ทั้ง tree (`taskkill /T /F` / `tree-kill`); log → ring buffer + `logs/<site>.log` (rotate)
- **Re-adopt** หลัง webhub restart: ตรวจ PID + command line + port ก่อนถือว่าเป็นของเดิม (กัน PID reuse)

---

## 8. Start Modes + Dependencies

| Mode | พฤติกรรม |
|---|---|
| `manual` (default) | start/stop เอง |
| `auto` | start ตอน webhub เปิด, restart เมื่อ crash (backoff, สูงสุด 3) |
| `on-demand` | เข้า URL ตอนหลับ → หน้า "กำลัง start…" → start → redirect; idle X นาที → stop |

- on-demand: nginx `error_page 502 503 504 = @wake` → `/_wake?site=<name>` บน API; ระหว่าง compose build ครั้งแรก → สถานะ `building` (ไม่ timeout)
- `dependsOn`: start site ที่พึ่งพาก่อน (เช่น wowmusic → backend-hobby), shared infra start อัตโนมัติเมื่อมี site ที่ใช้
- health/readiness: HTTP `health.path` หรือ port เปิด → ค่อยถือว่า `running`

---

## 9. Detection

- Score ≥ 50 = เว็บ (rule มาจาก profile)
- Runner: compose build image → `compose`; compose mount source / infra-only → `hybrid`; ไม่มี compose → `native`; ผู้ใช้สลับได้
- **Monorepo / แยก repo**: sub-folder `frontend|client|web|ui|*-frontend|*-web` + `backend|server|api|*-backend|*-api` → site เดียว (เช่น `cloudvps/cloudvps-frontend` + `cloudvps-backend`)
- **Routes**: หา prefix จาก code (`.group("/api")`, `setGlobalPrefix`, `app.use('/api')`, `APIRouter(prefix=`) → route `strip:false`; ไม่เจอ prefix → `strip:true`; dep `socket.io` / `ws` → เพิ่ม `/socket.io/` (`ws:true`)
- **ซ้อน/ซ้ำ**: project ใน project → ตรวจว่าเป็นสำเนาหรือส่วนประกอบ; สำเนา (`Backend-Hobby/project/PPRS`) → ไม่ขึ้นเป็น site, ติดป้าย `duplicate`
- **Shared service**: backend ที่มี route group ตรงกับ site อื่น (Backend-Hobby `/wowmusic`, `/pprs`) → เสนอเป็น shared service + `dependsOn`
- **Port เดิม + via**: `vite.config` `server.port` (→ `arg`: CLI `--port` ทับได้), `.env` (`*PORT=` → env), compose `ports:` (รวม `${VAR:-default}`), `EXPOSE`, script `--port N` (→ เรียก binary ตรง), `.listen(N)` (fixed)
- **DB**: image ใน compose + deps + env keys; redis ระบุ index ได้ไหม
- **URL env**: ค่าเป็น URL → จัดกลุ่มสำหรับ URL Rewrite (§11.2)
- **publicDir**: `public/` / `dist/` / `docs/` ที่มี `index.html` ไม่งั้น root
- **Runtime version**: `.nvmrc`, `engines`, `packageManager`, `.python-version`, `requires-python`, Dockerfile `FROM` (hint) … (§19.1)
- **Dev services**: env key แนว `EMAIL_HOST`/`SMTP_*`, `S3_*`/`AWS_*` → เสนอ Mailpit / MinIO (§5.8)

### ตัวอย่าง: ผล scan เครื่องผู้พัฒนา (2026-11-07)

> ตารางนี้เป็น **ตัวอย่าง/fixture** สำหรับทดสอบ detector เท่านั้น — design ไม่ผูกกับ project เหล่านี้

| Site | Path | Profile | Runner | Port เดิม (via) | Routes | DB เดิม → mode | หมายเหตุ |
|---|---|---|---|---|---|---|---|
| portfolio | Portfolio | static | static | — | `/` | — | |
| visualengine | visualengine | static | static | — | `/` | — | มี `game/`, `test/` ข้างใน |
| rea-website | REA/website | static | static | — | `/` (publicDir `public/`) | — | root REA เป็น MCP ไม่ใช่เว็บ |
| wowmusic | WowMusic | static + bun-elysia | native | api 3000 (env `PORT`) | `/`, `/wowmusic/` (strip:false) | — | หรือ `dependsOn: backend-hobby` |
| backend-hobby | Backend-Hobby | bun-elysia | native | 3000 (fixed) | `/` | — | **shared service** serve `/wowmusic` + `/pprs` |
| pprs | PPRS | bun-elysia | compose | 3200→3000 (fixed) | `/`, `/api/` (strip:false) | — | `container_name: pprs`; สำเนาใน Backend-Hobby/project |
| pos | Pos_on_website | vite + bun-elysia | hybrid | 5173 (arg), 3000 (env `BACKEND_PORT`) | `/`, `/api/` (strip:true — backend route ที่ `/`) | pg 15 → shared (17); pgadmin → DB Studio | compose mount source |
| werewolf | werewolfofpower | vite + express | hybrid | 5173 (arg), 4000 (env `PORT`) | `/`, `/socket.io/` | pg 16 → shared (17), redis 7 → shared (`REDIS_URL`) | `init.sql`; env set `local`/`remote` (DDNS); Dockerfile `node:20` (hint) |
| herotime | herotime | nestjs (pnpm) | hybrid | 3000 (env `PORT`) | `/` | pg 17 → shared, redis 7 → shared (`REDIS_URL`); uploads → MinIO (option) | server อยู่ใน profile `scale`; `apps/web` build-only |
| cloudvps | cloudvps/* | next + bun-elysia | compose ×2 | 3001 (script → arg), 3000 (env `PORT`) | `/`, `/api/` (strip:false) | pg 15 → shared (17), redis 7 → isolated | redis ใช้ HOST/PORT; email → Mailpit (option); Dockerfile `bun:1.2` (hint) |
| questcloud | qusetcloud/* | next + bun-elysia | compose ×2 | 3001 (script → arg), 3000 (env `PORT`) | `/`, `/api/` (strip:false) | pg 15 → shared (17), redis 7 → isolated | NextAuth เรียก API ฝั่ง server → nginx alias `<site>.localhost` (§3); email → Mailpit (option) |
| craft-anything-web | craft-anything/apps/craft-anything-web | rust-trunk | container (จน Runtime Manager รองรับ Rust/trunk) | — | `/` | — | pending |

**ไม่ใช่เว็บ:** ads-remove, download_manga (extension), PhiTheGhostHunting, RiderCardBattle (Roblox), Reclaim (Unreal), scamwithfriends_thmod (C# mod), LineBankVerify, translate_manga, video_decode_subtitle, auto_train_fish (Python script/GUI), battleofmyfriends, translate_manga_release (ว่าง/เอกสาร), craft-anything crates อื่น

**DB ที่ย้ายเข้า shared:** postgres ×5 (pos, werewolf, herotime, cloudvps, questcloud) → `webhub-postgres-17` ตัวเดียว (ผ่าน pre-upgrade check ก่อน), redis ×2 (werewolf, herotime) → `webhub-redis-7`; redis ×2 isolated (cloudvps, questcloud); pgadmin ของ pos → แทนด้วย DB Studio

---

## 10. Routing & Security

### 10.1 Hostnames

`http://<name>.localhost` (Chrome/Edge resolve เอง). Reserved (ห้ามเป็นชื่อ site, validate ตอน approve): `hub`, `db`, `sql`, `redis`, `mongo`, `mail`, `s3`, `api`, `http`, `webhub`, `system`, `free`, `all` (ชนกับ host ภายใน/คำสั่ง CLI)

- ใน container (join network `webhub`): `<site>.localhost` = network alias ของ nginx (§3) → server-side เรียกผ่าน nginx ได้; เพิ่ม/ลบ site → อัปเดต alias ของ nginx เท่านั้น ไม่ต้อง recreate container ของ site อื่น
- **HTTP port ≠ 80** (เช่น 8080): ทุก URL ที่ webhub gen (`WEBHUB_URL`, URL rewrite, CORS append, `{{baseUrl}}`, Host allowlist, redirect) ต่อ `:<port>` อัตโนมัติ; nginx `listen 80` + `listen <port>` ใน container → URL เดียวกันใช้ได้ทั้งจาก browser และจาก container
- native: **hosts file sync จำเป็น** (`127.0.0.1 <site>.localhost`, admin) — spike พบว่า Node / Bun / Python บน Windows resolve `*.localhost` ไม่ได้ (`ENOTFOUND`); webhub เขียน block `# webhub:begin … # webhub:end` ใน `C:\Windows\System32\drivers\etc\hosts` (ทุก `<site>.localhost` + `api.<site>.localhost` ที่เปิด subdomain) ผ่าน UAC prompt ครั้งเดียวตอนเพิ่ม/ลบ site; ไม่ให้สิทธิ์ admin → site ที่มี server-side call ไป `<site>.localhost` ติดป้ายเตือน

### 10.2 Generated config

```nginx
# webhub:auto  site=questcloud  runner=compose
server {
    listen 80;
    server_name questcloud.localhost;
    resolver 127.0.0.11 valid=10s ipv6=off;

    error_page 502 503 504 = @wake;              # เฉพาะ error ที่ nginx สร้างเอง (upstream ไม่รัน/DNS ไม่เจอ); ไม่เปิด proxy_intercept_errors → 5xx ของ app ส่งถึง client ตามจริง

    location / {                                  # next (frontend)
        set $up http://questcloud-frontend-web-1:3000;
        set $fwd_host localhost:3000;             # hostRewrite (dev server)
        include /etc/nginx/webhub/proxy.conf;
        proxy_pass $up;
    }
    location /api/ {                              # strip:false
        set $up http://questcloud-backend-api-1:3000;
        set $fwd_host $http_host;
        include /etc/nginx/webhub/proxy.conf;
        proxy_pass $up;
    }
    location @wake {                              # named location ห้ามมี URI ใน proxy_pass
        rewrite ^ /_wake?site=questcloud break;
        proxy_set_header Host webhub.internal;    # Host ภายในที่ API รับเฉพาะ endpoint ภายใน (§10.3)
        proxy_pass http://host.docker.internal:7400;
    }
}

# /etc/nginx/webhub/proxy.conf — include ในทุก location
# (proxy_set_header ใน location ทำให้ header ระดับ server ไม่ถูก inherit → ใส่ชุดเต็มที่นี่ที่เดียว)
proxy_http_version 1.1;
proxy_set_header Host              $fwd_host;
proxy_set_header Upgrade           $http_upgrade;
proxy_set_header Connection        $connection_upgrade;   # map ใน nginx.conf: '' → close, อื่น → upgrade
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Host  $http_host;            # มี :port ถ้า HTTP port ≠ 80
proxy_set_header X-Forwarded-Proto $scheme;
```

- route `strip:true` → `rewrite ^/api/(.*)$ /$1 break;` (proxy_pass แบบตัวแปรไม่ตัด prefix ให้)
- native → `set $up http://host.docker.internal:<port>;`
- gen ลง temp → `nginx -t` → swap → reload; fail = คง config เดิม + error ใน dashboard
- หน้า 502/503/504 ของ webhub: สถานะ site + ปุ่ม Start + ลิงก์ log
- กฎ: header `# webhub:auto` = gen ทับได้; ไม่มี header = ผู้ใช้แก้เอง ห้ามทับ

### 10.3 Dashboard / API auth

- API bind `127.0.0.1:7400` เท่านั้น; nginx proxy ให้ที่ `hub.localhost` / `db.localhost`
- `Host` allowlist: `hub.localhost`, `db.localhost`, `127.0.0.1:7400` (+ `:<port>` เมื่อ HTTP port ≠ 80) → กัน DNS rebinding; `webhub.internal` = Host ที่ nginx ตั้งเองตอนเรียก `/_wake`, `/_auth` (F-026), `/_webhub/login` → รับเฉพาะ endpoint เหล่านี้
- เครื่องมือเสริม (`sql.` / `redis.` / `mongo.` / `mail.` / `s3.` / `http.localhost`) → nginx `auth_request` ไปที่ API ตรวจ **session cookie ของ host นั้น** (ไม่เปิดโล่ง); nginx ลบ cookie `webhub_*` ออก (`proxy_set_header Cookie` ที่กรองแล้ว) ก่อนส่งต่อเข้า container ของเครื่องมือ → master token ไม่หลุดไปถึง tool
- `Origin` check ทุก request ที่แก้ข้อมูล → กัน CSRF
- Token สุ่มใน `data/auth.json` (ACL เฉพาะ user) — **สุ่มใหม่ทุกครั้งที่ daemon เริ่ม, ลบตอนปิด**; `webhub ui` เปิด one-time link (ใช้ครั้งเดียว, 60 วิ, ผูก host) → set cookie `HttpOnly; SameSite=Strict` (ไม่มี Max-Age) + redirect `/#k=<key>`; session อยู่ในหน่วยความจำ (idle 2 ชม. / สูงสุด 24 ชม.); CLI อ่าน token จากไฟล์ และ**พิสูจน์ว่าเป็น daemon จริงก่อนส่ง token** (`GET /api/v1/hello?n=<nonce>` → HMAC(token, nonce)) กันโปรแกรมอื่นฟัง 7400 ตอน daemon ไม่รัน
- browser session (cookie) มี**เฉพาะ host ชื่อ** `hub.`/`db.<suffix>` — `127.0.0.1:7400` รับ bearer อย่างเดียว (cookie ไม่แยก port → cookie ของ `127.0.0.1` จะหลุดไปทุก dev server ที่ `127.0.0.1:<port>`)
- **cookie อย่างเดียวไม่พอ**: `*.localhost` ไปถึง loopback ทุก port → โปรแกรมใดๆ บน `127.0.0.1:<Q>` สั่ง browser ไป `hub.localhost:<Q>` แล้วได้ cookie ของ hub ได้ (F-003 security-2 L1) → session = cookie + header `X-Webhub-Session: <key>` (key อยู่ใน `sessionStorage` ซึ่งแยกตาม port; WebSocket ส่งเป็น subprotocol `webhub-key.<key>`); `auth_request` ของเครื่องมือเสริม (`/_auth`) ต้องออกแบบใหม่ใน F-026 เพราะ navigation ส่ง header ไม่ได้ + nginx ต้อง fail closed เมื่อ daemon ไม่รัน (port 7400 ถูกยึดได้)
- login link แลกเป็น session ได้**เฉพาะผ่าน nginx ของ webhub**: nginx ใส่ `X-Webhub-Proxy: <HMAC(token)>` (ลบค่าที่ client ส่งมา, config ACL เฉพาะ user) — โปรแกรมที่ยึด http port ได้ link ไปก็แลกเองไม่ได้ (F-003 security-3 N1); login-links ปิด (503) จนกว่า F-009 จะเปิด; secret พิสูจน์แค่ "ผ่าน nginx" → nginx ต้อง bind ทุก address ของ `hub.<suffix>` (`127.0.0.1` + `[::1]`) และ daemon / `webhub ui` (F-004) ตรวจว่า**ทุก listener** บน http port เป็น nginx ของ webhub ก่อนเปิด login / ทุก link (F-003 security-4 Q1: โปรแกรมบน `[::1]:80` relay link ผ่าน nginx ได้)
- CLI client พิสูจน์ daemon **ใหม่ทุก request บน connection เดียวกับที่ส่ง token** (F-003 security-3 N2) — ไม่ใช้ผล proof ข้าม connection
- ไม่ส่ง CORS header เลย; request ที่แก้ข้อมูลต้อง JSON + Origin ตรง + `Sec-Fetch-Site: same-origin` (ถ้ามี); Host ไม่อยู่ใน allowlist → 421; รายละเอียด F-003
- cookie เป็น **host-only** ต่อ host (ห้าม `Domain=localhost` → จะรั่วไปทุก `<site>.localhost`): เปิดเครื่องมือเสริม/`db.localhost` จาก dashboard → ลิงก์ `http://<tool>.localhost/_webhub/login?t=<one-time>` → nginx ส่ง path นี้ไป API (Host `webhub.internal` + `X-Forwarded-Host`) → set session cookie (id สุ่มต่อ host, หมดอายุได้, ไม่ใช่ master token) ของ host นั้น → redirect; `auth_request` ตรวจ session ของ host นั้น (วิธีส่ง key → F-026)
- เปิด `lan` / tunnel → บังคับ password + เตือน; DB ที่ `expose: lan` ต้อง password แรง

### 10.4 Static site protection

- `publicDir` detect + แก้ได้
- default deny:
  ```nginx
  location ~ /\.  { deny all; }                                        # .git .env .gitignore
  location ~* \.(md|lock|log|ts|tsx|py|env|ya?ml|toml|sql)$ { deny all; }
  location ^~ /questcloud-backend/ { deny all; }                       # generated: 1 rule ต่อ folder ของ service อื่นใน site ที่ detect ได้
  ```
- rule เพิ่ม/ลดต่อ site, allowlist mode เป็น option

---

## 11. Env, URL Rewrite, Config

### 11.1 Env precedence (ต่ำ → สูง)
1. ค่าที่ detect ได้
2. global `defaultEnv`
3. **env set** ที่ active ของ site (`local` / `remote` / …)
4. URL rewrite ที่ผู้ใช้ยืนยัน
5. DB env (`dbEnv`) ตาม database mode
6. ตัวแปรระบบ: `PORT`/`portEnv`, `HOST`, `WEBHUB_URL=http://<name>.localhost`

ไม่แก้ `.env` ของ project — process env (dotenv/Vite/Next ให้ process env ชนะ `.env`) และ compose `environment:` ใน override

### 11.2 URL Rewrite (เสนอแล้วกดยืนยัน)

| กลุ่ม | ตัวอย่าง | webhub ทำ |
|---|---|---|
| localhost ที่ map กับ service ได้ | `NEXT_PUBLIC_API_URL=http://localhost:3000` | เสนอ `http://questcloud.localhost` (route `/api/` ไม่ strip → ไม่ต่อ `/api` ซ้ำ) |
| key แนว origin | `CORS_ORIGIN=http://localhost:3001` | เสนอ **append** `http://questcloud.localhost` (คงค่าเดิม) |
| host ภายนอก | `VITE_BACKEND_URL=http://kumaisekai.thddns.net:2240` | ไม่แตะ ติดป้าย external → ใช้ env set สลับแทน |

- ตาราง old → new ให้ติ๊กทีละตัว; port เปลี่ยน → rewrite ที่ยืนยันแล้ว update ตามอัตโนมัติ
- build-time var (`NEXT_PUBLIC_*`, `VITE_*`) ใน `compose` runner ที่ build image → แจ้ง "ต้อง Rebuild"

### 11.3 Global — `webhub.config.json`
```json
{
  "schemaVersion": 1,
  "mode": "auto",
  "locale": "th",
  "scanRoots": ["E:/Workspaces/Project"],
  "maxDepth": 3,
  "ignore": ["node_modules", ".git", "dist", "build", "venv", ".venv", "target", "Library", "Intermediate", "DerivedDataCache"],
  "domainSuffix": "localhost",
  "reservedNames": ["hub", "db", "sql", "redis", "mongo", "mail", "s3", "api", "http", "webhub", "system", "free", "all"],
  "ports": { "web": [4100, 4999], "isolatedInfra": [14100, 14999], "pinnedInfra": [15000, 15999] },
  "infra": {
    "postgres": { "default": "17", "policy": "latest", "images": { "17": "postgres:17", "15": "postgres:15" } },
    "mysql":    { "default": "8.4", "policy": "pin" },
    "mariadb":  { "default": "11", "policy": "pin" },
    "mongo":    { "default": "7", "policy": "pin" },
    "redis":    { "default": "7", "policy": "latest", "flavor": "redis" },
    "optional": { "mailpit": false, "minio": false, "cloudbeaver": false, "redisinsight": false, "mongoExpress": false, "hoppscotch": false }
  },
  "runtimes": { "dir": "./runtimes", "policy": "range", "verifyChecksum": true },
  "daemon": { "autostart": true, "tray": true },
  "backups": { "schedule": "daily 03:00", "keep": 7 },
  "defaultEnv": { "NODE_ENV": "development" },
  "onDemand": { "idleStopMinutes": 30 },
  "profilesDir": ["./data/profiles"]
}
```
(port ทั้งหมดอยู่ใน `data/ports.json` — §4.1)
- ไฟล์นี้อยู่ที่ `$WEBHUB_HOME/webhub.config.json`; path relative (`./runtimes`, `./data/profiles`) = relative กับ `$WEBHUB_HOME`
- built-in profiles โหลดจาก package เสมอ แล้ว `profilesDir` ทับ
- scanner ข้าม `$WEBHUB_HOME` และโฟลเดอร์ที่มี `package.json` ชื่อ `webhub` อัตโนมัติ (ไม่ hardcode `_WebHub`)

### 11.4 ต่อ site — `data/sites/<name>.json`
```json
{
  "name": "questcloud",
  "path": "E:/Workspaces/Project/qusetcloud",
  "status": "enabled",
  "runner": "compose",
  "compose": { "groups": [
    { "dir": "questcloud-frontend", "files": ["docker-compose.yml"], "projectName": "questcloud-frontend" },
    { "dir": "questcloud-backend",  "files": ["docker-compose.yml"], "projectName": "questcloud-backend" }
  ] },
  "startMode": "on-demand",
  "dependsOn": [],
  "services": {
    "frontend": { "profile": "next", "cwd": "questcloud-frontend", "composeService": "web", "target": 3000, "via": "fixed", "hostRewrite": true },
    "backend":  { "profile": "bun-elysia", "cwd": "questcloud-backend", "composeService": "api", "target": 3000, "via": "env", "portEnv": "PORT" }
  },
  "routes": [
    { "path": "/",     "service": "frontend" },
    { "path": "/api/", "service": "backend", "strip": false }
  ],
  "database": {
    "postgres": { "mode": "shared", "version": "latest", "disableComposeServices": ["postgres"] },
    "redis":    { "mode": "isolated", "reason": "REDIS_HOST/PORT ไม่ระบุ db index" },
    "dbEnv": { "DATABASE_URL": "{postgres.url}" }
  },
  "envSets": {
    "active": "local",
    "local": { "AUTH_SECRET": "dev-secret" }
  },
  "urlRewrites": [
    { "key": "NEXT_PUBLIC_API_URL", "from": "http://localhost:3000", "to": "http://questcloud.localhost", "enabled": true, "buildTime": true },
    { "key": "CORS_ORIGIN", "from": "http://localhost:3001", "append": "http://questcloud.localhost", "enabled": true }
  ],
  "runtime": { "frontend": { "lang": "bun", "required": "1.2 (hint)", "policy": "range", "resolved": "1.3.11", "source": "system" } },
  "devServices": { "mailpit": true, "minio": false },
  "static": null,
  "detected": { "score": 120, "markers": ["next", "elysia", "compose:postgres:15", "compose:redis:7"] }
}
```

`data/secrets.json` (password DB) + `data/auth.json` + `data/` ทั้งหมด → `.gitignore`

---

## 12. Folder Structure

```
_WebHub/                      # repo (npm package source)
├── DESIGN.md
├── package.json
├── profiles/                 # built-in runtime profiles (*.yml)
├── fixtures/                 # project ตัวอย่างสำหรับทดสอบ detector/profile (§21.5)
├── test/{unit,integration,helpers/fixture.ts}   # Vitest; helper ตรวจ Zero-touch (hash ก่อน/หลัง)
├── .github/workflows/ci.yml  # Windows + Linux × Node 22/24: lint, typecheck, test, audit, pack check
├── tsconfig.json  tsconfig.build.json  vitest.config.ts  biome.json  pnpm-lock.yaml
├── src/
│   ├── cli.ts                # thin client → API (token)
│   ├── daemon.ts             # entry ของ core
│   ├── scanner/{walk.ts, detector.ts, dedupe.ts, routes.ts}
│   ├── profiles/{loader.ts, schema.ts, match.ts}
│   ├── runtimes/{detect.ts, resolve.ts, fetch.ts}   # Runtime Manager (§19.1)
│   ├── registry/store.ts     # single writer (daemon)
│   ├── ports/{manager.ts, probe.ts}            # probe: excluded ranges + netstat + bind
│   ├── env/{resolver.ts, url-rewrite.ts, env-sets.ts}
│   ├── infra/
│   │   ├── manager.ts
│   │   ├── provision/{postgres,mysql,mongo,redis}.ts
│   │   └── transfer.ts       # import / backup / restore
│   ├── apistudio/{collections.ts, runner.ts, importers/, ws.ts, db-diff.ts}   # §22
│   ├── studio/
│   │   ├── adapter.ts        # DbAdapter interface
│   │   ├── adapters/{postgres,mysql,sqlite,mongo,redis}.ts
│   │   └── guard.ts          # read-only, dangerous-command confirm, timeout, audit
│   ├── nginx/{generator.ts, control.ts, templates/}
│   ├── runners/{static,native,compose,hybrid,container}.ts
│   ├── supervisor.ts         # start modes, dependsOn, idle, restart, health
│   ├── ops/{metrics.ts, notify.ts, backup-schedule.ts, cleanup.ts, config-io.ts}   # §20
│   ├── platform/             # Platform layer (§21.1)
│   │   ├── index.ts          # interface Platform
│   │   ├── windows.ts        # hosts+UAC, netsh, Get-NetTCPConnection, taskkill, Task Scheduler, toast, tray
│   │   ├── darwin.ts         # (ทีหลัง) /etc/hosts+sudo, lsof, launchd, osascript notify
│   │   └── linux.ts          # (ทีหลัง) systemd-resolved, ss, systemd --user, notify-send
│   ├── proxy/lite.ts         # Lite mode reverse proxy (§21.2)
│   ├── setup/wizard.ts       # first-run (§21.4)
│   ├── migrate/              # data/ schema migrations (§21.6)
│   └── server/{api.ts, auth.ts, client.ts, errors.ts}   # REST + WS + /_wake + Host/Origin/token; client = ที่ CLI ใช้ (handshake)
├── dashboard/                # Vite + React
├── templates/
│   ├── docker/{nginx,infra,tools}.compose.yml   # template → gen ลง $WEBHUB_HOME/docker/
│   └── nginx/{nginx.conf, proxy.conf, errors/}   # template → gen ลง $WEBHUB_HOME/nginx/
│
│  ── ด้านล่างอยู่ใน $WEBHUB_HOME ตอนใช้งานจริง (default %APPDATA%\webhub), dev = WEBHUB_HOME นอก scan root; gitignore ใน repo กันพลาด ──
├── webhub.config.json
├── docker/  nginx/{nginx.conf, webhub/, sites/, errors/}   # generated (path absolute)
├── runtimes/                 # portable runtimes <lang>/<ver>/
├── data/                     # gitignored
│   ├── sites/  compose/  profiles/  backups/  venvs/
│   ├── ports.json  infra.json  secrets.json  auth.json  state.json
└── logs/
```

---

## 13. CLI

CLI เป็น client ของ daemon (ไม่เขียน `data/` เอง → ไม่ชนกับ dashboard)

```
webhub scan | approve <n> | ignore <n> | list
webhub up <n|all> | down <n|all> | restart <n> | rebuild <n> | logs <n> [-f] | open <n>
webhub mode <n> manual|auto|on-demand
webhub install <n>                   # ติดตั้ง deps ตาม profile

webhub ports                         # Port Map ทั้งหมด + ชน + Windows reserved
webhub port <n> [svc=PORT ...]       # ดู/แก้ port site
webhub port system <key>=PORT        # แก้ nginx/dashboard/infra port
webhub port free [range]

webhub env <n> [KEY=VAL ...] [--unset KEY] [--set <envset>]
webhub env <n> --use <envset>        # สลับ env set (เช่น local/remote) → restart
webhub urls <n> [--apply KEY ...]    # ดู/ยืนยัน URL rewrite

webhub db list | mode <n> <engine> shared|isolated|external | import <n>
webhub db backup <n|all> | restore <n> <file> | clone <n> <new> | reset <n>
webhub db url <n> | shell <n> [--engine redis] | query <n> "<sql>" [--json|--csv]
webhub db export <n> [table] --format csv|json|sql | studio

webhub runtimes [list|prune]        # runtime ที่โหลดไว้ + site ที่ใช้
webhub db version <n> <engine> latest|pin <major>   # ย้าย/pin major (dump→restore)
webhub profiles [--check]
webhub infra up|down|status | enable mailpit|minio|cloudbeaver|redisinsight|mongo-express|hoppscotch
webhub api import <n> [openapi|curl|postman|har] [file|url]   # สร้าง collection
webhub api run <n> <collection>[/<request>] [--env <set>]    # รัน request/collection (ใช้ใน script/CI ได้)
webhub stats [<n>]                   # CPU/RAM ต่อ site
webhub cleanup [--dry-run] [--all]   # ลบ container/network/override ที่ webhub สร้าง (ไม่แตะ volume เดิมของ project); --all = + hosts block, autostart (ก่อน uninstall)
webhub route <n> add|rm <path> [<svc>] [--strip] [--ws] [--subdomain]
webhub alias <n> add|rm <name>
webhub runtimes policy <n> [svc] range|exact|ignore
webhub config export <file> | import <file>
webhub autostart on|off
webhub code <n> | term <n> | folder <n>   # เปิด VS Code / terminal / explorer
webhub setup                         # first-run wizard (รันซ้ำได้)
webhub add <path> [--profile <id>]   # เพิ่ม site manual (detect ไม่เจอ/ผิด)
webhub roots add|remove|list <path>
webhub doctor                        # ตรวจ Docker/runtime/ports/hosts/สิทธิ์ + บอกวิธีแก้
webhub profiles import|export <file>
webhub reload | ui
```

---

## 14. Dashboard

```
┌ webhub ─ [Sites] [Port Map] [Data Hub] [DB Studio] [API Studio] [Runtimes] [Profiles] ─ [Rescan] ┐
│ nginx ● :80   infra ● pg17 redis7   docker ●   sites 12 · running 5 · RAM 2.1 GB    │
├───────────────────────────────────────────────────────────────────────────────┤
│ Name        Lang         Runner   Mode       URL                 Status   Act │
│ questcloud  ts/next+bun  compose  on-demand  questcloud.localhost ◌ sleep ▶↗⚙│
│ werewolf    js           hybrid   auto       werewolf.localhost  ● on     ⏹↗⚙│
│ wowmusic    static+bun   native   manual     wowmusic.localhost  ○ off    ▶↗⚙│
│ pprs        bun          compose  manual     pprs.localhost      ⟳ rebuild ▶↗⚙│
│ Pending: craft-anything-web (rust-trunk, ไม่มี trunk) [Enable] [Ignore]       │
└───────────────────────────────────────────────────────────────────────────────┘

[Port Map]
│ Owner          Service   Host port  Target  Via    Expose  Status              │
│ system         nginx     80         80      —      host    ● in use        ✎   │
│ system         postgres  5432       5432    —      host    ● in use        ✎   │
│ questcloud     frontend  4111       3000    fixed  host    ○ free          ✎   │
│ backend-hobby  api       3000       3000    fixed  host    🔒 fixed native      │
│ werewolf       backend   4107       4107    env    host    ⚠ conflict(PID 1234)│
│ (Windows)      reserved  50000-50059 —      —      —       ⛔ reserved          │

[Data Hub]
│ Engine    Database    Site        Size    Mode      Act                        │
│ postgres  questcloud  questcloud  12 MB   shared    [URL] [Studio] [Backup]    │
│ redis     —           questcloud  —       isolated  [URL] [Studio]             │
│ redis     db1         werewolf    —       shared                               │
│ [Import from project DB] [Backup all]                                          │

[DB Studio — db.localhost]
┌ Connections ──────┐┌ Query 1 × │ users × │ + ──────────────────────────────┐
│ ▾ pg17 (shared)   ││ SELECT * FROM users WHERE created_at > :since;      │
│   ▾ questcloud    ││ [▶ Run] [Explain] [Format] [Save]   auto-commit ☑   │
│     ▾ public      │├─────────────────────────────────────────────────────┤
│       ▸ users     ││ id │ name   │ email          │ created_at          │
│       ▸ vps       ││ 1  │ Somchai│ s@x.com  ✎     │ 2026-11-01 10:00    │
│   ▸ werewolf      ││ ... 1,000 rows · 23 ms   [Export ▾] [Save changes(1)]│
│ ▾ redis7 (shared) │└─────────────────────────────────────────────────────┘
│   ▸ db1 werewolf  │  Redis: ▾ session: (120) ▾ room: (8)  key=room:42 hash TTL 3600
│ ▸ mongo           │  Mongo: [Filter {}] [Aggregate +stage] JSON/Table view
└───────────────────┘

⚙ Site: services | routes (path/strip/ws/subdomain) | profile + start cmd | runtime version | ports
        | env + env sets | URL rewrite | database mode + version | dev services | start mode + dependsOn
        | static rules | [VS Code] [Terminal] [Folder] | git branch/status | CPU/RAM
```

---

## 15. Roadmap

0. ~~Spike~~ ✅ เสร็จ 2026-11-07 (ผลใน §18)
1. **MVP-1** — Platform layer (Windows) + config/schema version + profiles loader + scanner + detector (routes, via, URL env, DB) + dedupe + `scan/approve/list/add` + fixtures; daemon + CLI client + auth (token, Host/Origin) + `setup` wizard + `doctor`
2. **MVP-2** — nginx container (mount จาก scanRoots) + generator (resolver/variables, validate/swap) + static (publicDir, deny-list) + hosts sync (UAC) + **Lite mode proxy**
3. **MVP-3** — Port Manager (ports.json, probe 3 ชั้น, edit/apply/rollback) + native runner + **container runner พื้นฐาน** (`docker run` + map port: `via: fixed`, ไม่มี runtime) + Runtime Manager (Node/Bun/Python portable) + env resolver + env sets + URL rewrite + install แบบ frozen lockfile
4. **MVP-4** — compose runner (project name เดิม, compose group ต่อ dir, adopt, override, network alias, rebuild) + hybrid + supervisor: start modes `auto`/`on-demand` (`@wake`) + `dependsOn` + health
5. **MVP-5** — (เครื่องมือเสริม Hoppscotch เปิดได้พร้อม CloudBeaver/RedisInsight) Data Hub: shared postgres + redis (server ต่อ major, upgrade/pin, pre-upgrade check), provision, env injection, disable DB services, **backup/restore** (ต้องมีก่อน import/upgrade), import จาก volume เดิม + **เปิด CloudBeaver / RedisInsight** (connection อัตโนมัติ, auth_request) → ได้เครื่องมือ DB ครบตั้งแต่ phase นี้
6. **MVP-6** — Dashboard (Sites, Port Map, Data Hub, Runtimes) + autostart/tray + CPU/RAM + แจ้งเตือน crash
7. **DB Studio v1 + API Studio v1** (REST, collections, OpenAPI import, env ต่อ site, history) — SQL (pg): browser, data grid + edit, SQL editor + autocomplete, history, export; Redis: key browser, value editor, TTL, console; guard
8. backup ตามเวลา + retention, mysql + mariadb + mongo (infra + studio + mongo-express), Mailpit + MinIO
9. **DB Studio v2 + API Studio v2** (WebSocket/socket.io/SSE/GraphQL, DB/Redis diff, pre/post script, collection runner) — EXPLAIN, schema/DDL editor, ER diagram, Mongo aggregation builder, Redis pub/sub + slowlog + memory, sqlite → ครอบคลุมเครื่องมือเสริม (ปิดได้)
10. Profiles เพิ่ม (PHP, Ruby, Go, Java, .NET, Elixir, SSG) + Runtime Manager รองรับภาษาเพิ่ม + container image ต่อภาษา
11. watch mode (rescan), cleanup, export/import config, ปุ่ม VS Code/terminal, git status, alias
12. mkcert HTTPS, export config ไป VPS
13. macOS + Linux (implement platform, spike ซ้ำ, nginx `network_mode: host` บน Linux), single binary + installer, i18n อังกฤษ

---

## 16. Risks / Open

- Port/host hardcode (Backend-Hobby, PPRS `.listen(3000)`) → `via: fixed`, แก้ได้แค่ผ่าน container mapping
- Next ≥ 15 `allowedDevOrigins` ตรวจ Origin (ไม่ใช่แค่ Host) → hostRewrite อาจไม่พอสำหรับ HMR/server action → spike ใน MVP-2
- Linux `network_mode: host` → ไม่มี Docker DNS `127.0.0.11` → resolver/alias ต้องออกแบบใหม่ใน phase 13
- App bind `0.0.0.0` ใน code (Bun/Elysia default) → เปิดออก LAN; คุมได้แค่ Firewall
- Shared DB: version/extension ต่างกัน, DB host hardcode, redis ระบุ index ไม่ได้ → `isolated`
- Import: ต้อง start DB เดิมชั่วคราว → ใน network ภายใน ไม่ publish
- Compose ≥ 2.24 สำหรับ `!override` / `!reset` (เครื่องนี้ 5.1.1 ผ่าน)
- Docker Desktop ต้องเปิดก่อน (autostart ของ webhub เช็ค + แจ้ง); port 80 ถูกจองทีหลัง → แก้ใน Port Map
- Runtime portable: ต้องมี internet ครั้งแรก, ตรวจ checksum ทุกครั้ง; ใช้พื้นที่ดิสก์ → `runtimes prune`
- Upgrade DB major: ข้อมูลเสี่ยงถ้า restore ไม่ครบ → backup ก่อนเสมอ + ตรวจ row count + เก็บ volume เดิม
- hosts sync ต้อง UAC; ผู้ใช้ปฏิเสธ → native server-side call ไป `<site>.localhost` ใช้ไม่ได้ (แจ้งเตือน)
- Windows excluded port ranges เปลี่ยนทุก reboot → probe ทุกครั้ง
- Scope: DB Studio ใหญ่ → เครื่องมือเสริมเปิดตั้งแต่ MVP-5 ให้ใช้ได้ครบก่อน, Studio ทำ v1/v2 ตามหลัง
- Secret ใน `data/` → ห้าม commit
- ผู้ใช้อื่น: repo ที่ไม่ไว้ใจ — Enable = รัน code ของ repo → โชว์คำสั่ง/compose ที่จะรันก่อนยืนยันเสมอ
- macOS/Linux ยังไม่ spike → ห้ามประกาศรองรับจนผ่าน §21.1

---

## 17. Review log

| # | ประเด็น | ตัดสินใจ | อยู่ใน |
|---|---|---|---|
| 0 | หลักการ (ผู้ใช้กำหนด) | **Zero-touch** | §0 |
| 1 | URL ใน env ชี้ `localhost:<port เดิม>` | URL Rewrite เสนอแล้วกดยืนยัน | §11.2 |
| 1b | werewolf ชี้ backend ภายนอก (DDNS) | Env Sets สลับได้ | §11.1 |
| 2 | SSR/server-side เรียก `<site>.localhost` ใน container | `extra_hosts` host-gateway + hosts sync (ถ้า spike จำเป็น) | §4.4, §10.1 |
| 3 | `/api/` strip prefix, socket.io | routes list `{path, service, strip, ws}`, default `strip:false`, detect prefix; path หลัก + subdomain option | §9, §10.2 |
| 3b | Backend-Hobby = backend รวม | shared service + `dependsOn` | §8, §9 |
| 4 | static หลุด `.git`, source | publicDir + deny-list | §10.4 |
| 5 | API ไม่มี auth | 127.0.0.1 + Host/Origin + token cookie | §10.3 |
| 6 | `-p webhub-*` ทำ volume หาย/รันซ้อน | project name เดิม + adopt + ไม่ลบ volume | §4.4, §5.5 |
| 7 | nginx พังเมื่อ upstream ไม่รัน | resolver + ตัวแปร + validate/swap | §10.2 |
| 8 | hot reload compose บน Windows | ผสม: mount source → hybrid; build image → compose + rebuild; polling fallback | §7 |
| 9 | Windows excluded port ranges | probe 3 ชั้น + ป้าย reserved | §4.3 |
| 10 | Zero-touch → allowedHosts / port fixed / bind | hostRewrite, `via: fixed`, Firewall rule | §4.1, §6.1 |
| 10b | bind `127.0.0.1` vs `0.0.0.0` | **`127.0.0.1`** (spike ผ่าน) + hosts sync จำเป็นสำหรับ native | §6.1, §10.1, §18 |
| 11 | Prisma กับ shared pg | role `CREATEDB`, restore `--no-owner --no-acl` (เทคนิค) | §5.2, §5.5 |
| 12 | redis index ระบุไม่ได้ (cloudvps/questcloud) | detect → `isolated` อัตโนมัติ (เทคนิค) | §5.2, §9 |
| 13 | version ภาษา / DB / Redis ต่างกัน | Runtime Manager portable; DB server ต่อ major (pg/redis → ล่าสุด, mysql/mongo → pin); Redis 7 + Valkey option; profile variant ตาม version framework | §19 |
| 14 | review v5 (goal เดิม) | DB server ต่อ major ทุกจุด (ชื่อ `webhub-postgres-17`, ports, config); MariaDB แยก engine; เครื่องมือเสริมเปิดตั้งแต่ MVP-5; venv ไป `data/venvs`; Runtime Manager ใน architecture/runners/dashboard; backlog ที่แนะนำ → design (Mailpit, MinIO, autostart/tray, metrics, notify, backup ตามเวลา, cleanup, config export, ปุ่ม VS Code); auth ของเครื่องมือเสริมผ่าน `auth_request`; werewolf redis ตรวจแล้วใช้ `REDIS_URL` → shared ถูกต้อง | ทั้งเอกสาร, §5.8, §20 |
| 15 | ใช้กับ project/เครื่องอื่นได้ (generalize) | Windows ก่อน + Platform layer; Lite mode เมื่อไม่มี Docker; npm package; scanRoots หลาย root + nginx mount generated; Add site manual; first-run wizard + doctor; profile schema/fixtures/import-export; run approval โชว์คำสั่ง; config migration; i18n; ผล scan เป็น fixture | §0, §21 |
| 16 | ยิง API | **API Studio ในตัว** + **Hoppscotch** เสริม (ไม่ทำ Data API / PostgREST) | §22 |
| 17 | review v7 (goal เดิม) | nginx: `@wake` แบบ rewrite + proxy.conf header ชุดเต็มทุก location; Host `webhub.internal` สำหรับ `/_wake`/`/_auth`; cookie host-only + login handoff ต่อ tool host; nginx/infra bind 127.0.0.1; install frozen lockfile + `COREPACK_ENABLE_AUTO_PIN=0`; sandbox isolated-vm; generated config ใน `$WEBHUB_HOME` (absolute mount); compose group ต่อ dir + project name จาก `compose config`; disable dependents; vite `via: arg`; roadmap (container runner → MVP-3, start modes → MVP-4, backup → MVP-5); HTTP port ≠ 80 ต่อ `:port`; mariadb 3307 + pinned major `15000–15999`; redis ACL แทน rename-command; `<site>.localhost` ใน container = nginx alias; reserved/CLI/ignore/deny-list | §3, §4, §5, §7, §10, §11, §13, §15, §19, §22 |
| 18 | review v8 (goal เดิม) | session cookie ต่อ tool host + ลบ cookie ก่อนส่งเข้า tool; daemon resolver `*.localhost`; เลิก `proxy_intercept_errors`; redis shared เฉพาะ app ที่มี URL/username; mongo-express → phase 8; native `target` = `port`; override path absolute; `next dev` เป็นข้อจำกัดที่แจ้งใน run approval; git status `--no-optional-locks` | §3, §4, §5, §7, §10, §20, §22 |
| — | inconsistency v3 | Adminer → DB Studio; postgres ×6 → ×5; `depends_on: !reset []` → gen ใหม่ตัดเฉพาะ DB; alias ชื่อ container เดิม; CLI ผ่าน daemon | ทั้งเอกสาร |

### Backlog
- (ว่าง — ย้ายเข้า design แล้วใน v5: §0, §5.8, §20)

---

## 18. Spike results (2026-11-07, Docker 29.3.1, Compose 5.1.1)

| Test | ผล | ผลต่อ design |
|---|---|---|
| container → host service bind `127.0.0.1` ผ่าน `host.docker.internal` | ✅ ได้ | native bind `127.0.0.1` เป็น default; ไม่เปิด LAN |
| container → host service bind `0.0.0.0` | ✅ ได้ | — |
| container `extra_hosts: <site>.localhost:host-gateway` → host | ✅ ได้ (ทั้ง 127.0.0.1/0.0.0.0) | server-side ใน container เรียก `<site>.localhost` ผ่าน nginx ได้ |
| Node 24 `dns.lookup('test.localhost')` บน Windows | ❌ `ENOTFOUND` | ต้อง hosts sync |
| Bun 1.3 `fetch('http://test.localhost')` | ❌ lookup `ENOTFOUND`, fetch `ConnectionRefused` | ต้อง hosts sync |
| Python 3.14 `gethostbyname('test.localhost')` | ❌ `getaddrinfo failed` | ต้อง hosts sync |
| compose `container_name: !reset null` | ✅ ลบออก | ใช้ได้ |
| compose `ports: !override [...]` | ✅ แทนที่ list (ไม่ต่อท้าย) | ใช้ได้ |
| compose `depends_on: !override {cache}` + `profiles: [webhub-disabled]` ที่ db | ✅ db ไม่รัน, app ไม่รอ db | ใช้ได้ |
| compose `extra_hosts` + `!override` รวมกัน รันจริง | ✅ `ok 127.0.0.1:4901 host=spike.localhost:4901` | ใช้ได้ |

หมายเหตุ: `curl` ≥ 7.85 resolve `*.localhost` เป็น loopback เองโดยไม่อ่าน `/etc/hosts` (RFC 6761) → health check ใน container ห้ามใช้ curl ทดสอบ `<site>.localhost`; ใช้ `wget`/Node แทน
Windows Firewall: bind `127.0.0.1` ไม่ trigger popup (by design) — ไม่ได้ทดสอบ popup ของ `0.0.0.0`

---

## 19. Version Management

### 19.1 Runtime Manager (version ภาษา)

**Detect version ที่ต้องการ** (แม่น → หยาบ):

| ภาษา | แหล่ง |
|---|---|
| Node | `.nvmrc`, `.node-version`, `.tool-versions`, `package.json` `engines.node`, Dockerfile `FROM node:N` (hint) |
| Package manager | `packageManager` (`pnpm@x`, `yarn@x`, `npm@x`), lockfile |
| Bun | `.bun-version`, `engines.bun`, Dockerfile `FROM oven/bun:N` (hint) |
| Python | `.python-version`, `pyproject` `requires-python`, `runtime.txt`, Dockerfile (hint) |
| Go / Rust / .NET / PHP / Ruby | `go.mod` `go 1.x`, `rust-toolchain(.toml)`, `global.json`, `composer.json` `require.php`, `Gemfile` / `.ruby-version` |

Dockerfile `FROM` = hint เท่านั้น (เตือน ไม่บังคับ)

**Resolve ต่อ site:**
```
required range
  → runtime บนเครื่องผ่าน?          → ใช้ (source: system)
  → ไม่ผ่าน → มีใน $WEBHUB_HOME/runtimes? → ใช้ (source: webhub)
  → ไม่มี → โหลด portable ได้?        → โหลด + verify checksum → ใช้ (source: webhub)
  → ไม่ได้                          → runner `container` image version ตรง (source: container)
```

| ภาษา | Portable |
|---|---|
| Node | zip ทางการ `nodejs.org/dist/vX/node-vX-win-x64.zip` + `SHASUMS256.txt` |
| Bun | release zip ทางการ (`bun-windows-x64.zip`) ต่อ version |
| pnpm / yarn | ตาม `packageManager`: Node ≤ 24 ใช้ corepack (`COREPACK_ENABLE_AUTO_PIN=0`); Node 25+ ไม่มี corepack → Runtime Manager โหลด pnpm/yarn standalone ตาม version เอง |
| Python | `uv python install <ver>` + `uv venv` → venv ที่ `data/venvs/<site>/` (ไม่สร้างใน project) |
| Go / Rust / .NET / PHP / Ruby | phase หลัง; ระหว่างนี้ → `container` |

- spawn: prepend `runtimes/<lang>/<ver>/` ใน `PATH` **เฉพาะ process นั้น** — ไม่แตะ PATH ระบบ, ไม่ต้อง admin
- Policy ต่อ site: `range` (default, ผ่านเงื่อนไขที่ประกาศ), `exact`, `ignore` (ใช้ของเครื่องเสมอ)
- Dashboard: ตาราง "ต้องการ / ใช้อยู่ / source" ต่อ site; `webhub runtimes prune` ลบตัวที่ไม่มี site ใช้

ผลกับ project ตอนนี้ (เครื่อง: Node 24.20, Bun 1.3.11, pnpm 12.9.1, Python 3.14.3):

| Site | ต้องการ | ผล |
|---|---|---|
| herotime | node `>=22`, `pnpm@12.9.1` | system ✅ |
| werewolf | Dockerfile `node:20` (hint) | system 24 + เตือน hint; ตั้ง `exact` → โหลด Node 20 |
| cloudvps / questcloud | Dockerfile `bun:1.2` (hint) | system 1.3 + เตือน hint |
| REA (ไม่ใช่เว็บ) | node `^22.19 \|\| ^24.11` | — |

### 19.2 DB version

**หลัก: 1 shared server ต่อ engine ต่อ major ที่มี site ใช้จริง**

```
webhub-postgres-17   :5432   ← `infra.postgres.default`
webhub-postgres-15   :15000  ← เกิดขึ้นเฉพาะเมื่อมี site pin 15 (site ที่ pin 15 แชร์กัน)
webhub-redis-7       :6379
webhub-mysql-8.4     :3306
webhub-mariadb-11    :3307
```

`policy: latest` = ย้ายไป **`default` ที่ตั้งใน config** (ไม่ใช่ tag ล่าสุดบน Docker Hub); `default` เปลี่ยนเมื่อผู้ใช้แก้หรืออัปเดต webhub → เสนอ upgrade ผ่าน pre-upgrade check, ไม่ย้ายเอง

| Engine | Default policy | เหตุผล |
|---|---|---|
| PostgreSQL | **upgrade → `default`** (17) | dump/restore ข้าม major ได้, ปัญหาน้อย |
| Redis / Valkey | **upgrade → major ที่ตั้งไว้ (7)** | RDB ใหม่อ่านของเก่าได้ |
| MySQL | **pin major เดิม** | 5.7→8: auth plugin `caching_sha2_password`, collation `utf8mb4_0900_ai_ci`, reserved words |
| MariaDB | **pin major เดิม** (engine แยกจาก MySQL) | ไม่ใช่ drop-in เต็มตัว |
| MongoDB | **pin major เดิม** | upgrade ต้องทีละ major + featureCompatibilityVersion |

กฎ:
- **ห้าม downgrade**: data จาก major ใหม่ → server เก่ากว่า = block
- **Dump ด้วย client ใหม่สุดเสมอ** (`pg_dump` ต้อง ≥ version ต้นทาง) → รันผ่าน image `postgres:<ล่าสุด>` / `mongo:<target>`
- **Pre-upgrade check** ก่อนย้าย major:
  - pg: `pg_extension` (postgis, pgvector, timescale…) มีใน image ปลายทางไหม, collation provider, feature ที่ถูกถอด
  - mysql: auth plugin ของ user, `sql_mode`, collation, reserved words ใน schema
  - mongo: FCV, deprecated operators
  - ไม่ผ่าน → เสนอ pin แทน
- ย้าย/pin ภายหลังได้: `webhub db version <n> <engine> latest|pin <major>` → backup → dump → restore → ตรวจ row count → สลับ env
- Port: major default ใช้ port มาตรฐาน (mariadb 3307 ไม่ชน mysql); major อื่น = port ว่างถัดไปใน `15000–15999` แก้ได้ใน Port Map
- image: ตั้งต่อ major ใน `infra` config; extension พิเศษ → image เฉพาะ (เช่น `pgvector/pgvector:pg17`, `postgis/postgis:17-3.5`)

ผลกับ project ตอนนี้: pos / cloudvps / questcloud (pg 15) + werewolf (pg 16) + herotime (pg 17) → **webhub-postgres-17 ตัวเดียว** (ผ่าน pre-upgrade check ก่อน; ไม่ผ่าน → pin); redis 7 ทั้งหมด → webhub-redis-7

### 19.3 Redis vs Valkey

- default `redis:7` (ตรงกับทุก project)
- `infra.redis.flavor: "redis" | "valkey"` → Valkey (BSD, fork จาก Redis 7.2, protocol/RDB เข้ากันได้) สลับได้ — Redis 7.4+ เปลี่ยน license (RSAL/SSPL, 8.x เพิ่ม AGPL)
- RedisJSON / RediSearch: ใช้ได้เฉพาะ Redis Stack / Redis 8 → site ที่ใช้ module → pin image ที่มี module

### 19.4 DB Studio รองรับหลาย version

- adapter อ่าน version ตอน connect (`SELECT version()`, `SELECT @@version`, `INFO server`, `buildInfo`) → **capability flags**
- ซ่อน/ปิด feature ที่ server ไม่รองรับ เช่น MySQL 5.7 ไม่มี CTE/window function, Redis < 7.4 ไม่มี `HEXPIRE`, ไม่มี module JSON → ไม่มี JSON editor, Mongo < 5 ไม่มี `$setWindowFields`
- introspection query แยกตาม version (pg ≥ 10, mysql 5.7/8, mariadb)
- autocomplete keyword ตาม dialect + version

### 19.5 Framework version ใน profile

พฤติกรรม dev server เปลี่ยนตาม version → profile มี variant:

```yaml
variants:
  - when: { dep: "vite", range: ">=6" }
    devServer: { hostRewrite: true }          # Vite 6 บล็อก Host ที่ไม่รู้จัก
  - when: { dep: "next", range: ">=15" }
    devServer: { hostRewrite: true }          # allowedDevOrigins (ตรวจ Origin ด้วย → ต้อง spike, §16)
  - when: { dep: "next", range: "<13" }
    start: { cmd: "next dev -p {PORT} -H {HOST}" }
```

---

## 20. Operations

| Function | ทำยังไง |
|---|---|
| **Autostart** | Task Scheduler task "At log on" ของ user (ไม่ต้อง admin) รัน daemon; ตอน start เช็ค Docker Desktop (เปิดให้ถ้าตั้งไว้) → nginx → infra ที่จำเป็น → site `auto` |
| **Tray icon** | สถานะรวม (●/⚠), เปิด dashboard, start/stop site ที่ใช้บ่อย, Quit |
| **Metrics** | CPU/RAM ต่อ site: native = รวมทั้ง process tree (`Get-Process`/`pidusage`), compose/container = `docker stats --no-stream`; เก็บย้อนหลังสั้น (ring buffer) แสดง sparkline |
| **Notify** | crash / restart เกิน backoff / health fail / port ชน / backup fail → Windows toast + badge ใน dashboard |
| **Scheduled backup** | ตาม `backups.schedule` (default ทุกวัน 03:00) ทุก DB ใน shared + isolated, เก็บ `keep` ชุดล่าสุด, ไฟล์ใน `data/backups/` |
| **Cleanup** | `webhub cleanup` ลบเฉพาะของที่ webhub สร้าง (label `webhub.managed=true`): container, network `webhub`, override, nginx conf, runtimes ที่ไม่ใช้ — **ไม่ลบ volume เดิมของ project, ไม่แตะ project**; `--dry-run` ดูก่อน |
| **Config export/import** | zip `webhub.config.json` + `data/sites`, `ports.json`, `profiles/` (ไม่รวม secrets/backups เว้นแต่ `--with-secrets`) → ย้ายเครื่อง / เตรียม export ไป VPS |
| **Dev shortcuts** | ปุ่ม VS Code (`code <path>`), terminal (Windows Terminal ที่ cwd ของ site + env ของ site), explorer; git branch/dirty status (อ่านอย่างเดียวจริง: `git --no-optional-locks status --porcelain` → ไม่เขียน `.git/index`) |
| **Alias** | ชื่อเพิ่มต่อ site (`pos.localhost` + `shop.localhost`) → nginx `server_name` + hosts sync |

ทุก resource ที่ webhub สร้าง (container, network, volume ของ shared infra) ติด label `webhub.managed=true` เพื่อแยกจากของ project

---

## 21. Generalization — ใช้กับ project / เครื่องอื่น

### 21.1 Platform layer

ทุกอย่างที่ขึ้นกับ OS ผ่าน interface เดียว — core ไม่เรียก PowerShell/netsh ตรง

```ts
interface Platform {
  hosts:     { read(): Entry[]; writeBlock(entries: Entry[]): Promise<void> }   // ต้องยกสิทธิ์
  ports:     { listening(): PortOwner[]; reserved(): Range[]; canBind(p: number): Promise<boolean> }
  process:   { killTree(pid: number): Promise<void>; info(pid: number): ProcInfo; usage(pid: number): Usage }
  autostart: { enable(cmd: string): Promise<void>; disable(): Promise<void> }
  notify(title: string, body: string): void
  tray?:     TrayApi
  elevate(task: ElevatedTask): Promise<void>      // UAC / sudo / pkexec
  dockerTopology(): 'host-gateway' | 'host-network'
  resolvesLocalhostSubdomains(): boolean          // ต้อง hosts sync ไหม
}
```

| เรื่อง | Windows (ทำก่อน) | macOS (ทีหลัง) | Linux (ทีหลัง) |
|---|---|---|---|
| hosts | `drivers\etc\hosts` + UAC | `/etc/hosts` + sudo | ไม่ต้อง ถ้า systemd-resolved (resolve `*.localhost` เอง) ไม่งั้น `/etc/hosts` + pkexec |
| port owner | `Get-NetTCPConnection` | `lsof -iTCP -sTCP:LISTEN` | `ss -ltnp` |
| reserved ports | `netsh … excludedportrange` | — | `ip_local_reserved_ports` |
| kill tree | tree จาก CIM (ลูกเกิดหลังพ่อ) + `taskkill /F /PID …` | process group `kill -PGID` | process group |
| autostart | Task Scheduler (user) | launchd agent | `systemd --user` |
| notify | toast | `osascript` | `notify-send` |
| nginx → native | `host.docker.internal` (Docker Desktop, bind 127.0.0.1 ได้ — spike ✅) | น่าจะเหมือน Windows — **ต้อง spike** | Docker native: container **เข้าไม่ถึง** 127.0.0.1 ของ host → nginx `network_mode: host` (ต้อง spike) |
| port 80 | ได้ | Docker Desktop ได้ | rootless Docker/Podman bind < 1024 ไม่ได้ → fallback `8080` |

Windows implement แล้ว (F-002, `src/platform/`):
- ports: CIM `MSFT_NetTCPConnection State=2` (ไม่ขึ้นกับภาษา Windows, cache 2 วิ / `fresh`); reserved จาก `netsh` (เอาเฉพาะตัวเลข); `canBind(port)` = ไม่มีใครฟังที่ address ไหน (fresh) + bind loopback ได้ทั้ง IPv4/IPv6 (ไม่ bind 0.0.0.0 → ไม่เด้ง firewall); `findFree(range, avoid)` = ตัด listening/reserved/avoid แล้วลอง bind ทีละตัว
- process: `killTree(pid, expectStartedAt)` ต้องส่ง start time ที่จำไว้ตอน spawn → ไม่ตรง = ไม่ฆ่า (`PROCESS_MISMATCH`, กัน PID reuse); หา descendant เอง (ลูกต้องเกิดหลังพ่อ), รอตายภายใน 5 วิ
- elevate: **allowlist ของ task kind** (ไม่มี kind "รันคำสั่ง") → `runas` เรียก `node --openssl-config=NUL dist/platform/elevated.mjs <token>` ด้วย real path, cwd = System32 (ไม่อ่าน OpenSSL config ใดๆ); exit code 40–43 (นอกช่วงที่ node ใช้เอง); token มีอายุ 5 นาที; `elevated.mjs` self-contained (import แค่ `node:*`) validate allowlist ซ้ำในตัว; ตอนนี้มีแค่ `noop` (MVP-2 เพิ่ม `hosts.writeBlock`)
- **pre-elevation guard**: ถ้า non-admin แก้ node.exe / elevated.mjs / โฟลเดอร์ของมัน / ancestor ได้ หรือมี DLL ที่คนอื่นแก้ได้ในโฟลเดอร์ node (รวม real path ถ้าเป็น link; มี `.local` / list โฟลเดอร์ไม่ได้ = ปฏิเสธ) หรือมี env `NODE_*` (ยกเว้น NODE_ENV) / `OPENSSL_*` / `SSL_CERT_*` / `UV_*` / `ICU_*` / ชื่อ non-ASCII (registry ถาวร + volatile + process) → `ELEVATION_UNSAFE` ไม่ถาม UAC. กัน user อื่น/การติดตั้งไม่ปลอดภัย; malware ที่รันเป็น user เดียวกันกันไม่ได้จริง (ต้อง helper แยก). ผล: ต้องติดตั้ง Node + webhub ในโฟลเดอร์ที่ admin เท่านั้นแก้ได้ (เช่น `C:\Program Files`) จึงจะ elevate ได้; helper ถาวรใน Program Files = CR ทีหลัง
- notify: toast ผ่าน PowerShell WinRT (AUMID ของ PowerShell), ข้อความทาง stdin + XML escape, ล้มเหลวคืน `false` ไม่ throw
- error ใช้ `PlatformError` แยกจาก `WebhubError` (ไม่แก้ F-001, R1)

Browser: Chrome/Edge/Firefox resolve `*.localhost` เอง; **Safari ไม่** → พึ่ง hosts sync (macOS ทำอยู่แล้ว)

### 21.2 Modes

| | **Full** (มี Docker) | **Lite** (ไม่มี Docker) |
|---|---|---|
| Proxy | nginx container | reverse proxy ใน daemon (Node `http-proxy` + ws) ฟัง `127.0.0.1` port 80 / 8080 — routes/strip/hostRewrite/deny-list/หน้า error ใช้ logic เดียวกัน |
| Runners | ทั้ง 5 | `static`, `native` (compose/container → ปิด + บอกเหตุผล) |
| Data Hub | shared infra ต่อ major | `external` + SQLite เท่านั้น; DB Studio ใช้ได้กับ connection เหล่านั้น |
| Runtime Manager | system / portable / container | system / portable |

`mode: "auto"` = เลือกตามว่าเจอ Docker ไหม; ติด Docker ทีหลัง → `webhub doctor` เสนอสลับเป็น Full

### 21.3 Site ที่ detect ไม่เจอ / detect ผิด

- `webhub add <path>` / ปุ่ม "Add site" → เลือก profile (หรือ `custom`) → กรอก services, start command, port + via, routes, publicDir
- ทุก field ที่ detect ได้ **แก้ทับได้** (บันทึกเป็น override ใน `data/sites/<name>.json`, rescan ไม่ทับค่าที่ผู้ใช้แก้)
- "Save as profile" → สร้าง profile ใหม่ใน `data/profiles/` ให้ project แบบเดียวกันครั้งหน้า detect เจอเอง

### 21.4 Install + first-run

```
npm i -g webhub            # ต้องมี Node ≥ 22 (ตัว webhub เอง; ไม่เกี่ยวกับ runtime ของ project)
webhub setup
  1. เลือก scan roots (หลายโฟลเดอร์ได้)
  2. ตรวจ Docker → Full / Lite
  3. เลือก HTTP port (80 → ไม่ว่าง/ไม่มีสิทธิ์ → 8080)
  4. hosts sync: ขอสิทธิ์ (UAC/sudo) หรือข้าม (แจ้งข้อจำกัด)
  5. autostart / tray (option)
  6. scan ครั้งแรก → pending list
webhub doctor              # ตรวจซ้ำได้ตลอด
```
- data dir: ค่าเริ่มต้น `%APPDATA%\webhub` (Windows) / `~/Library/Application Support/webhub` / `~/.local/share/webhub` — แยกจากโฟลเดอร์ติดตั้ง npm; ตั้ง `WEBHUB_HOME` ได้
- uninstall: `webhub cleanup --all` (ลบ container/network/hosts block/autostart ที่ webhub สร้าง) → `npm rm -g webhub`
- single binary (Node SEA / `bun build --compile`) + installer: phase หลัง

### 21.5 Profiles สำหรับทุกคน

- profile มี `schemaVersion`; loader validate (JSON Schema) + แจ้ง error ชัดเจน
- `fixtures/<case>/`: project ตัวอย่างขนาดเล็ก (vite, next, elysia, fastapi, compose+pg, monorepo…) + ผลที่คาดหวัง → test ของ detector ทุก profile (ผล scan เครื่องผู้พัฒนาใน §9 เป็น fixture ชุดแรก)
- `webhub profiles export/import` → แชร์ profile ระหว่างเครื่อง/ทีม; profile ที่ import มา **ไม่รันอะไรจนผู้ใช้ approve site**

### 21.6 ความปลอดภัย + ความเข้ากันได้

- **Run approval**: Enable / Start ครั้งแรก → โชว์สิ่งที่จะรันจริง (start command, compose files + override, image ที่จะ pull, install command) → ยืนยัน; เปลี่ยนคำสั่งภายหลัง → ยืนยันใหม่
- **Config migration**: `data/*.json` + `webhub.config.json` มี `schemaVersion` → อัปเดต webhub แล้ว `migrate/` แปลงอัตโนมัติ + backup ไฟล์เดิมก่อน (`data/backups/migrate/<ts>/`); ไฟล์จาก webhub เวอร์ชันใหม่กว่า → ไม่แตะ + error (กันข้อมูลหายตอน downgrade)
- **Store** (F-001): เขียนแบบ atomic (tmp + fsync + rename, เก็บ `.bak`), lock `data/.lock` ให้ daemon เป็นผู้เขียนคนเดียว, ปฏิเสธ symlink + ไฟล์ > 5 MB, validate ด้วย zod (strict) — config ผิด/key ไม่รู้จัก = ไม่ start + บอกทุกจุดที่ผิด
- **Secrets at rest**: `data/secrets.json` เข้ารหัสด้วย **DPAPI (CurrentUser)** + ACL เฉพาะ user; ไม่ fallback เป็น plaintext; macOS/Linux → Keychain / libsecret (phase 13)
- `$WEBHUB_HOME`: env `WEBHUB_HOME` (absolute) → default ต่อ OS; ห้ามเป็น symlink, root ของ drive หรืออยู่ใน scan root; home + parent ต้องเป็นของ user ตัวเอง (หรือ SYSTEM/Administrators); โฟลเดอร์ที่มีอยู่แล้วต้องว่างหรือเป็น home ของ webhub (ไม่ใช่ → ปฏิเสธโดยไม่แตะ); ตรวจทั้ง tree ครั้งแรก (ไม่ตาม junction, ไม่ยอม entry ของ user อื่น) แล้วเขียน marker (รายละเอียด F-001 §3.1)
- เครื่องมือ OS เรียกด้วย path เต็มเสมอ (`%SystemRoot%\System32\…`) ไม่หาใน PATH
- **i18n**: UI/CLI ข้อความผ่าน locale file (`th` default, `en`)
- ไม่มี telemetry / ไม่ส่งข้อมูลออกนอกเครื่อง (ยกเว้นโหลด runtime/image ที่ผู้ใช้สั่ง)

---

## 22. API Studio — ยิง API ของ site

แท็บ **API Studio** ใน dashboard (auth เดียวกับ dashboard). เก็บทุกอย่างใน `$WEBHUB_HOME/data/api/<site>/` — ไม่เขียนลง project (Zero-touch)

### 22.1 ผูกกับ site อัตโนมัติ

- ตัวแปรสำเร็จรูปต่อ site: `{{baseUrl}}` = `http://<site>.localhost`, `{{apiUrl}}` = route backend (`/api` หรือ `api.<site>.localhost`), port ตรงของแต่ละ service, + env ใน env set ที่ active (เลือกเปิดเผยทีละ key)
- สลับ env set (`local` / `remote`) → request ทั้ง collection เปลี่ยนเป้าตาม
- port/route เปลี่ยนใน Port Map → ตัวแปรอัปเดตเอง

### 22.2 สร้าง collection

| แหล่ง | ทำยังไง |
|---|---|
| **OpenAPI / Swagger** | detector หา endpoint spec (`/swagger/json`, `/openapi.json`, `/docs-json`, `/api-docs`, ไฟล์ `openapi.y(a)ml`) → เสนอ import (Elysia `@elysiajs/swagger`: Backend-Hobby, WowMusic, cloudvps, questcloud) |
| cURL | paste → แปลงเป็น request |
| Postman / Insomnia / HAR | import ไฟล์ |
| จาก log | request ที่ผ่าน nginx (access log) → "save as request" |

Export: collection → Postman v2.1 / OpenAPI / cURL

### 22.3 Request

| หมวด | Feature |
|---|---|
| Protocol | REST (ทุก method), GraphQL (introspection + autocomplete), **WebSocket**, **socket.io** (emit/listen event — werewolf), SSE |
| Body | JSON (validate กับ schema จาก OpenAPI), form-data + file upload, x-www-form-urlencoded, raw, binary |
| Auth | Bearer, Basic, API key, cookie jar ต่อ site, **login flow**: request login → ดึง token จาก response → ใส่ request อื่นอัตโนมัติ (refresh เมื่อ 401) |
| Response | pretty JSON/HTML/image, headers, cookies, timing (DNS/connect/TTFB), ขนาด, เทียบกับ response ก่อนหน้า |
| Script | pre-request / post-response (JS sandbox แบบ isolated-vm): set ตัวแปร, assert (`status == 200`, JSON path) |
| Runner | รันทั้ง collection ตามลำดับ + assert → รายงานผ่าน/ไม่ผ่าน; CLI `webhub api run` ใช้ใน script ได้ |
| History | ทุก request ที่ยิง + response ย้อนดูได้, ค้นหา |

### 22.4 เชื่อมกับ DB Studio / Redis

- **DB/Redis diff**: เปิด "Track data" ก่อนยิง → snapshot table/key ที่เลือก (หรือทั้ง DB ขนาดเล็ก) → ยิง → แสดง row ที่ insert/update/delete และ key ที่เปลี่ยน/TTL — ใช้ debug ว่า API แก้อะไรใน DB
  - pg: เทียบ snapshot ของ table ที่เลือก (limit ขนาด) หรือใช้ logical decoding (ต่อยอด)
  - redis: `MONITOR` ช่วงสั้นระหว่างยิง (เฉพาะ DB index ของ site) + เทียบค่า key ที่เปลี่ยน
- จาก response → คลิก id → เปิด row ใน DB Studio

### 22.5 ความปลอดภัย

- request ออกจาก daemon (ไม่ใช่ browser) → ไม่ติด CORS; **จำกัดปลายทาง** ค่าเริ่มต้น = `*.localhost` + `127.0.0.1` + host ใน env set ของ site; host อื่นต้องเพิ่มใน allowlist เอง (กัน SSRF ผ่าน API Studio)
- HTTP client ของ daemon (undici `connect.lookup`, agent ของ `ws`/socket.io) ใช้ resolver ของตัวเอง: `*.localhost` → `127.0.0.1` → API Studio, `webhub api run`, OpenAPI fetch ใช้ได้แม้ผู้ใช้ข้าม hosts sync
- ตัวแปรที่เป็น secret (token, password) → เก็บใน `data/secrets.json` ไม่ปนใน collection ที่ export (export แทนด้วย placeholder)
- script sandbox: ไม่มี filesystem/process access, timeout

### 22.6 Hoppscotch (เครื่องมือเสริม)

- `webhub infra enable hoppscotch` → container self-hosted ที่ `http.localhost` (ผ่าน `auth_request` เหมือนเครื่องมือเสริมอื่น)
- webhub gen environment ของทุก site (`baseUrl`, `apiUrl`) ให้ import ได้
- ใช้ได้ตั้งแต่ MVP-5 ระหว่าง API Studio ยังไม่ครบ; ปิดได้เมื่อไม่ใช้

### 22.7 Implementation

- Backend: `undici` (HTTP), `ws` + `socket.io-client`, `graphql` (introspection), OpenAPI parser (`@apidevtools/swagger-parser`), Postman/HAR importer
- Frontend: Monaco (body/script), viewer เดียวกับ DB Studio
- Sandbox: **isolated-vm** (หรือ QuickJS-wasm) เท่านั้น + memory/time limit — ห้าม `node:vm` (ไม่ใช่ security boundary, script ที่ import มาหลุดถึง process ได้)
