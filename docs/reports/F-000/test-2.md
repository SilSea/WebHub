# Test report — F-000 — round 2

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-1 / security-1) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| unit (cli 6, fixture harness 19) | 25 | 0 | 0 |
| integration (pack contents 1, built CLI 3) | 4 | 0 | 0 |
| — total | 28 | 0 | 0 |
| regression (done features) | n/a — none yet | | |

New / changed tests for round-1 findings:
- review #2 / security #2: pack test requires `dist/cli.js` and allows only `dist/<name>.js(.map)` for existing `src/<name>.ts` — verified it **fails** when `dist/` is absent ("dist/cli.js missing — run `pnpm build` first")
- review #3: symlink tests use `ctx.skip()` instead of a silent pass
- review #4: nonexistent fixture rejected before creating a temp dir; `cp` failure removes the temp dir — 0 `webhub-fx-*` dirs left after the run
- review #5: permission change (read-only) detected
- review #6: built `dist/cli.js --version`, `dist/cli --version` (no extension), shebang
- review #9: "untouched copy" re-hashes the copy
- security #4: fixtures containing symlinks/junctions rejected

Other checks: lint (Biome recommended), typecheck, build (cleans `dist/` first), `pnpm run audit` (high) — all pass.

## Failures
None.
