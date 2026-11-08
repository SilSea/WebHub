# Plan — แผนพัฒนา webhub

อ้างอิง: [`DESIGN.md`](../DESIGN.md) §15 Roadmap · ขั้นตอนทำงาน: [`WORKFLOW.md`](WORKFLOW.md) · สถานะ: [`features/README.md`](features/README.md)

งานแต่ละตัวต้องผ่าน **W1** (ออกแบบ → ถามความเห็น → เอกสาร → ใส่ Plan queue เป็น `planned`) ก่อน แล้ว **W3** จึงลงมือทำ (WORKFLOW.md)

## 0. Plan queue (W3 ทำจากบนลงล่าง)

| ลำดับ | งาน | Status | Spec |
|---|---|---|---|
| 1 | F-000 Repo scaffolding | `done` | [spec](features/F-000-scaffolding.md) |
| 2 | F-001 Config + `$WEBHUB_HOME` + migration | `done` | [spec](features/F-001-config.md) |
| 3 | F-002 Platform layer (Windows): ports, process, elevate, notify | `done` | [spec](features/F-002-platform.md) |
| 4 | F-003 Daemon + API server + auth | `in-progress` | [spec](features/F-003-daemon-api-auth.md) |

งาน `todo` ด้านล่างยังไม่เข้า queue จนกว่าจะผ่าน W1

**ติดตามต่อ (ไม่ใช่งานใน queue):** F-001 test "4 processes taking over the same stale lock → exactly one wins" fail เมื่อเครื่องโหลดหนัก (พบ 4 ครั้งระหว่าง W3 ของ F-003; รันเดี่ยวผ่าน) — อาจเป็นแค่ timeout หรือ race จริง (2 process ชนะ). ผู้ใช้สั่ง (2026-11-08): หลัง F-003 เสร็จ สืบแบบอ่านอย่างเดียว (เก็บ output ของแต่ละ process) แล้วเสนอ CR ตาม W2 — ห้ามแก้ F-001 ก่อน CR อนุมัติ (R1)

---

## 1. ลำดับ + dependency

```
F-000 ─► F-001 ─► F-002 ─► F-003 ─► F-004
                    │        │
                    │        └─► F-005 ─► F-006 ─► F-007 ─► F-008      (MVP-1)
                    ├─► F-011 (hosts)
F-007 ─► F-009 ─► F-010, F-012, F-013                                  (MVP-2)
F-007 ─► F-014 ─► F-015 ─► F-016 ─► F-017 ─► F-018                     (MVP-3)
F-017 ─► F-019 ─► F-020 ─► F-021                                       (MVP-4)
F-019 ─► F-022 ─► F-023 ─► F-024 ─► F-025 ; F-022 ─► F-026             (MVP-5)
F-021 ─► F-027 ─► F-028, F-029                                         (MVP-6)
```

เหตุผลลำดับ: config + Platform + auth มาก่อนทุกอย่าง (R6: daemon ต้องปลอดภัยตั้งแต่ endpoint แรก) → detect ได้ก่อนรัน → route ได้ก่อนจัดการ port/runner → runner ก่อน DB (DB ต้องมี compose override) → dashboard รวมทีหลังเมื่อ API นิ่ง

## 2. Features

### MVP-0 — Foundation
| ID | Function | DESIGN | Security focus | ความเสี่ยงหลัก |
|---|---|---|---|---|
| F-000 | Repo scaffolding: TS, package layout (§12), test framework, lint, CI, fixture harness + Zero-touch hash check | §12, §21.5 | lockfile, `npm audit` ใน CI, ไม่มี secret ใน repo | เลือก tool ผิดแล้วเปลี่ยนยาก |

