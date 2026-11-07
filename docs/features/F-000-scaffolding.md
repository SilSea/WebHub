# F-000 — Repo scaffolding

| | |
|---|---|
| Status | `review` |
| Phase | MVP-0 (PLAN.md) |
| DESIGN.md | §0 (Stack), §12 (Folder structure), §21.4 (npm package), §21.5 (fixtures) |
| Depends on | — |
| Owner อนุมัติ | ผู้ใช้ / 2026-11-07 |

## 1. เป้าหมาย / ขอบเขต
**ทำ**
- โครง package ตาม DESIGN §12: `src/`, `templates/`, `profiles/`, `fixtures/`, `test/`
- TypeScript (ESM, `strict`) + build → `dist/`
- test framework + โครง test (unit / integration แยก suite)
- lint + format
- **fixture harness**: copy fixture project ไป temp dir, hash ทุกไฟล์ก่อน/หลัง → assert เท่ากัน (Zero-touch, R0)
- CI (GitHub Actions): lint, typecheck, test, `audit`
- `package.json`: `name: webhub`, `bin: { webhub }` (stub), `engines.node`, `files` allowlist (publish เฉพาะ `dist/`, `templates/`, `profiles/`)
- `.gitignore`, `.editorconfig`, `.gitattributes` (LF ใน repo — แก้ warning CRLF ที่เห็นตอนนี้)

**ไม่ทำ**
- logic ของ webhub ใดๆ (F-001 เป็นต้นไป)
- dashboard (Vite/React — F-027)
- publish ขึ้น npm

## 2. ระบบเดิมรองรับยังไง
- DESIGN §0 กำหนด Node + TypeScript, §12 กำหนดโครงโฟลเดอร์, §21.4 กำหนด npm package + Node ≥ 22, §21.5 กำหนด fixtures
- ต้องปรับ DESIGN: §12 เพิ่ม `test/`, `.github/`, config ของ tool (Node ≥ 22 ตาม §21.4 เดิม)

## 3. Design

**Layout**
```
webhub/
├── package.json  pnpm-lock.yaml  tsconfig.json  tsconfig.build.json  vitest.config.ts  biome.json
├── .github/workflows/ci.yml
├── src/
│   ├── cli.ts                 # stub: `webhub --version`
│   └── index.ts
├── test/
│   ├── unit/
│   ├── integration/
│   └── helpers/fixture.ts     # copyFixture(), hashTree(), assertUntouched()
├── fixtures/
│   └── vite-basic/            # fixture แรก (ไฟล์เล็ก ไม่มี node_modules)
├── templates/  profiles/      # ว่าง (มี .gitkeep)
└── dist/                      # build output (gitignored)
```

**Scripts**
| script | ทำ |
|---|---|
| `build` | `tsc -p tsconfig.build.json` |
| `typecheck` | `tsc --noEmit` |
| `test` | unit (fast suite) |
| `test:full` | unit + integration (+ Docker เมื่อมี) |
| `lint` / `format` | `biome check` / `biome format --write` |
| `audit` | `pnpm audit --audit-level high` |

**Fixture harness**
```ts
copyFixture(name): Promise<string>                 // → temp dir
hashTree(dir): Promise<Map<string, string>>         // path → sha256 (รวม mtime ไม่นับ)
assertUntouched(before, after): void                // ไฟล์เพิ่ม/ลบ/เปลี่ยน → fail พร้อมรายชื่อ
```
ไฟล์ที่ project สร้างเองตามปกติ (`node_modules/`, `.next/`, `dist/`) ประกาศใน allowlist ต่อ fixture (DESIGN §7)

**CI**: trigger push/PR ที่ `develop`, `main`; matrix `windows-latest` (เป้าหมายหลัก) + `ubuntu-latest` (กันโค้ดผูก Windows โดยไม่ตั้งใจ) × Node 22, 24. งานแต่ละตัวเปิด PR `feat/F-xxx` → `develop`, merge เมื่อ CI ผ่าน + DoD ครบ

**ตัดสินใจทางเทคนิคแล้ว (ไม่ถาม)**
| เรื่อง | เลือก | เหตุผล |
|---|---|---|
| Module | ESM | Node สมัยใหม่, lib ส่วนใหญ่ (undici, execa) ESM |
| Test | Vitest | เร็ว, TS ในตัว, ใช้กับ dashboard (Vite) ทีหลังได้ชุดเดียว |
| Build | `tsc` ตรง (ไม่ bundle) | ง่าย, stack trace ตรง source, ลด dependency |
| Layout | package เดียว (ไม่ monorepo) | ตรง DESIGN §12, publish npm ง่าย; dashboard แยกโฟลเดอร์ build ด้วย Vite |

## 4. ผลดี / ผลเสีย
| | รายละเอียด |
|---|---|
| ผลดี | ทุก feature ต่อจากนี้มีที่วางโค้ด/เทส/CI พร้อม; Zero-touch ตรวจอัตโนมัติตั้งแต่วันแรก; CI บน Windows จับปัญหา path/shell เร็ว |
| ผลเสีย | dependency ชุดแรก (TypeScript, Vitest, lint) = supply-chain surface; CI Windows ช้ากว่า Linux |
| ทางเลือกที่ไม่เลือก | monorepo (pnpm workspace) — ยืดหยุ่นกว่าแต่ซับซ้อนเกินความจำเป็นตอนนี้; Jest — ช้ากว่า, ESM ยุ่ง; tsup/esbuild bundle — เพิ่ม dependency + debug ยาก |

