# webhub — Design v4

ศูนย์รวม website ทุกตัวใน `E:\Workspaces\Project`:
scan หา project ที่เป็นเว็บ (ทุกภาษา) → start/stop ให้ → route ผ่าน nginx ไป `http://<name>.localhost` → **แก้ port ได้ทุกตัว** → **รวม database ทุก project ไว้ที่ server เดียว** → **จัดการ SQL / NoSQL / Redis ได้ครบ** — โดย **ไม่แตะ project เลย**

---

## 0. Decisions

> **หลักการสูงสุด — Zero-touch:** project ทุกตัวต้อง **เหมือนเดิม 100%** (ไม่แก้ code, `.env`, `vite.config`, `docker-compose.yml`, `package.json` ฯลฯ). ทุกอย่างที่ต่างไปตอนรันผ่าน webhub (port, env, URL, DB, args, host header) ทำผ่าน **ชั้นนอก** เท่านั้น: process env, CLI args, compose override file, nginx, ไฟล์ใน `_WebHub/data/`. ถอด webhub ออก → project รันแบบเดิมได้ทันที. สิ่งที่ทำผ่านชั้นนอกไม่ได้ → webhub **แจ้งข้อจำกัด** ไม่ไปแก้ project

| เรื่อง | ตัดสินใจ |
|---|---|
| งานหลัก | **Launcher + Router**: start/stop project เอง + route ไป `<name>.localhost` |
| Port | **แก้ได้ทุก port** (web, api, db, nginx, dashboard) ผ่าน dashboard/CLI, Port Map รวม + เช็คชน + rollback |
| Env / URL | env ตั้งผ่าน webhub, **Env Sets** (เช่น `local`/`remote`) สลับได้, **URL Rewrite** เสนอแล้วกดยืนยัน |
| Database | **Shared Infra**: postgres / mysql / mongo / redis อย่างละ 1 ตัว, แต่ละ site ได้ database + user ของตัวเอง; ต่อ site เลือก `shared` / `isolated` / `external` |
| DB tools | **DB Studio** ในตัวที่ `db.localhost`: SQL (pg/mysql/sqlite), MongoDB, Redis — browse/edit/query/schema/import-export + guard กันพลาด; เสริม CloudBeaver/RedisInsight ได้ |
| ภาษา | **Runtime Profiles** แบบ data-driven (YAML) — built-in หลายภาษา + เพิ่มเองได้ไม่ต้องแก้ code |
| ที่เก็บ config | รวมใน `_WebHub/data/` |
| Docker project | `docker compose` ด้วย **project name เดิม** + override file; adopt container ที่รันอยู่แล้ว |
| Hot reload | compose ที่ mount source → default `hybrid` (app native); compose ที่ build image → compose + Rebuild; polling เป็น fallback |
| Non-docker | dev mode native; ไม่มี runtime → fallback `container` ตาม profile |
| Routing backend | **path บน origin เดียวเป็นหลัก** (`/api/`, `/socket.io/`…, `strip` ต่อ route), สลับเป็น subdomain `api.<site>.localhost` ได้ |
| Shared backend | backend ที่ serve หลาย site (Backend-Hobby) = **shared service** + `dependsOn` |
| Start mode | ต่อ site: `manual` / `auto` / `on-demand` |
| เพิ่ม project | scan → `pending` → กด Enable / Ignore |
| Interface | Dashboard + CLI (CLI คุยผ่าน API ของ daemon) |
| Security | API bind `127.0.0.1`, Host/Origin check, **token อัตโนมัติ** ใน cookie; static deny-list |
| nginx | Docker container, resolve upstream ตอน request |
| Version ภาษา | **Runtime Manager**: detect version ที่ project ต้องการ → ใช้ของบนเครื่องถ้าผ่าน range, ไม่ผ่าน → โหลด portable เก็บใน `_WebHub/runtimes/` (ไม่ admin, ไม่แตะ PATH ระบบ), ทำไม่ได้ → `container` (§19.1) |
| Version DB | **server ต่อ major**: pg/redis default ย้ายขึ้น major ล่าสุดตัวเดียว, mysql/mongo default pin major เดิม, ทุก site pin ได้ (site ที่ pin major เดียวกันแชร์ server), ห้าม downgrade (§19.2) |
| Redis engine | `redis:7` default, สลับเป็น **Valkey** ได้ใน config (§19.3) |
| Stack ของ webhub | Node + TypeScript (Fastify + Vite/React) |

