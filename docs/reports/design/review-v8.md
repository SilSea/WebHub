# Design review — DESIGN v8 → v9

| | |
|---|---|
| วันที่ | 2026-11-07 |
| Reviewer | agent ใหม่ (ไม่รู้ว่ารอบก่อนแก้อะไร) + ยืนยันกับเอกสารโดย Claude |
| ผล | 9 findings — แก้ครบใน v9 (commit `28c0cae`) |

| # | ระดับ | ประเด็น | แก้ |
|---|---|---|---|
| 1 | critical (security) | master token cookie ถูกส่งต่อเข้า container ของเครื่องมือเสริม → replay ไป API ได้ | session cookie ต่อ host + nginx ลบ cookie `webhub_*` ก่อนส่งต่อ |
| 2 | major | API Studio (daemon/Node) resolve `*.localhost` ไม่ได้ถ้าข้าม hosts sync | resolver ของ daemon map `*.localhost` → 127.0.0.1 |
| 3 | major | `proxy_intercept_errors on` ทับ 5xx ของ app ด้วยหน้า wake | ลบออก |
| 4 | major (security) | redis ACL ต่อ site ใช้ไม่ได้กับ app ที่ไม่มี username | shared เฉพาะ app ที่มี URL/username, ปิด user `default` |
| 5 | minor | mongo-express phase ขัดกัน | phase 8 |
| 6 | major | native `target` ≠ `port` | native: `target` = `port` |
| 7 | major | override path relative กับ cwd ของ project | absolute `$WEBHUB_HOME/...` |
| 8 | major (Zero-touch) | `next dev` เขียน `next-env.d.ts` / แก้ `tsconfig.json` | ข้อจำกัดที่รู้แล้ว + แจ้งใน run approval + แนะนำ container runner |
| 9 | minor (Zero-touch) | `git status` เขียน `.git/index` | `--no-optional-locks` |

ค้าง (spike): Next ≥15 `allowedDevOrigins`, nginx network alias
