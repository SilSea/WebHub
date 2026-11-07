# Fixtures

Small sample projects used by tests (DESIGN §21.5). Tests only ever work on **copies** in a temp dir
(`test/helpers/fixture.ts`) and assert that the copy is untouched (Zero-touch).

| Fixture | Represents |
|---|---|
| `vite-basic` | Vite app with a fixed `server.port` (detector: `via: arg`) |

Do not add `node_modules/`, lockfiles of real size, or secrets here.