สภาพเครื่อง (2026-11-07): Node 24.20, Bun 1.3.11, pnpm 12.9.1, Python 3.14.3, Docker Compose 5.1.1 (daemon ยังไม่เปิด), ไม่มี `trunk`; port 80/443/8080 ว่าง; Windows excluded TCP ranges `50000–50059`, `54288`, `62828–63127`, dynamic range `49152–65535`

---

## 1. Goals

- Scan ลึก 3 ชั้น → จำแนกเว็บ + runtime profile → `pending` รอยืนยัน
- รันได้ 5 แบบ: `static` / `native` / `compose` / `hybrid` / `container`
- **Port Map**: เห็นทุก port ที่ webhub คุม + port ที่ OS/process อื่นใช้/จอง, แก้ได้ทุกตัว, เช็คชนก่อน apply
- **Env & URL**: แก้ env ต่อ site, หลาย env set, rewrite URL ที่ชี้ port เดิมให้เป็น `<site>.localhost`
- **Data Hub**: DB server กลางชุดเดียว, provision database/user ต่อ site, import จาก DB เดิม, backup/restore
- **DB Studio**: เครื่องมือ SQL / MongoDB / Redis ครบในตัว
- **Multi-language**: Node, Bun, Deno, Python, PHP, Ruby, Go, Rust, Java, .NET, Elixir, SSG + custom profile
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
                 │ Manager   Resolver    Manager     Gen              (modes)     backend   :7400│
                 │                       (Data Hub)                                  127.0.0.1  │
                 └──────────────────┬───────────────┬───────────────┬────────────────────────────┘
                                    │               │               │  ▲ CLI (token)
        ┌───────────────────────────▼──┐   ┌────────▼───────────────────────────────┐
        │ webhub-nginx :80             │   │ webhub-infra (docker network "webhub") │
 browser│  <site>.localhost → app      │   │  webhub-postgres  webhub-mysql         │
 ──────►│  hub.localhost → :7400       │   │  webhub-mongo     webhub-redis         │
        │  db.localhost  → :7400/studio│   │  (optional) cloudbeaver, redisinsight  │
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
| Infra Manager | start shared engines, provision, import/backup/restore |
| Nginx Generator | template → temp → `nginx -t` → swap → reload; fail = คง config เดิม |
| Runners | รัน site ตาม runner (§7), adopt container/process ที่รันอยู่ |
| Supervisor | start modes, `dependsOn`, idle stop, restart/backoff, health check |
| DB Studio backend | `DbAdapter` ต่อ engine + guard (§5.7) |
| API + Dashboard | Fastify REST + WS ที่ **7400** bind `127.0.0.1` (ย้ายจาก 4000 เพราะชน werewolf backend), auth §10.3 |

---

## 3. nginx ใน Docker

```yaml
# docker/nginx.compose.yml
services:
  nginx:
    image: nginx:1.27-alpine
    container_name: webhub-nginx
    ports: ["${WEBHUB_HTTP_PORT:-80}:80"]
    volumes:
      - ../nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ../nginx/sites:/etc/nginx/sites:ro
      - ../nginx/errors:/etc/nginx/errors:ro      # หน้า 502/503/504 ของ webhub
      - E:/Workspaces/Project:/projects:ro
      - ../logs/nginx:/var/log/nginx
    extra_hosts: ["host.docker.internal:host-gateway"]
    networks: [webhub]
    restart: unless-stopped
networks:
  webhub: { external: true }
```

- native app → `host.docker.internal:<port>`; compose app (join network `webhub`) → proxy ด้วยชื่อ container ตรง
- **resolve upstream ตอน request** (`resolver 127.0.0.11` + ตัวแปร) → container ที่ยังไม่รันไม่ทำให้ nginx ทั้งตัวพัง (§10.2)
- Static → `root /projects/<folder>/<publicDir>` + deny-list (§10.4)
- HTTP port (80) แก้ได้ใน Port Map → regen + restart nginx

---

## 4. Port Management

### 4.1 Port Map — ทุก port อยู่ที่เดียว

`data/ports.json` เป็น source of truth:

