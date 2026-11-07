# Test report — F-000 — round 3

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — fixes for review-2 / security-2) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| unit (cli 6, fixture harness 19) | 25 | 0 | 0 |
| integration (pack contents 1, built CLI 3) | 4 | 0 | 0 |
| — total | 29 | 0 | 0 |
| regression (done features) | n/a — none yet | | |

Correction to test-2: its counts were unit 24 (harness 18), total 28.

Round-3 changes covered:
- N1: fixture dir that is a junction is rejected (test creates a real junction — ran, not skipped); copy from a custom root still works
- N2: missing fixture leaves the number of `webhub-fx-*` temp dirs unchanged
- dir entries now record mode bits (`dir:<mode>`)

Other checks: lint, typecheck, build, `pnpm run audit` (high) — pass. `webhub-fx-*` dirs left in TEMP after run: 0.
