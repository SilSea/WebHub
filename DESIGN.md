# webhub — Draft Design

รวมศูนย์ website ทุกตัวใน `E:\Workspaces\Project` → scan หา project ที่เป็นเว็บ → gen nginx config → เข้าแต่ละเว็บผ่าน `http://<name>.localhost`

---

## 1. Goals

- Scan folder project (ลึก 3 ชั้น เพราะหลาย project แยก `frontend/` `backend/`)
- จำแนก project เป็นเว็บหรือไม่ + ชนิดเว็บ (static / node / python / docker / php)
- Gen nginx server block แยกต่อเว็บ, reload อัตโนมัติ
- Dashboard รวม: สถานะ, start/stop, เปิดเว็บ, ดู log
- Override ได้ต่อ project ผ่าน `.webhub.json`

Non-goals (MVP): SSL จริง, deploy ขึ้น server, multi-machine

---

## 2. Architecture

```
            ┌──────────┐   ┌───────────┐   ┌──────────┐
 Project/ ─►│ Scanner  │──►│ Detector  │──►│ Registry │ (sites.json / SQLite)
            └──────────┘   └───────────┘   └────┬─────┘
                                                │
                ┌───────────────┬───────────────┼────────────────┐
                ▼               ▼               ▼                ▼
          ┌──────────┐   ┌────────────┐   ┌───────────┐   ┌───────────┐
          │ Port     │   │ Nginx      │   │ Process   │   │ Dashboard │
          │ Allocator│   │ Generator  │   │ Runner    │   │ (Web UI)  │
          └──────────┘   └─────┬──────┘   └───────────┘   └───────────┘
                               ▼
                     nginx/sites/*.conf  →  nginx -s reload
```

| Module | หน้าที่ |
|---|---|
| Scanner | เดิน folder, skip `node_modules`, `.git`, `dist`, `venv`, `target`, `_WebHub` เอง |
| Detector | ให้คะแนนจาก marker file → ตัดสินว่าเป็นเว็บ + type + start command + port |
| Registry | เก็บ site list, state, port, override |
| Port Allocator | จอง port ช่วง `4100-4999`, กันชน |
| Nginx Generator | template → `sites/<name>.conf`, `nginx -t` ก่อน reload |
| Process Runner | spawn dev server / `docker compose up`, เก็บ PID + log |
| Dashboard | UI ที่ `http://hub.localhost` |

---

## 3. Detection Rules (scoring)

score ≥ 50 = เว็บ

| Marker | Score | Type |
|---|---|---|
| `package.json` มี `vite` / `next` / `nuxt` / `react-scripts` / `@angular/core` / `svelte` | +60 | node-frontend |
| `package.json` มี `express` / `fastify` / `koa` / `@nestjs/core` | +50 | node-backend |
| `package.json` scripts มี `dev` / `start` / `serve` | +10 | — |
| `index.html` ที่ root หรือ `public/` | +50 | static |
| `requirements.txt` / `pyproject.toml` มี `flask` / `django` / `fastapi` / `uvicorn` | +60 | python |
| `manage.py` | +40 | python (django) |
| `composer.json` / `index.php` | +60 | php |
| `docker-compose.yml` มี `ports:` | +40 | docker |
| `Dockerfile` มี `EXPOSE` | +20 | docker |
| `Cargo.toml` มี `axum` / `actix-web`, `go.mod` มี `gin` / `echo` / `fiber` | +50 | other |
| มี `electron` / `tauri` / `unity` ใน deps | −40 | ไม่ใช่เว็บ |

**Monorepo:** ถ้า sub-folder (`frontend/`, `client/`, `web/`, `backend/`, `server/`, `api/`) เป็นเว็บ → รวมเป็น site เดียว
- frontend → `/`
- backend → `/api/`

**Port detect:** อ่านจาก `vite.config.*` (`server.port`), `.env` (`PORT=`), compose `ports:`, `EXPOSE` → ถ้าไม่เจอ ให้ allocator จองให้แล้วส่งผ่าน env `PORT`

### ผล scan ปัจจุบัน (คาดการณ์ ต้อง verify)

| Project | Marker | น่าจะเป็น |
|---|---|---|
| Portfolio | index.html | static |
| WowMusic | index.html | static |
| visualengine | index.html | static (เช็คอีกที) |
| herotime | package.json, compose | docker / node |
| Pos_on_website | package.json, compose | docker / node |
| PPRS | package.json, compose | docker / node |
| Backend-Hobby | package.json, Dockerfile | node-backend |
| werewolfofpower | compose | docker |
| LineBankVerify | requirements.txt | python? |
| REA | package.json | ต้องเช็ค deps |

---

## 4. Routing Strategy

**เลือก: subdomain** `http://<name>.localhost`
- Chrome/Edge resolve `*.localhost` → `127.0.0.1` เอง ไม่ต้องแก้ hosts
- SPA ไม่พัง asset path (ต่างจาก path prefix `/name/` ที่ต้องแก้ `base`)
- ถ้าต้องใช้กับ tool อื่น (curl, Postman) → option เขียน `C:\Windows\System32\drivers\etc\hosts` (ต้อง admin)

Fallback: path prefix `http://localhost/<name>/` เปิดได้ต่อ site ใน `.webhub.json`

### Generated config ตัวอย่าง

Static:
```nginx
# webhub:auto  site=portfolio  type=static
server {
    listen 80;
    server_name portfolio.localhost;
    root "E:/Workspaces/Project/Portfolio";
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}
```

