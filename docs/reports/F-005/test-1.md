# Test report — F-005 — round 1

| | |
|---|---|
| Date | 2026-11-14 |
| Branch | `feat/F-005-profiles` (implementation, before review) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-005 suites + `cli`). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 436 | 0 | 6 |
| `profiles`, `profiles-fixtures` (unit), `profiles` (integration), `cli` (unit), Node 22.12 | 66 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## Coverage of the test plan (spec §8)
| # | Test |
|---|---|
| 1 | built-in profiles all load, ids unique and equal to file names |
| 2 | unknown key / wrong type / out of range → `line N: path: message` |
| 3 | broken user file reported, others load, no full paths in the result |
| 4 | user profile replaces a built-in one whole (`overrides`), no merge; duplicate ids impossible (id = file name) |
| 5 | alias bomb refused fast, `__proto__` / `constructor` keys, custom tags (`!x`, `!!js/function`), duplicate keys, several documents, non-mapping, 50 000-deep nesting (< 5 s, no crash), YAML errors do not echo file content |
| 6 | file > 256 KB, hard link, symlink (when the account may create one), `data/profiles` as a junction → problem |
| 7 | patterns `..`, `/abs`, `C:`, `\`, empty segment, `*` outside the last segment, space → error |
| 8 | detect all / any / none + score, folder `x/`, `fileContains` 256 KB limit, dep with range, a file named like a folder |
| 9 | `*a*a*a*b` × 1000 against 255 chars < 2 s |
| 10 | variants in file order, deep merge, arrays replace, input unchanged, `latest` / missing dep → no variant |
| 11 | ranges `>=6`, `<13`, `>=13 <15`, `>6`, `<=6`, `6`, `6.x`, `=6`, `^` (incl. 0.x / 0.0.x), `~`; bad ranges; `lowestVersion` of specs |
| 12 | `splitCommand` quotes / shell characters / unclosed quote / stray brace / option first; `renderCommand` values inside one argument, unsafe values (space, `-x`, `&`, quote, empty, `%`, `\`), missing value, `{toString}` |
| 13 | `host.bind: 0.0.0.0` → error; `::1` accepted |
| 14 | 7 fixtures (copies; Zero-touch hash check) → expected profile wins, score ≥ 50, no tie; Vite 7 / Next 15 `hostRewrite`, Next 12 old flags, Vite 5 no rewrite |
| 15 | API: 401 without auth, 200 with bearer, relative files only, no CORS header; CLI: `--no-start` → 3, auto-start, table, `--check` 0 / 2, `--json`, user override shown, an escape sequence in a key name printed as `?`, bad option → 2 |
| 16 | Node 22.12 |

## Found while testing
- Node 22 on Windows: `lstat().dev` is 0, `fstat().dev` is not → comparing `dev` refused every file. Fixed: compare `ino` (bigint) only.
- `!!js/function` is only a warning in the `yaml` package (parsed as a string) → warnings are now errors.
- The editor turned ` ` escapes into raw characters once (regex broken); fixed in the source (no impact on behaviour).
- Flaky once, not reproduced (3/3 alone, full suite pass on rerun): F-004 `cli-stop` "start waits for our stopping daemon to leave" timed out at 5 s in one full-suite run (machine load: `ensureHome` ~2.5 s + spawn). F-004 is `done` — not changed; noted as a follow-up.

## Not run
- Linux / macOS; a symlinked profile file when the account lacks the symlink privilege (the junction case covers `data/profiles`).