```json
{
  "system": {
    "nginx.http":     { "port": 80,   "locked": true },
    "dashboard":      { "port": 7400, "locked": true },
    "infra.postgres": { "port": 5432 },
    "infra.mysql":    { "port": 3306 },
    "infra.mongo":    { "port": 27017 },
    "infra.redis":    { "port": 6379 }
  },
  "sites": {
    "pos": {
      "frontend": { "port": 4105, "target": 5173, "via": "fixed", "expose": "host" },
      "backend":  { "port": 4106, "target": 3000, "via": "env", "portEnv": "BACKEND_PORT", "expose": "host" }
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
| `expose` | **compose/container:** `host` = publish `127.0.0.1:<port>`, `lan` = `0.0.0.0`, `none` = ภายใน network `webhub` เท่านั้น. **native:** webhub คุมได้แค่ args/env (`--host`, `HOST`) — app ที่ bind `0.0.0.0` ใน code → เสนอ Windows Firewall rule กัน LAN (admin) |
| `locked` | ห้าม auto-reassign |

**`via: fixed` + native:** port บน host = target เสมอ → แก้ไม่ได้, รันพร้อม site อื่นที่ใช้ port เดียวกันไม่ได้ → Port Map ติดป้าย + เสนอสลับเป็น `container` runner (map port ได้)

### 4.2 Default ranges (แก้ได้ใน global config)

| ช่วง | ใช้กับ |
|---|---|
| `80` | nginx |
| `7400` | dashboard/API |
| `4100–4999` | web/api ของ site |
| `14100–14999` | infra แบบ `isolated` ต่อ site |
| ค่ามาตรฐาน (5432, 3306, 27017, 6379) | shared infra |

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
# webhub:auto — generated → data/compose/<name>.override.yml
services:
  app:
    container_name: !reset null              # PPRS/Pos hardcode container_name
    ports: !override ["127.0.0.1:4106:3000", "127.0.0.1:4105:5173"]
    environment: { ... }                     # env set + URL rewrite + DB (§5.4)
    extra_hosts:                             # ให้ server-side เรียก <site>.localhost ผ่าน nginx ได้
      - "pos.localhost:host-gateway"
      - "questcloud.localhost:host-gateway"  # (ทุก site ที่ enabled)
    networks:
      default: {}
      webhub: {}
networks:
  webhub: { external: true }
```

รัน: `docker compose -f <project compose> -f data/compose/<name>.override.yml up -d`
- **ใช้ project name เดิม** (ชื่อโฟลเดอร์) → volume/network เดิมยังอยู่, container ที่ผู้ใช้รันเองคือชุดเดียวกัน
- ใส่ `-p` เฉพาะตอนชื่อโฟลเดอร์ซ้ำกันจริง (เตือนว่าได้ volume ใหม่)
- `container_name` ที่ถูก reset แต่มี env อ้างชื่อเดิม (เช่น `DB_HOST=pos_db`) → ใส่ `networks.default.aliases: [pos_db]` ให้ service นั้น
- **Adopt**: อ่าน `docker compose ls` + label `com.docker.compose.project.working_dir` → container ที่รันจาก folder ของ site อยู่แล้ว = running (ไม่ start ซ้ำ)

---

## 5. Data Hub — รวม Database เป็นที่เดียว

### 5.1 แนวคิด

เดิม: ทุก project ยก postgres/redis ของตัวเอง → ชน port, กิน RAM, ข้อมูลกระจาย
ใหม่: **webhub-infra** มี engine ละ 1 ตัว → แต่ละ site ได้ **database + user แยก** ใน server เดียว

```
webhub-postgres (17)
├── db: pos            user: pos
├── db: werewolf       user: werewolf
├── db: herotime       user: herotime
├── db: cloudvps       user: cloudvps
└── db: questcloud     user: questcloud
webhub-redis (7)
├── db 0: herotime     (REDIS_URL → /0)
├── db 1: werewolf
└── cloudvps, questcloud → ใช้ REDIS_HOST/PORT แยกกัน ระบุ db index ไม่ได้ → isolated (§5.3)
```

### 5.2 Engines

