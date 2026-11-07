# Test report — F-000 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit, branch `feat/F-000-scaffolding`) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1; Docker not used |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| unit (cli 6, fixture harness 15) | 21 | 0 | 0 |
| integration (npm pack contents) | 1 | 0 | 0 |
| security (included above: fixture-name traversal ×7, remove guard, isInside, pack allowlist) | ✓ | 0 | 0 |
| regression (done features) | n/a — no `done` features yet | | |
| Zero-touch (fixture hash before/after) | harness self-tests pass | | |

Other checks:
- `pnpm lint` (Biome, preset `recommended` — verified a rule fires): pass
- `pnpm typecheck`, `pnpm build` (TypeScript 7.0.2): pass
- `pnpm audit --audit-level high`: no known vulnerabilities
- Smoke: `node dist/cli.js --version` → `0.0.0`; unknown command → exit 1
- `minimumReleaseAge` (24h) blocked `@biomejs/biome@2.6.6` (published < 24h) → pinned 2.6.5. Supply-chain guard confirmed working.

## Failures
None.

## Not run
- CI matrix (Windows/Linux × Node 22/24): runs on GitHub after push; Node 22 not installed locally.