## 5. Impact ต่อของเดิม
| เรื่อง | กระทบไหม | รายละเอียด |
|---|---|---|
| feature ที่ done แล้ว | ไม่ | ยังไม่มี |
| Zero-touch | ไม่ (เพิ่มตัวตรวจ) | harness ทำงานบนสำเนาใน temp dir เท่านั้น |
| Security | มี | dependency ใหม่, CI — ดู §6 |
| Performance | ไม่ | — |
| Config / data เดิม | ไม่ | — |
| เอกสาร | มี | DESIGN §12 (เพิ่ม `test/`), `.gitattributes` เปลี่ยน line ending ไฟล์ docs เป็น LF |

## 6. Threat model
| Asset | ผู้โจมตี / ช่องทาง | ป้องกันด้วย | เทส |
|---|---|---|---|
| เครื่อง dev / CI | dependency ที่ถูก compromise รัน install script | lockfile + install แบบ frozen; ปิด lifecycle script ของ dependency (อนุญาตเฉพาะที่จำเป็นแบบ allowlist); dependency น้อยที่สุด | CI ใช้ frozen install, audit fail ที่ high |
| CI | GitHub Action ของบุคคลที่สามถูกแก้ | pin action ด้วย commit SHA; `permissions: contents: read`; ไม่มี secret ใน workflow | review ไฟล์ workflow |
| Package ที่ publish | ไฟล์ไม่ตั้งใจหลุด (เช่น `.env`, data) | `files` allowlist ใน package.json; `npm pack --dry-run` ใน CI ตรวจรายชื่อไฟล์ | test เทียบรายชื่อไฟล์ใน pack |
| Fixture harness | เขียนทับ fixture ต้นฉบับ | ทำงานบนสำเนาใน temp dir; path ต้องอยู่ใต้ temp root | unit test ของ harness |

Checklist ที่เกี่ยว: Dependencies, Zero-touch, Secrets

## 7. คำถามถึงผู้ใช้
| # | คำถาม | ทางเลือก | แนะนำ | คำตอบ |
|---|---|---|---|---|
| Q1 | Node ขั้นต่ำของตัว webhub | 22 (ตาม DESIGN) / 24 | 24 | **Node 22** (`engines: >=22`; CI ทดสอบทั้ง 22 และ 24) |
| Q2 | Package manager ของ repo webhub | pnpm / npm | **pnpm** — ไม่รัน install script ของ dependency เป็นค่าเริ่มต้น (ปลอดภัยกว่า), เร็ว; ผู้ใช้ยังติดตั้งด้วย `npm i -g webhub` ได้ปกติ | **pnpm** (`packageManager` ใน package.json, `pnpm install --frozen-lockfile`) |
| Q3 | Lint + format | Biome / ESLint + Prettier | **Biome** — tool เดียว, dependency น้อยมาก (R6), เร็ว; ESLint มี rule เยอะกว่า | **Biome** |
| Q4 | CI + การ merge | GitHub Actions + PR เข้า `develop` / GitHub Actions + merge local / ไม่มี CI ตอนนี้ | **Actions + PR** — มี record ของ review ต่องาน | **Actions + PR** เข้า `develop` |

## 8. Test plan
| # | กรณี | ประเภท |
|---|---|---|
| 1 | `build` / `typecheck` / `lint` ผ่านบนโครงเปล่า | unit (CI) |
| 2 | `webhub --version` พิมพ์ version จาก package.json | unit |
| 3 | harness: fixture ไม่ถูกแตะ → ผ่าน | unit |
| 4 | harness: แก้/เพิ่ม/ลบไฟล์ในสำเนา → fail พร้อมรายชื่อไฟล์ | unit |
| 5 | harness: allowlist (`node_modules/`) ไม่นับ | unit |
| 6 | harness: path หลุด temp root → throw | security |
| 7 | `npm pack --dry-run` มีเฉพาะไฟล์ใน allowlist | security |
| 8 | install แบบ frozen + audit ใน CI | security |

## 9. Reports
| รอบ | test | review | security | ผล |
|---|---|---|---|---|
| 1 | [test-1](../reports/F-000/test-1.md) | [review-1](../reports/F-000/review-1.md) | [security-1](../reports/F-000/security-1.md) | critical 0 / major 0; minor 7+2 sec, nit 2+2 sec |

## 10. เอกสารที่อัปเดต (R4)
- [x] DESIGN.md §12  - [x] PLAN.md queue  - [x] features/README.md  - [ ] reports/README.md

## 11. Log
| วันที่ | ขั้น | หมายเหตุ |
|---|---|---|
| 2026-11-07 | W1 ① | ร่าง spec |
| 2026-11-07 | W3 E1–E4 | implement (`bb0fba1`), test-1 ผ่าน 22/22, review-1 + security-1 ไม่มี critical/major |
| 2026-11-07 | W1 ③④⑤ | อนุมัติ spec, เข้า queue, ผู้ใช้สั่งทำต่อ (W3 เฉพาะ F-000) |
| 2026-11-07 | W1 ② | Q1 Node 22, Q2 pnpm, Q3 Biome, Q4 Actions + PR |