| Engine | Image | แยกต่อ site ด้วย |
|---|---|---|
| PostgreSQL | `postgres:17` | database + role (owner, `CREATEDB` สำหรับ Prisma shadow DB) |
| MySQL / MariaDB | `mysql:8.4` | database + user (GRANT ON db.*) |
| MongoDB | `mongo:7` | database + user |
| Redis / Valkey | `redis:7` (หรือ `valkey/valkey:8`) | DB index 0–15 — **เฉพาะ app ที่ระบุ index ได้** (`REDIS_URL=.../N` หรือ `REDIS_DB`); เกิน 16 site หรือระบุไม่ได้ → `isolated` |
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
    depends_on: !override                  # gen ใหม่: ตัดเฉพาะ service ที่ถูก disable, คง dependency อื่นไว้
      redis: { condition: service_started }
    environment:
      DATABASE_URL: postgres://pos:<pw>@webhub-postgres:5432/pos
```

### 5.4 Env injection

Detector หา env ที่เกี่ยวกับ DB (`DATABASE_URL`, `POSTGRES_*`, `DB_HOST`, `REDIS_URL`, `REDIS_HOST/PORT/PASSWORD`, `MONGO_URI`, `MYSQL_*`…) → webhub เขียนค่าทับให้ (`dbEnv` แก้ได้ต่อ site)

| รันแบบ | host ที่ inject |
|---|---|
| compose / container (join network `webhub`) | `webhub-postgres:5432` |
| native | `127.0.0.1:<infra.postgres port>` |

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

**Engine:** PostgreSQL, MySQL/MariaDB, SQLite, MongoDB, Redis (ต่อยอด: MSSQL, ClickHouse ผ่าน adapter)

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
- shared redis: `rename-command FLUSHALL ""` กัน app ล้างของ site อื่น

#### Implementation
- Backend: `pg`, `mysql2`, `better-sqlite3`, `mongodb`, `ioredis`; interface `DbAdapter` (introspect / query / editRows / export) → engine ใหม่ = adapter ใหม่
- Frontend: Monaco, virtualized grid (TanStack Table / AG Grid community), ER diagram ด้วย React Flow
- Streaming result ผ่าน WebSocket

#### เครื่องมือเสริม (optional)
webhub รัน container + เพิ่ม connection ให้เอง: **CloudBeaver** → `sql.localhost`, **RedisInsight** → `redis.localhost`, **mongo-express** → `mongo.localhost`

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
  check: "python --version"
  install: "pip install -r requirements.txt"   # ปุ่ม Install deps / auto เมื่อไม่มี venv
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
| Python | `django`, `flask`, `fastapi`, `streamlit`, `gradio` | `manage.py runserver {HOST}:{PORT}`, `flask run`, `uvicorn` … (ใช้ venv ใน project ถ้ามี) |
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

Dashboard โชว์ runtime บนเครื่อง (node/bun/python/php/go/cargo/java/dotnet/ruby/trunk…) + version; site ที่ไม่มี runtime → เสนอติดตั้ง (ลิงก์/winget) หรือรันแบบ `container`

---

## 7. Runners

| Runner | ใช้เมื่อ | ทำอะไร |
|---|---|---|
| `static` | static site | nginx serve จาก `/projects/<folder>/<publicDir>` ไม่มี process |
| `native` | มี runtime บนเครื่อง | spawn ตาม profile, inject env/port/DB/URL, เก็บ PID + log |
| `compose` | compose ที่ **build image** (PPRS, cloudvps, questcloud) | override → `compose up -d`; ปุ่ม **Rebuild** + เตือนเมื่อ source/build-time env เปลี่ยน |
| `hybrid` | compose ที่ **mount source + dev server** (werewolf, Pos) หรือ compose มีแค่ infra (herotime) | app → native (hot reload ไว); DB → shared หรือ compose (isolated) |
| `container` | ไม่มี runtime / `via: fixed` ที่ต้องรันพร้อมกัน / profile สั่ง | `docker run` image ตาม profile, mount source, map port |

- polling fallback (สลับต่อ site, สำหรับ compose ที่ยังรัน dev ใน container): `CHOKIDAR_USEPOLLING=true`, `WATCHPACK_POLLING=true`, nodemon `-L` (`bun --watch` ไม่รองรับ)
- deps: ไม่มี `node_modules` / venv → เสนอ install ก่อน start
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
- **Port เดิม + via**: `vite.config` `server.port` (fixed), `.env` (`*PORT=` → env), compose `ports:` (รวม `${VAR:-default}`), `EXPOSE`, script `--port N` (→ เรียก binary ตรง), `.listen(N)` (fixed)
- **DB**: image ใน compose + deps + env keys; redis ระบุ index ได้ไหม
- **URL env**: ค่าเป็น URL → จัดกลุ่มสำหรับ URL Rewrite (§11.2)
- **publicDir**: `public/` / `dist/` / `docs/` ที่มี `index.html` ไม่งั้น root

### ผล scan จริง (2026-11-07)

| Site | Path | Profile | Runner | Port เดิม (via) | Routes | DB เดิม → mode | หมายเหตุ |
|---|---|---|---|---|---|---|---|
| portfolio | Portfolio | static | static | — | `/` | — | |
| visualengine | visualengine | static | static | — | `/` | — | มี `game/`, `test/` ข้างใน |
| rea-website | REA/website | static | static | — | `/` (publicDir `public/`) | — | root REA เป็น MCP ไม่ใช่เว็บ |
| wowmusic | WowMusic | static + bun-elysia | native | api 3000 (env `PORT`) | `/`, `/wowmusic/` (strip:false) | — | หรือ `dependsOn: backend-hobby` |
| backend-hobby | Backend-Hobby | bun-elysia | native | 3000 (fixed) | `/` | — | **shared service** serve `/wowmusic` + `/pprs` |
| pprs | PPRS | bun-elysia | compose | 3200→3000 (fixed) | `/`, `/api/` (strip:false) | — | `container_name: pprs`; สำเนาใน Backend-Hobby/project |
| pos | Pos_on_website | vite + bun-elysia | hybrid | 5173 (fixed), 3000 (env `BACKEND_PORT`) | `/`, `/api/` (strip:true — backend route ที่ `/`) | pg 15 → shared; pgadmin → DB Studio | compose mount source |
| werewolf | werewolfofpower | vite + express | hybrid | 5173 (fixed), 4000 (env `PORT`) | `/`, `/socket.io/` | pg 16 → shared, redis 7 → shared | `init.sql`; env set `local`/`remote` (DDNS) |
| herotime | herotime | nestjs (pnpm) | hybrid | 3000 (env `PORT`) | `/` | pg 17 → shared, redis 7 → shared | server อยู่ใน profile `scale`; `apps/web` build-only |
| cloudvps | cloudvps/* | next + bun-elysia | compose ×2 | 3001 (script → arg), 3000 (env `PORT`) | `/`, `/api/` (strip:false) | pg 15 → shared, redis 7 → isolated | redis ใช้ HOST/PORT |
| questcloud | qusetcloud/* | next + bun-elysia | compose ×2 | 3001 (script → arg), 3000 (env `PORT`) | `/`, `/api/` (strip:false) | pg 15 → shared, redis 7 → isolated | NextAuth เรียก API ฝั่ง server → `extra_hosts` |
| craft-anything-web | craft-anything/apps/craft-anything-web | rust-trunk | native | — | `/` | — | ต้องลง `trunk` (pending) |

**ไม่ใช่เว็บ:** ads-remove, download_manga (extension), PhiTheGhostHunting, RiderCardBattle (Roblox), Reclaim (Unreal), scamwithfriends_thmod (C# mod), LineBankVerify, translate_manga, video_decode_subtitle, auto_train_fish (Python script/GUI), battleofmyfriends, translate_manga_release (ว่าง/เอกสาร), craft-anything crates อื่น

**DB ที่ย้ายเข้า shared:** postgres ×5 (pos, werewolf, herotime, cloudvps, questcloud), redis ×2 (werewolf, herotime); redis ×2 isolated (cloudvps, questcloud); pgadmin ของ pos → แทนด้วย DB Studio

---

## 10. Routing & Security

### 10.1 Hostnames

`http://<name>.localhost` (Chrome/Edge resolve เอง). Reserved (ห้ามเป็นชื่อ site, validate ตอน approve): `hub`, `db`, `sql`, `redis`, `mongo`, `api.*`

