# Security review — F-005 — round 1

| | |
|---|---|
| Date | 2026-11-14 |
| Scope | `git diff develop..feat/F-005-profiles` at `c929e32` |
| Reviewer | separate agent; probes in a scratch copy (`f005-sec1/test/unit/zz-probe*.test.ts`); no repo edits |
| Verdict | **FAIL** — 0 critical, 1 major (S1), 5 minor (S2–S6), 1 nit (S7), 1 info (S8) |

## Findings
| ID | Severity | Where | Attack scenario | Evidence | Fix |
|---|---|---|---|---|---|
| S1 | major | `schema.ts` `uniqueKeys: true` + `routes.ts` | Profile copied into `data/profiles` with 256 KB of short keys: the `yaml` duplicate-key check is quadratic and synchronous → daemon blocked ~16 s per file per `GET /api/v1/profiles` (200 files ≈ 50 min) | **ran**: 5k keys 222 vs 41 ms, 40k 12620 vs 271 ms; `parseProfile` 256 KB 16155 ms | `uniqueKeys: false` + own duplicate check (Set per map) + node cap + time-bound test |
| S2 | minor | `loader.ts` `problemOf` (= review-1 K3) | `data/profiles` junction / outside home → full absolute path in API `message` | **ran** | Fixed relative message |
| S3 | minor | `command.ts` `UNSAFE` (≈ K7) | Commands accept C1, bidi (U+202E), zero-width, NBSP, fullwidth `＂ ＆`, an embedded `"` → approval display spoofing (F-007); WorstFit best-fit maps `＂` → `"` for ANSI-argv programs. No cmd.exe metacharacter gets through | **ran** | Printable ASCII only; no `"` / `'` inside an argument; show rendered argv at approval |
| S4 | minor | `Host`, `express.yml`, `bun-elysia.yml` (≈ K11) | `host.bind` is a label: `--host 0.0.0.0` or a var `0.0.0.0` validates; express / bun-elysia pass no host → `listen(PORT)` on all interfaces | **ran** | Refuse `0.0.0.0` / `::` / non-loopback literals in cmd / vars; HOST env path; correct threat model |
| S5 | minor | `port.env` | Any variable name: `PATHEXT`, `PATH`, `NODE_OPTIONS`, `ComSpec` set to the port number → child breakage (DoS, not injection) | **ran** | Denylist / allowlist of env names |
| S6 | minor | `match.ts` | No read budget: 48 rules × 8 alternatives × 32 hits × 256 KB per profile (≈ 3 GB) × 200 profiles for F-006 | reasoned | Per-profile read / byte budget or cached reads |
| S7 | nit | `profiles-command.ts` `--json` | `JSON.stringify` leaves C1 / bidi from YAML keys or file names; F-004 `errorJson` is sanitised | reasoned | Sanitise / escape in JSON output |
| S8 | info | F-007 / F-017 | `start.cmd` may run any program (`powershell -EncodedCommand`, UNC, `cmd /c`): approval is the boundary, must show the resolved executable, not keyed on id alone (user overrides a built-in id); bare names may resolve in the project cwd on Windows (`NoDefaultCurrentDirectoryInExePath`); never `shell: true` on POSIX; values with `=` / `,` / leading `/` | ran (validation) | Design notes for F-007 / F-017 |

## Focus areas (summary)
1. Command injection: no cmd.exe / sh metacharacter passes; weaker: `,` `=` embedded `"`, non-ASCII (S3); real boundary = F-007 approval (S8).
2. YAML: aliases, `<<`, custom / `!!js` tags, multi-doc, duplicates, `__proto__` refused; prototype clean; deep nesting RESOURCE_EXHAUSTION ~290 ms; huge numbers → Infinity refused by zod; errors code + line only. Quadratic duplicate check → S1.
3. Filesystem: junction refused (path leak S2), hard link refused, lstat → fstat ino check works, ADS harmless, `..` / absolute / `\` / `:` / UNC refused, CON/NUL inside a folder do not resolve (Win11), 256 KB / 200 files.
4. ReDoS / CPU: wildcard linear in practice (0.4 ms for 5000 chars), ranges length-capped, zod regexes safe; cost in YAML (S1) and reads (S6).
5. API: behind F-003 auth (401 tested), concurrent calls shared, no sequential throttle (matters only with S1); leak S2; CORS unchanged.
6. CLI: table / problems sanitised; `--json` not for C1 / bidi (S7).
7. `host.bind`: S4; `port.env`: S5.
8. `yaml@2.9.1`: 0 dependencies, no lifecycle scripts, integrity-pinned, audit clean; CVE-2023-2251 affects < 2.2.2.

## Status after this round
- S1 fixed: `uniqueKeys: false`; duplicates found in the existing `visit` with a Set per map (also `1` vs `"1"`); ≤ 5000 YAML nodes per profile; test: 256 KB block and flow maps refused in < 2 s (≈ 10 ms), duplicates still found.
- S2–S8: asked the user (minor / nit / info).
