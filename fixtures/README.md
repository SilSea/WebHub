# Fixtures

Small sample projects used by tests (DESIGN §21.5). Tests only ever work on **copies** in a temp dir
(`test/helpers/fixture.ts`) and assert that the copy is untouched (Zero-touch).

| Fixture | Represents |
|---|---|
| `vite-basic` | Vite app with a fixed `server.port` (detector: `via: arg`) — profile `vite` (Vite 7 → `hostRewrite`) |
| `static-basic` | Plain static site — profile `static` |
| `static-spa-basic` | Built SPA (`id="root"`, no package.json) — profile `static-spa` |
| `next-basic` | Next 15 with a hard-coded `--port` in its script — profile `next` (≥15 → `hostRewrite`) |
| `express-basic` | Express + socket.io, port from `PORT` — profile `express` |
| `bun-elysia-basic` | Elysia with `.group("/api")` — profile `bun-elysia` |
| `fastapi-basic` | FastAPI + uvicorn in requirements.txt — profile `fastapi` |
| `monorepo-split` | `frontend/` (vite, port 5174) + `backend/` (express) — scanner: one site, two services |
| `monorepo-compose` | `monorepo-split` + a root `docker-compose.yml` that builds both folders + postgres — runner `compose` |
| `compose-build` | Elysia + compose service built from source + postgres — scanner: runner `compose`, port 3000 fixed |
| `compose-hybrid` | Vite + compose that mounts the source (anchors / merge keys) + postgres / redis — runner `hybrid` |
| `nested-duplicate` | `main/` and a copy at `hobby/project/main` — scanner: `duplicate` of `main` |
| `not-web-cases` | browser extension, Unity, Electron, plain Python script — scanner: `not-web` |

Expected profile per fixture: `test/unit/profiles-fixtures.test.ts`; expected scan result: `test/unit/scanner-fixtures.test.ts`.

Do not add `node_modules/`, lockfiles of real size, or secrets here.