- ใน container: `extra_hosts` ทุก site → `host-gateway` (§4.4) → server-side เรียก `<site>.localhost` ผ่าน nginx ได้
- native: **hosts file sync จำเป็น** (`127.0.0.1 <site>.localhost`, admin) — spike พบว่า Node / Bun / Python บน Windows resolve `*.localhost` ไม่ได้ (`ENOTFOUND`); webhub เขียน block `# webhub:begin … # webhub:end` ใน `C:\Windows\System32\drivers\etc\hosts` ผ่าน UAC prompt ครั้งเดียวตอนเพิ่ม/ลบ site; ไม่ให้สิทธิ์ admin → site ที่มี server-side call ไป `<site>.localhost` ติดป้ายเตือน

### 10.2 Generated config

```nginx
# webhub:auto  site=questcloud  runner=compose
server {
    listen 80;
    server_name questcloud.localhost;
    resolver 127.0.0.11 valid=10s ipv6=off;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_intercept_errors on;
    error_page 502 503 504 = @wake;

    location / {                                  # next (frontend)
        set $up http://questcloud-frontend-web-1:3000;
        proxy_set_header Host localhost:3000;     # hostRewrite (dev server)
        proxy_pass $up;
    }
    location /api/ {                              # strip:false
        set $up http://questcloud-backend-api-1:3000;
        proxy_set_header Host $host;
        proxy_pass $up;
    }
    location @wake { proxy_pass http://host.docker.internal:7400/_wake?site=questcloud; }
}
```

