# Code review — F-005 — round 1

| | |
|---|---|
| Date | 2026-11-14 |
| Scope | `git diff develop..feat/F-005-profiles` at `c929e32` |
| Reviewer | separate agent; scratch copy, unit 39/39 (Node 24 + 22.12), integration 4/4, wildcard fuzz 20k vs regex reference (0 mismatches); no repo edits |
| Verdict | **FAIL** — 0 critical, 2 major (K1, K2), 8 minor (K3–K10), 2 nit (K11, K12) |

Checked and found correct: YAML hardening (aliases, `__proto__`, tags, duplicate keys, deep nesting, `!!binary`), range math vs npm, `deepMerge`, all / any / none, in-flight sharing, CLI exit codes; F-003 / F-004 change only by the added route + `explainImpostor` export.

## Findings
| ID | Severity | Where | Problem / scenario | Evidence | Fix |
|---|---|---|---|---|---|
| K1 | major | `loader.ts` hard-link check | Applied to built-in files too: pnpm / bun install packages as hard links (store) → after `pnpm add -g webhub` every built-in is refused, no profiles | **ran** (hard-linked builtin dir → 0 profiles, 7 problems) | Hard-link check for user files only + test |
| K2 | major | `profiles/fastapi.yml` | Detects pyproject-only projects (uv / poetry) but installs with `pip install -r requirements.txt` → install fails; not fixable inside the profile format | reasoned | Detect `requirements.txt` only now; pyproject profile later |
| K3 | minor | `loader.ts` `problemOf` | `data/profiles` junction / outside home → message with the full absolute path in API + CLI (against §3.2) | **ran** | Fixed messages for SYMLINK_REFUSED / PATH_OUTSIDE_HOME + assert |
| K4 | minor | `fastapi.yml` | Needle `uvicorn` matches Django / Starlette / Litestar projects | reasoned | `none: manage.py`, needle `fastapi` only |
| K5 | minor | `vite.yml` | Host check backported to Vite 5.4.12 / 4.5.6; variant uses the declared lower bound (`^5.4.0` → 5.4.0) → no hostRewrite | reasoned | `hostRewrite: true` for all Vite (or `>=4.5`); document lower-bound rule |
| K6 | minor | `static.yml` | No `none: package.json`: CRA / webpack (`public/index.html`), repos with `docs/index.html` become static sites (score 50) | reasoned | `none: package.json` and/or lower score for `public/` / `docs/` |
| K7 | minor | `command.ts` `UNSAFE` | C1, U+2028/2029, bidi overrides allowed in commands → run-approval display spoofing later (F-007) | **ran** (U+202E loads) | Reuse `CONTROL` class |
| K8 | minor | `match.ts` `resolveAlt` | First 32 wildcard matches in `list()` order → `fileContains` on `*.py` misses the file depending on directory order | **ran** (41 files → false) | Sort before slicing; document limit |
| K9 | minor | `schema.ts` variants | Variants validated one by one, not combined; a variant cannot remove a key (`port.env` stays when switching to `arg`) | reasoned | Validate cumulative merge; optional `null` = delete |
| K10 | minor | spec §3.2 / §3.3 | Spec: load at daemon start (code: per request); body has `file` (not in spec); duplicate user ids cannot happen | reasoned | Align spec |
| K11 | nit | `express.yml`, `bun-elysia.yml` | `host.bind` declared but HOST not passed: `listen(PORT)` binds all interfaces | reasoned | Constraint for F-007 / F-017 in spec |
| K12 | nit | various | `next <13` variant redundant; express `entry` default vs fixture `main`; `file:` also matches a folder; score ties vite / bun-elysia 80; `*` / `x` ranges refused (undocumented) | (c) ran | Document / adjust |

## Status after this round
- K1 fixed: hard-link check only for `data/profiles`; test with a hard-linked built-in dir.
- K2 fixed: `fastapi` detects `requirements.txt` only (pyproject → later profile, follow-up); test.
- K4 fixed with K2 (`none: manage.py`, needle `fastapi`); test.
- K3, K5–K12: asked the user (minor / nit).

## Addendum (2026-11-14)
The minor / nit / info findings "asked the user" above were fixed in `ba99faa` (user chose "fix all"); remaining gaps found in [review-2](review-2.md) (L1–L6).
