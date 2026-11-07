# Design review — DESIGN v7 → v8

| | |
|---|---|
| วันที่ | 2026-11-07 |
| Reviewer | agent (อ่านเอกสารทั้งฉบับ) + ยืนยันกับเอกสารโดย Claude |
| ผล | 16 findings — แก้ครบใน v8 (commit `bf55188`) + จุดตกค้าง 6 จุด |

| # | ระดับ | ประเด็น | แก้ |
|---|---|---|---|
| 1 | critical | nginx `@wake` ใส่ URI ใน named location ไม่ได้; `proxy_set_header` ใน location ทำ header ระดับ server หาย | rewrite + `proxy.conf` include ทุก location |
| 2 | critical | Host allowlist ปฏิเสธ request ภายในจาก nginx | Host `webhub.internal` เฉพาะ endpoint ภายใน |
| 3 | critical (security) | cookie host-only ไม่ถึง tool host; `Domain=localhost` จะรั่วไปทุก site | login handoff ต่อ host |
| 4 | critical (security) | nginx publish `0.0.0.0` | `127.0.0.1` + `expose` ของ system |
| 5 | major (Zero-touch) | install แก้ lockfile, corepack pin `packageManager` | frozen lockfile, `COREPACK_ENABLE_AUTO_PIN=0`, `PYTHONDONTWRITEBYTECODE=1` |
| 6 | critical (security) | `node:vm` ไม่ใช่ sandbox | isolated-vm |
| 7 | major | path ของ generated config ไม่ตรง `$WEBHUB_HOME` | generate ลง `$WEBHUB_HOME`, mount absolute |
| 8 | major | compose หลาย dir ใน site เดียว | 1 compose project ต่อ dir |
| 9 | major | project name / depends_on ของ service อื่น | `compose config` + disable dependents |
| 10 | major | vite `server.port` ถูก CLI ทับได้ | `via: arg` |
| 11 | major | roadmap ลำดับ dependency ผิด | container runner → MVP-3, start modes → MVP-4, backup → MVP-5 |
| 12 | major | HTTP port ≠ 80 ทำ URL พัง | ต่อ `:port` ทุก URL ที่ gen |
| 13 | major | mysql/mariadb ชน 3306, prefix port ใช้ไม่ได้ทุก engine | mariadb 3307, pinned `15000–15999` |
| 14 | minor | policy `latest` กำกวม, `rename-command FLUSHALL` ขัด Studio | นิยาม `default`, redis ACL |
| 15 | major | `extra_hosts` ทุก site → recreate ทุก container | nginx network alias (ต้อง spike) |
| 16 | minor | reserved names / CLI / ignore / deny-list hardcode | เพิ่ม + generate |