- route `strip:true` → `rewrite ^/api/(.*)$ /$1 break;` (proxy_pass แบบตัวแปรไม่ตัด prefix ให้)
- native → `set $up http://host.docker.internal:<port>;`
- gen ลง temp → `nginx -t` → swap → reload; fail = คง config เดิม + error ใน dashboard
- หน้า 502/503/504 ของ webhub: สถานะ site + ปุ่ม Start + ลิงก์ log
- กฎ: header `# webhub:auto` = gen ทับได้; ไม่มี header = ผู้ใช้แก้เอง ห้ามทับ

### 10.3 Dashboard / API auth

- API bind `127.0.0.1:7400` เท่านั้น; nginx proxy ให้ที่ `hub.localhost` / `db.localhost`
- `Host` allowlist: `hub.localhost`, `db.localhost`, `127.0.0.1:7400` → กัน DNS rebinding
- `Origin` check ทุก request ที่แก้ข้อมูล → กัน CSRF
- Token สุ่มใน `data/auth.json`; `webhub ui` เปิด one-time link → set cookie `HttpOnly; SameSite=Strict`; CLI อ่าน token จากไฟล์
- เปิด `lan` / tunnel → บังคับ password + เตือน; DB ที่ `expose: lan` ต้อง password แรง

### 10.4 Static site protection

- `publicDir` detect + แก้ได้
- default deny:
  ```nginx
  location ~ /\.  { deny all; }                                        # .git .env .gitignore
  location ~* \.(md|lock|log|ts|tsx|py|env|ya?ml|toml|sql)$ { deny all; }
  location ^~ /backend/ { deny all; }                                  # folder ของ service อื่นใน site
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
  "scanRoots": ["E:/Workspaces/Project"],
  "maxDepth": 3,
  "ignore": ["node_modules", ".git", "dist", "build", "venv", ".venv", "target", "_WebHub", "Library", "Intermediate", "DerivedDataCache"],
  "domainSuffix": "localhost",
  "reservedNames": ["hub", "db", "sql", "redis", "mongo"],
  "ports": { "web": [4100, 4999], "isolatedInfra": [14100, 14999] },
  "infra": {
    "postgres": { "image": "postgres:17" },
    "mysql":    { "image": "mysql:8.4" },
    "mongo":    { "image": "mongo:7" },
    "redis":    { "image": "redis:7" }
  },
  "defaultEnv": { "NODE_ENV": "development" },
  "onDemand": { "idleStopMinutes": 30 },
  "profilesDir": ["./profiles", "./data/profiles"]
}
```
(port ทั้งหมดอยู่ใน `data/ports.json` — §4.1)

### 11.4 ต่อ site — `data/sites/<name>.json`
```json
{
  "name": "questcloud",
  "path": "E:/Workspaces/Project/qusetcloud",
  "status": "enabled",
  "runner": "compose",
  "compose": { "files": ["questcloud-frontend/docker-compose.yml", "questcloud-backend/docker-compose.yml"], "projectName": null },
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
    "postgres": { "mode": "shared", "disableComposeServices": ["postgres"] },
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
  "static": null,
  "detected": { "score": 120, "markers": ["next", "elysia", "compose:postgres:15", "compose:redis:7"] }
}
```