### MVP-1 — Core + Detect
| ID | Function | DESIGN | Security focus | ความเสี่ยงหลัก |
|---|---|---|---|---|
| F-001 | Config + `$WEBHUB_HOME` + schemaVersion + migration | §11.3, §21.4, §21.6 | สิทธิ์ไฟล์ `data/`, secrets แยกไฟล์ | migration ทำข้อมูลเสีย → backup ก่อน migrate |
| F-002 | Platform layer (Windows): ports, process, elevate, notify | §21.1 | `elevate()` แสดงสิ่งที่จะทำ, ไม่ต่อ string เข้า shell | PowerShell ช้า / เปลี่ยนตาม version Windows |
| F-003 | Daemon + API server + auth (token, Host allowlist, Origin, cookie, internal Host) | §10.3 | **หัวใจ R6**: DNS rebinding, CSRF, token leak | ทุก feature ต่อจากนี้พึ่ง — พลาดคือพังทั้งระบบ |
| F-004 | CLI client (thin, ผ่าน daemon) | §13 | อ่าน token จากไฟล์, ไม่ใส่ token ใน argv; login URL ไม่ผ่าน argv (F-003 K3); รอ `auth.pid` = PID ที่ spawn (H16); ตรวจว่า**ทุก listener** บน http port (v4/v6) เป็น nginx ของ webhub ก่อนเปิด link (N1, Q1); log ของ daemon ต้อง rotate / จำกัดขนาด**เป็น byte** หรือรวมบรรทัด 4xx ซ้ำ (F-003 security-6 U4, security-8 Y1); spawn daemon ให้ stdout/stderr ไปที่ไฟล์ (fd) หรือ `ignore` — **ห้าม pipe** ที่ CLI ถือไว้ (Windows เขียน pipe แบบ sync: reader หยุดอ่าน → daemon ค้างถาวร — security-8 Y2); route แบบ stream (`logs -f`) ต้องส่ง keep-alive byte ทุก < 15 วิ และใช้ connection แยก (daemon ไม่รับ pipelining, idle 15 วิ — U1/U2) | — |
| F-005 | Profile loader + JSON Schema + built-in (static, vite, next, express, bun-elysia, fastapi) | §6, §19.5 | profile import ไม่รันอะไรจน approve | schema เปลี่ยนบ่อยช่วงแรก |
| F-006 | Scanner + detector (score, runner, routes, via, URL env, DB, runtime, dedupe) | §9 | อ่านอย่างเดียว, path ไม่หลุด scan root, ไม่ follow symlink ออกนอก root | false positive/negative → fixtures |
| F-007 | Site registry + approve / ignore / add manual + override ไม่ถูก rescan ทับ | §11.4, §21.3 | validate ชื่อ (reserved), run approval | — |
| F-008 | `setup` wizard + `doctor` | §21.4 | — | — |

### MVP-2 — Routing
| ID | Function | DESIGN | Security focus | ความเสี่ยงหลัก |
|---|---|---|---|---|
| F-009 | nginx container + generator (resolver, proxy.conf, validate/swap, aliases) | §3, §10.2 | bind 127.0.0.1, mount `:ro`; fail closed เมื่อ daemon ไม่รัน + ยืนยันตัว daemon (F-003 L4); ใส่ `X-Webhub-Proxy` (ลบค่าจาก client, config ACL เฉพาะ user, เขียนใหม่ทุก daemon start) แล้วเปิด `browserLogin` (F-003 N1); bind `127.0.0.1` **และ** `[::1]` (ห้าม wildcard อย่างเดียว) + ตรวจทุก listener บน port ก่อนเปิด login / ทุก link (F-003 Q1); ห้าม log request header (Q5); `/` ของ hub. ห้าม redirect (N5); upstream keepalive pool ของ nginx ต่อ daemon ≪ 64 (`MAX_CONNECTIONS` เป็นโควตารวมของ CLI + browser + nginx + WS — F-003 security-7 W2, review-8 X2) | **spike**: Next ≥15 `allowedDevOrigins` |
| F-010 | Static serving + publicDir + deny-list | §10.4 | `.git`/`.env`/source ไม่หลุด | deny-list ไม่ครบ |
| F-011 | Hosts sync (UAC, block webhub) | §10.1 | แก้เฉพาะ block ของตัวเอง, backup hosts | AV/EDR บล็อกการเขียน hosts |
| F-012 | Lite mode proxy (Node) | §21.2 | logic เดียวกับ nginx, bind 127.0.0.1 | พฤติกรรมต่างจาก nginx |
| F-013 | Error pages + `/_wake` endpoint | §8, §10.2 | `/_wake` รับเฉพาะ Host ภายใน | — |

### MVP-3 — Ports + Native
| ID | Function | DESIGN | Security focus | ความเสี่ยงหลัก |
|---|---|---|---|---|
| F-014 | Port Manager (ports.json, probe 3 ชั้น, apply/rollback) | §4.1–4.3 | expose default host | Windows excluded range |
| F-015 | Runtime Manager (Node/Bun/Python portable, checksum) | §19.1 | verify checksum ทุกครั้ง, HTTPS เท่านั้น | ต้องมี internet |
| F-016 | Env resolver + env sets + URL rewrite | §11.1–11.2 | secret ไม่ลง log | precedence ผิด |
| F-017 | Native runner + install (frozen lockfile, env Zero-touch) | §7 | Run approval, spawn args array | `next dev` เขียนไฟล์ (ข้อจำกัดที่รู้แล้ว) |
| F-018 | Container runner พื้นฐาน | §7 | ไม่ privileged, mount ตามจำเป็น | — |

### MVP-4 — Compose
| ID | Function | DESIGN | Security focus | ความเสี่ยงหลัก |
|---|---|---|---|---|
| F-019 | Compose runner (group ต่อ dir, project name เดิม, adopt, override, rebuild) | §4.4 | override ไม่ publish 0.0.0.0 | **spike**: nginx network alias |
| F-020 | Hybrid runner | §7 | — | — |
| F-021 | Supervisor: start modes, on-demand, dependsOn, health, re-adopt | §8 | — | PID reuse |

