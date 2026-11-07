# Feature registry

สถานะ `done` = **locked** — แก้ได้ผ่าน Change Request ที่ได้รับอนุญาตเท่านั้น (WORKFLOW R1)

| ID | Function | Phase | Status | Spec | CR ที่เกี่ยว | Report ล่าสุด |
|---|---|---|---|---|---|---|
| F-000 | Repo scaffolding | MVP-0 | `done` | [spec](F-000-scaffolding.md) | — | — |
| F-001 | Config + `$WEBHUB_HOME` + migration | MVP-1 | `done` | [spec](F-001-config.md) | — | — |
| F-002 | Platform layer (Windows) | MVP-1 | `done` | [spec](F-002-platform.md) | CR-001 | [test-5](../reports/F-002/test-5.md) |
| F-003 | Daemon + API + auth | MVP-1 | `todo` | — | — | — |
| F-004 | CLI client | MVP-1 | `todo` | — | — | — |
| F-005 | Profile loader + built-in profiles | MVP-1 | `todo` | — | — | — |
| F-006 | Scanner + detector | MVP-1 | `todo` | — | — | — |
| F-007 | Site registry + approve/add | MVP-1 | `todo` | — | — | — |
| F-008 | setup + doctor | MVP-1 | `todo` | — | — | — |
| F-009 … F-029 | ดู [PLAN.md](../PLAN.md) | MVP-2–6 | `todo` | — | — | — |

Status: `todo` → `draft` → `planned` → `in-progress` → `testing` → `review` → `done`

Change Requests: `docs/changes/CR-xxx-<name>.md` (template: [`templates/change-request.md`](../templates/change-request.md))

| CR | แก้ | Status |
|---|---|---|
| [CR-001](../changes/CR-001-pack-mjs.md) | F-000 pack test ยอม `.mts` → `.mjs` | `done` |