Proxy (node/python/docker) + websocket (HMR):
```nginx
# webhub:auto  site=pprs  type=docker
server {
    listen 80;
    server_name pprs.localhost;

    location / {
        proxy_pass http://127.0.0.1:4103;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4104/;
    }
}
```

`nginx.conf` หลัก:
```nginx
http {
    include       mime.types;
    include       "E:/Workspaces/Project/_WebHub/nginx/sites/*.conf";
}
```

กฎ: ไฟล์ที่มี header `# webhub:auto` = gen ทับได้. ไม่มี header = user แก้เอง ห้ามทับ

---

## 5. Override ต่อ project — `.webhub.json`

```json
{
  "name": "pos",
  "enabled": true,
  "type": "node",
  "root": "frontend",
  "start": "npm run dev -- --port {PORT}",
  "port": 5173,
  "routes": {
    "/":     { "dir": "frontend", "start": "npm run dev" },
    "/api/": { "dir": "backend",  "start": "npm start", "port": 3000 }
  },
  "env": { "NODE_ENV": "development" }
}
```

---

## 6. Global Config — `webhub.config.json`

```json
{
  "scanRoots": ["E:/Workspaces/Project"],
  "maxDepth": 3,
  "ignore": ["node_modules", ".git", "dist", "build", "venv", ".venv", "target", "_WebHub"],
  "domainSuffix": "localhost",
  "portRange": [4100, 4999],
  "nginx": {
    "exe": "C:/nginx/nginx.exe",
    "sitesDir": "./nginx/sites"
  },
  "dashboard": { "host": "hub.localhost", "port": 4000 }
}
```

---

## 7. Folder Structure

```
_WebHub/
├── DESIGN.md
├── webhub.config.json
├── package.json
├── src/
│   ├── cli.ts              # entry: webhub scan|up|down|list|reload
│   ├── scanner/
│   │   ├── walk.ts
│   │   └── detectors/      # 1 ไฟล์ต่อ type
│   │       ├── node.ts
│   │       ├── static.ts
│   │       ├── python.ts
│   │       ├── docker.ts
│   │       └── php.ts
│   ├── registry/
│   │   └── store.ts        # sites.json หรือ SQLite
│   ├── ports/allocator.ts
│   ├── nginx/
│   │   ├── generator.ts
│   │   ├── templates/      # static.conf.hbs, proxy.conf.hbs
│   │   └── control.ts      # nginx -t, -s reload, start/stop
│   ├── runner/
│   │   └── process.ts      # spawn, PID, log ring buffer
│   └── server/
│       └── api.ts          # REST + WebSocket ให้ dashboard
├── dashboard/              # Vite + React (หรือ HTML ล้วน)
├── nginx/
│   ├── nginx.conf
│   └── sites/              # generated *.conf
├── data/
│   └── sites.json
└── logs/
```

---

## 8. Tech Stack (แนะนำ)

| ส่วน | เลือก | เหตุผล |
|---|---|---|
| Core + API | Node.js + TypeScript + Fastify | project ส่วนใหญ่เป็น node อยู่แล้ว, spawn process ง่าย |
| Storage | `sites.json` (MVP) → SQLite ทีหลัง | เริ่มง่าย |
| Dashboard | Vite + React | serve ผ่าน nginx ที่ `hub.localhost` |
| nginx | nginx for Windows native | ไม่ต้องพึ่ง Docker, root path ตรง |
| File watch | chokidar | auto rescan เมื่อมี project ใหม่ |

ทางเลือก: Go single binary (ไม่ต้องลง Node), หรือ Flutter desktop ถ้าอยากได้ app แทน web UI

---

## 9. CLI

```
webhub scan            # scan + update registry (dry-run แสดงผลก่อน)
webhub list            # ตาราง site, type, port, status
webhub up <name|all>   # start process + gen conf + reload nginx
webhub down <name|all>
webhub reload          # regen conf ทั้งหมด + nginx -t + reload
webhub open <name>     # เปิด browser
webhub ui              # start dashboard
```

---

## 10. Dashboard (wireframe)

```
┌ webhub ───────────────────────────────── [Rescan] [Reload nginx] ┐
│ nginx: ● running   sites: 9   running: 4                          │
├───────────────────────────────────────────────────────────────────┤
│ Name           Type     URL                     Port  Status  Act │
│ portfolio      static   portfolio.localhost      -    ● on    ⏹ ↗ │
│ pprs           docker   pprs.localhost          4103  ● on    ⏹ ↗ │
│ pos            node     pos.localhost           4105  ○ off   ▶   │
│ herotime       docker   herotime.localhost      4107  ⚠ error ▶ 📄│
├───────────────────────────────────────────────────────────────────┤
│ Detected but disabled: REA (score 30) [Enable] [Ignore]           │
└───────────────────────────────────────────────────────────────────┘
```

---

## 11. Roadmap

1. **MVP** — scanner + detector + `webhub list` (ยังไม่แตะ nginx)
2. nginx generator + reload, static site ใช้ได้
3. process runner, node/python proxy
4. docker compose support
5. dashboard
6. watch mode, health check, log viewer
7. (optional) mkcert HTTPS, hosts file sync, export config ไป VPS (`cloudvps`)

## 12. Risks

- Port ชน กับ dev server ที่ hardcode port → อ่าน config ก่อน, ถ้าชนแจ้งเตือน
- Vite HMR ผ่าน proxy → ต้อง websocket header (มีใน template แล้ว)
- nginx Windows path ต้องใช้ `/` และใส่ quote ถ้ามี space
- port 80 อาจโดน IIS/Skype จอง → fallback `8080`