### MVP-5 — Data Hub
| ID | Function | DESIGN | Security focus | ความเสี่ยงหลัก |
|---|---|---|---|---|
| F-022 | Infra manager: shared pg + redis ต่อ major | §5, §19.2 | password สุ่ม, bind 127.0.0.1, redis ACL, `default` ปิด | — |
| F-023 | Provision + env injection + disable DB services | §5.3–5.5 | role ต่อ site (least privilege) | dependents ของ DB |
| F-024 | Backup / restore | §5.6 | ไฟล์ backup สิทธิ์ user เท่านั้น | restore ไม่ครบ |
| F-025 | Import จาก volume เดิม + pre-upgrade check | §5.5, §19.2 | DB ชั่วคราวไม่ publish port | ข้อมูลเสีย → ไม่ลบ volume เดิม |
| F-026 | เครื่องมือเสริม (CloudBeaver, RedisInsight, Hoppscotch) + session ต่อ tool host | §5.7, §10.3, §22.6 | ไม่ส่ง master token เข้า tool; ออกแบบ `/_auth` เอง — cookie อย่างเดียวรั่วข้าม port ได้ (F-003 L1/L4) | tool image มีช่องโหว่ → pin digest |

### MVP-6 — Dashboard + Ops
| ID | Function | DESIGN | Security focus | ความเสี่ยงหลัก |
|---|---|---|---|---|
| F-027 | Dashboard (Sites, Port Map, Data Hub, Runtimes) | §14 | CSP, ไม่มี inline script, Origin check; key จาก `#k=` → sessionStorage + `replaceState` ทันที, ส่ง `X-Webhub-Session` ทุก call (F-003 L1); WS: ใช้ `delay` ของ `checkUpgrade`, ปฏิเสธ absolute-form target, echo เฉพาะ `protocol` ที่คืนมา (F-003 Q6); WS: handler ของ `upgrade` ต้องผ่าน busy check ของ `refusePipelining` + `checkUpgrade`, มี idle/ping timeout, จำกัด WS ต่อ host < `MAX_CONNECTIONS` — WS ตัวเดียวต่อ tab (multiplex) เพราะ 64 connection เป็นโควตารวม (F-003 security-8 Y5, review-8 X2); SPA fallback ต้องเป็น wildcard route ชัดเจน (scope + access) — not-found handler ไม่ถูกเรียก เพราะ 404 ตอบใน `onRequest` (review-8 X5) | — |
| F-028 | Autostart + tray | §20 | Task Scheduler ระดับ user (ไม่ admin) | — |
| F-029 | Metrics + notify | §20 | — | — |

### Phase 7–13 (แตกเป็น F-xxx เมื่อถึงคิว)
DB Studio v1/v2 + API Studio v1/v2 (§5.7, §22) · backup ตามเวลา, mysql/mariadb/mongo, Mailpit/MinIO · profiles ภาษาเพิ่ม · watch/cleanup/export/alias · HTTPS (mkcert) · macOS/Linux

## 2.5 คู่มือ (WORKFLOW §2.5)
| รอบ | หลังจบ | เนื้อหาหลัก |
|---|---|---|
| M-1 | MVP-1 | ติดตั้ง, `setup`, `doctor`, scan/approve/add, config |
| M-2 | MVP-2 + MVP-3 | เปิดเว็บผ่าน `<name>.localhost`, hosts sync, Port Map, env/URL rewrite, runtimes, Lite mode |
| M-3 | MVP-4 + MVP-5 | compose/hybrid, start modes, Data Hub, backup/import, เครื่องมือเสริม |
| M-4 | MVP-6 | Dashboard ครบทุกหน้า, autostart/tray, troubleshooting รวม |

## 3. Spike ที่ค้าง (ทำใน scratchpad ก่อนออกแบบ feature นั้น)
| Spike | ก่อน feature | ไม่ผ่าน → |
|---|---|---|
| Next ≥ 15 `allowedDevOrigins` กับ hostRewrite | F-009 | ส่ง Origin rewrite ด้วย / แนะนำ container runner |
| nginx network alias `<site>.localhost` ใน network `webhub` | F-019 | `extra_hosts` ต่อ site |

## 4. ผลดี / ผลเสียของแผนนี้ (R3)
| | รายละเอียด |
|---|---|
| ผลดี | auth/security มาก่อน feature ที่เปิด port (R6); แต่ละ F เล็กพอผ่าน workflow ครบในรอบเดียว; MVP-1 จบแล้วได้ของใช้จริง (scan + list) โดยยังไม่รันอะไรบนเครื่อง = เสี่ยงต่ำ |
| ผลเสีย | เห็นผล "เปิดเว็บผ่าน `<name>.localhost`" ช้า (MVP-2–3); feature ย่อยเยอะ = รอบถามความเห็นเยอะ |
| ทางเลือกที่ไม่เลือก | ทำ vertical slice (site เดียว end-to-end ก่อน) — เห็นผลเร็วกว่า แต่ต้องย้อนแก้ auth/config ภายหลัง = ขัด R1 (แก้ feature ที่ done) |

## 5. ขั้นถัดไป
F-003 W3 (planned) → สืบ F-001 lock race + เสนอ CR (ดู §0 ติดตามต่อ) → แล้ว W1 ของ F-004 CLI client (รวมคำสั่ง `webhub daemon start|stop|status` ตาม F-003 Q4)