`data/secrets.json` (password DB) + `data/auth.json` + `data/` ทั้งหมด → `.gitignore`

---

## 12. Folder Structure

```
_WebHub/
├── DESIGN.md
├── webhub.config.json
├── package.json
├── profiles/                 # built-in runtime profiles (*.yml)
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
│   ├── studio/
│   │   ├── adapter.ts        # DbAdapter interface
│   │   ├── adapters/{postgres,mysql,sqlite,mongo,redis}.ts
│   │   └── guard.ts          # read-only, dangerous-command confirm, timeout, audit
│   ├── nginx/{generator.ts, control.ts, templates/}
│   ├── runners/{static,native,compose,hybrid,container}.ts
│   ├── supervisor.ts         # start modes, dependsOn, idle, restart, health
│   └── server/{api.ts, auth.ts}               # REST + WS + /_wake + Host/Origin/token
├── dashboard/                # Vite + React
├── docker/{nginx.compose.yml, infra.compose.yml}
├── nginx/{nginx.conf, sites/, errors/}
├── runtimes/                 # gitignored: portable runtimes <lang>/<ver>/
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
webhub infra up|down|status
webhub reload | ui
```

---

## 14. Dashboard

```
┌ webhub ──── [Sites] [Port Map] [Data Hub] [DB Studio] [Profiles] ── [Rescan] ┐
│ nginx ● :80   infra ● pg redis   docker ●   sites 12 · running 5              │
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
│ werewolf       backend   4107       4000    env    host    ⚠ conflict(PID 1234)│
│ (Windows)      reserved  50000-50059 —      —      —       ⛔ reserved          │

[Data Hub]
│ Engine    Database    Site        Size    Mode      Act                        │
│ postgres  questcloud  questcloud  12 MB   shared    [URL] [Studio] [Backup]    │
│ redis     —           questcloud  —       isolated  [URL] [Studio]             │
│ redis     db1         werewolf    —       shared                               │
│ [Import from project DB] [Backup all]                                          │

[DB Studio — db.localhost]
┌ Connections ──────┐┌ Query 1 × │ users × │ + ──────────────────────────────┐
│ ▾ pg (shared)     ││ SELECT * FROM users WHERE created_at > :since;      │
│   ▾ questcloud    ││ [▶ Run] [Explain] [Format] [Save]   auto-commit ☑   │
│     ▾ public      │├─────────────────────────────────────────────────────┤
│       ▸ users     ││ id │ name   │ email          │ created_at          │
│       ▸ vps       ││ 1  │ Somchai│ s@x.com  ✎     │ 2026-11-01 10:00    │
│   ▸ werewolf      ││ ... 1,000 rows · 23 ms   [Export ▾] [Save changes(1)]│
│ ▾ redis (shared)  │└─────────────────────────────────────────────────────┘
│   ▸ db1 werewolf  │  Redis: ▾ session: (120) ▾ room: (8)  key=room:42 hash TTL 3600
│ ▸ mongo           │  Mongo: [Filter {}] [Aggregate +stage] JSON/Table view
└───────────────────┘

⚙ Site: services | routes (path/strip/ws/subdomain) | profile + start cmd | ports
        | env + env sets | URL rewrite | database mode | start mode + dependsOn | static rules
```

---

## 15. Roadmap

0. ~~Spike~~ ✅ เสร็จ 2026-11-07 (ผลใน §18)
1. **MVP-1** — profiles loader + scanner + detector (routes, via, URL env, DB) + dedupe + `scan/approve/list`; daemon + CLI client + auth (token, Host/Origin)
2. **MVP-2** — nginx container + generator (resolver/variables, validate/swap) + static (publicDir, deny-list)
3. **MVP-3** — Port Manager (ports.json, probe 3 ชั้น, edit/apply/rollback) + native runner + Runtime Manager (Node/Bun/Python portable) + env resolver + env sets + URL rewrite
4. **MVP-4** — compose runner (project name เดิม, adopt, override, extra_hosts, rebuild) + hybrid
5. **MVP-5** — Data Hub: shared postgres + redis (server ต่อ major, upgrade/pin, pre-upgrade check), provision, env injection, disable DB services, import จาก volume เดิม
6. **MVP-6** — Dashboard (Sites, Port Map, Data Hub)
7. **DB Studio v1** — SQL (pg): browser, data grid + edit, SQL editor + autocomplete, history, export; Redis: key browser, value editor, TTL, console; guard
8. backup/restore, mysql + mongo (infra + studio), start modes `auto`/`on-demand` + `dependsOn`
9. **DB Studio v2** — EXPLAIN, schema/DDL editor, ER diagram, Mongo aggregation builder, Redis pub/sub + slowlog + memory, sqlite; optional CloudBeaver/RedisInsight
10. Profiles เพิ่ม (PHP, Ruby, Go, Java, .NET, Elixir, SSG) + container runner fallback
11. health check, watch mode, mkcert HTTPS, hosts sync, export config ไป VPS

