# Test report — CR-001 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit, branch `fix/CR-001-pack-mjs` from develop `db53c31`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 |

| # | Case | Result |
|---|---|---|
| 1 | develop base (no `.mts` in src): `test/integration/pack.test.ts` 4/4 pass — behavior unchanged | pass |
| 2 | stray `dist/evil.mjs` without `src/evil.mts` → test fails with `expected [ 'dist/evil.mjs' ] to deeply equal []` (still caught) — file removed afterwards | pass |
| 3 | F-002 branch with `src/platform/elevated.mts`: `dist/platform/elevated.mjs(.map)` accepted | see F-002 test-3 |