---

## 16. Risks / Open

- Port/host hardcode (Backend-Hobby, PPRS `.listen(3000)`, vite `port: 5173`) → `via: fixed`, แก้ได้แค่ผ่าน container mapping
- App bind `0.0.0.0` ใน code (Bun/Elysia default) → เปิดออก LAN; คุมได้แค่ Firewall
- Shared DB: version/extension ต่างกัน, DB host hardcode, redis ระบุ index ไม่ได้ → `isolated`
- Import: ต้อง start DB เดิมชั่วคราว → ใน network ภายใน ไม่ publish
- Compose ≥ 2.24 สำหรับ `!override` / `!reset` (เครื่องนี้ 5.1.1 ผ่าน)
- Docker Desktop ต้องเปิดก่อน; port 80 ถูกจองทีหลัง → แก้ใน Port Map
- Windows excluded port ranges เปลี่ยนทุก reboot → probe ทุกครั้ง
- Scope: DB Studio ใหญ่ → แบ่ง v1/v2, เครื่องมือเสริมเติมช่องว่าง
- Secret ใน `data/` → ห้าม commit

---

## 17. Review log (v3 → v4)

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
| — | inconsistency v3 | Adminer → DB Studio; postgres ×6 → ×5; `depends_on: !reset []` → gen ใหม่ตัดเฉพาะ DB; alias ชื่อ container เดิม; CLI ผ่าน daemon | ทั้งเอกสาร |

### Backlog — function ที่ยังไม่ได้ตัดสิน
- Shared **Mailpit** (cloudvps/questcloud มี `EMAIL_HOST`) และ **MinIO** (herotime `uploads`)
- webhub auto-start ตอน login (Task Scheduler) / tray icon
- CPU/RAM ต่อ site, แจ้งเตือน crash
- backup ตามเวลา + retention
- ปุ่มเปิดใน VS Code / terminal / folder, git branch/status, alias หลายชื่อต่อ site
- export/import config ของ webhub, cleanup container/volume ที่ webhub สร้าง

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
  → ไม่ผ่าน → มีใน _WebHub/runtimes? → ใช้ (source: webhub)
  → ไม่มี → โหลด portable ได้?        → โหลด + verify checksum → ใช้ (source: webhub)
  → ไม่ได้                          → runner `container` image version ตรง (source: container)
```

| ภาษา | Portable |
|---|---|
| Node | zip ทางการ `nodejs.org/dist/vX/node-vX-win-x64.zip` + `SHASUMS256.txt` |
| Bun | release zip ทางการ (`bun-windows-x64.zip`) ต่อ version |
| pnpm / yarn | ตาม `packageManager` ผ่าน corepack ของ Node ที่เลือก หรือ `npx pnpm@x` |
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
webhub-postgres-17   :5432   ← default ของ pg (major ล่าสุด)
webhub-postgres-15   :5415   ← เกิดขึ้นเฉพาะเมื่อมี site pin 15 (site ที่ pin 15 แชร์กัน)
webhub-redis-7       :6379
webhub-mysql-8.4     :3306
```

| Engine | Default policy | เหตุผล |
|---|---|---|
| PostgreSQL | **upgrade → major ล่าสุด** | dump/restore ข้าม major ได้, ปัญหาน้อย |
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
- Port: major default ใช้ port มาตรฐาน; major อื่น = `<prefix><major>` (เช่น pg 15 → `5415`) แก้ได้ใน Port Map
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
    devServer: { hostRewrite: true }          # allowedDevOrigins
  - when: { dep: "next", range: "<13" }
    start: { cmd: "next dev -p {PORT} -H {HOST}" }
```
