# Workflow — Planning / Plan execution / Manual

Applies to all work on webhub (humans and AI). Main design: [`DESIGN.md`](../DESIGN.md). Plan: [`PLAN.md`](PLAN.md).

| Workflow | Used for | Ends at |
|---|---|---|
| **W1** Create a function | New function | Added to plan → ask "proceed now?" |
| **W2** Change a function | Change / bugfix / refactor of an existing feature | Added to plan → ask "proceed now?" |
| **W3** Execute the plan | Implementing planned work | Continues item by item until the plan is complete or the user says stop |
| **W4** User manual | End of each MVP / any user-visible change | HTML manual that passes the coverage check |

---

## Rules (mandatory)

| # | Rule | In practice |
|---|---|---|
| R0 | **Zero-touch** (DESIGN §0) | Never modify files inside a user's project. Every gate checks this. |
| R1 | **No feature changes without permission** | A feature with status `done` in [`features/README.md`](features/README.md) is locked. Changing its behavior / API / config / schema requires a Change Request (CR) the user has approved (W2). A bugfix that does not change the spec still needs a short CR. |
| R2 | **No code before design** | Code may be written only for items with status `planned` (spec/CR approved and in the plan). The spec must state how the existing system (DESIGN.md) supports it, or which part of the design changes. |
| R3 | **Always analyze pros / cons** | Every spec / CR has "Pros / Cons / Alternatives not chosen" plus impact on existing features, Zero-touch, security, performance. |
| R4 | **Always update documentation** | Every change (design, code, config, bugfix) updates DESIGN.md / spec / CR / PLAN.md / features/README.md in the same or an earlier commit. Docs that do not match the code = work not finished. |
| R5 | **Separate report files** | Test, code review, security review, regression and manual-coverage results are separate files under `docs/reports/` (not embedded in the spec); the spec only links to them. |
| R6 | **Maximum security** | Secure by default (bind 127.0.0.1, deny before allow, least privilege, no secrets in logs/repo/exports); every spec has a threat model; every item gets a separate security review; any exploitable security finding = **critical** (blocks merge). |

Item status: `todo` → `draft` (being designed) → **`planned`** (spec/CR approved + in the plan queue) → `in-progress` → `testing` → `review` → `done` (locked)

---

## W1. Create a new function (planning)

```
 ①Design → ②Ask for feedback → ③Write/update docs → ④Add to plan → ⑤Ask "proceed now?"
                                                                    ├─ yes → W3 for this item only (then stop)
                                                                    └─ no  → end (item waits in plan as `planned`)
```

| Step | What | Output | Gate |
|---|---|---|---|
| ① Design | Read the relevant DESIGN.md sections; write a Feature Spec from [`templates/feature-spec.md`](templates/feature-spec.md): scope, interface, data/config, flow, errors, pros/cons, alternatives, impact on existing features, **threat model**, test plan | `docs/features/F-xxx-<name>.md`, status `draft` | All sections filled; no "TBD" in interface / threat model |
| ② Ask for feedback | Turn open decisions into questions (in Thai) with options and a recommendation — one batch | User answers | Every question answered |
| ③ Docs | Put answers into the spec; update DESIGN.md if the design changed (+ a row in §17 Review log) | Final spec | User approves the spec |
| ④ Add to plan | Add the item to the **Plan queue** in [`PLAN.md`](PLAN.md) (order, dependencies, phase); update [`features/README.md`](features/README.md) | Status `planned` | Order respects dependencies |
| ⑤ Ask to proceed | "Proceed with F-xxx now?" | User answer | — |

- **Yes** → run W3 for this item only (E1–E5), then stop (does not continue with other plan items — start W3 for that).
- **No** → end. The item stays `planned` until W3 runs.

---

## W2. Change an existing function (planning)

Same steps as W1 (ends with adding to plan + asking to proceed), but starts with a **Change Request** and adds:

| Step | In addition to W1 |
|---|---|
| ① Design | Write a CR from [`templates/change-request.md`](templates/change-request.md): current → new → why; **impact matrix** (which features / config / data are affected); migration + rollback plan; **files allowed to change** |
| ② Ask for feedback | Explicitly ask **permission to change the feature** (R1). Not granted = CR `rejected`, end. |
| ④ Add to plan | CR enters the plan queue as `planned` |

CR types: `change` (changes the spec), `bugfix` (no spec change — short CR: current / cause / fix / test), `refactor` (no behavior change — regression suite is the proof). All types require permission.

---

## W3. Execute the plan

```
 ┌─► E1 Read plan → E2 Implement → E3 Test → E4 Code review + security → E5 Fix bugs ─┐
 │                                 ▲                                       │         │
 │                                 └──────── back to E3 after every fix ───┘         │
 └──────── next item in plan (until complete or user says stop) ◄── done + docs ─────┘
```

| Step | What | Output | Gate |
|---|---|---|---|
| E1 Read plan | Pick the first `planned` item in the Plan queue whose dependencies are all `done`; read its spec/CR and referenced DESIGN sections; verify the spec still matches the current system; set status `in-progress` | Branch `feat/F-xxx-<name>` / `fix/CR-xxx-<name>` | Spec/CR approved (R2); dependencies done; spec still valid |
| E2 Implement | Write code strictly per spec/CR. **Do not affect existing features**: no changes to existing signatures/behavior; new things are additive (new files, new options default off, backward-compatible schema migrations); a CR touches only files in its scope | Code + tests | Build passes; no files outside scope changed |
| E3 Test | Unit + integration per test plan + **full regression** of all `done` items + fixtures (DESIGN §21.5) + **security tests** from the threat model. For CRs: tests proving unintended old behavior is unchanged | `reports/<id>/test-<n>.md` | New tests 100% pass; regression 100% pass |
| E4 Review | (a) code review of the full diff (correctness, Zero-touch, impact on existing features, matches spec, docs match code) (b) **separate security review** using the [checklist](#8-security-checklist-r6) + `npm audit`. Reviewer is not the author. Severity: **critical / major / minor / nit** | `reports/<id>/review-<n>.md`, `reports/<id>/security-<n>.md` | Every file in the diff reviewed; every checklist item checked |
| E5 Fix bugs | Fix all critical + major → back to E3 → E4 (new report round `-<n+1>`) until none remain. Minor/nit → fix or log to backlog (user decides — asked once at the end of the item). Security findings must be fixed or explicitly accepted by the user in the report | Status `done`, merged into `develop`, docs updated (R4) | Definition of Done (§6) met |

After E5 passes → short report (what was done, reports, commit) → **continue with the next plan item without asking**.

**Stop when:**
- The user says stop (finish the current item up to a safe point: commit what has passed its gate; unfinished work keeps its status and is noted in the spec Log).
- No `planned` items remain (the next item is still `todo`/`draft` → must go through W1/W2 first, R2).
- E3–E5 has looped more than 3 times and critical/major findings remain → stop and ask the user.
- Work turns out to require touching a `done` feature outside scope, or the spec is wrong/insufficient → stop; propose a CR (W2) or a spec fix (W1 ①–③).
- A manual item `M-x` in the plan → run W4 instead of E2–E5.

Bug severity:
- **critical** — data loss/corruption, Zero-touch violation, security vulnerability, daemon crash, existing feature broken
- **major** — main function behaves against spec, promised rollback missing, error the user cannot resolve
- **minor** — edge case, wrong message, poor UX with a workaround
- **nit** — style, naming

---

## W4. User manual

```
 ①Analyze the system → ②Write HTML manual (opens directly) → ③Check usage coverage → (gaps → back to ①/②)
```

| Step | What | Output | Gate |
|---|---|---|---|
| ① Analyze | Read the actual code + `done` specs + CLI `--help` + dashboard pages → build an **inventory**: every CLI command, every dashboard page/button, every config key, every user-visible error/warning badge, main flows (install → setup → scan → approve → start → open site → DB …), limitations, troubleshooting | `docs/manual/_inventory.md` | Inventory comes from the real system, not from unimplemented design |
| ② HTML manual | `docs/manual/index.html` + one page per topic; **opens straight from disk** (double-click, `file://`), no server; loads nothing external (CSS/JS/images inline or local — R6); Thai first; table of contents + search + copyable command examples + screenshots | `docs/manual/*.html` | Opens in Chrome/Edge/Firefox; no broken internal links |
| ③ Coverage check | Compare inventory ↔ manual item by item (coverage table from [`templates/manual-coverage.md`](templates/manual-coverage.md)); follow the manual for real on a clean machine (fixture projects), flow by flow; confirm it matches actual behavior | `reports/manual/coverage-<n>.md` | 100% coverage; every flow works as written; no step differs from reality |

- Runs for `M-x` plan items (after each MVP) and whenever a CR changes something user-visible (R4).
- The manual must not contain real secrets/tokens/personal paths (use examples).

---

## 5. AI (Claude) obligations

- W1/W2 steps ② and ⑤, and every R1 permission → always ask the user, **never decide for them**; ask in Thai.
- No repo code during W1/W2 (prototypes/spikes only in the scratchpad, and tell the user — never committed).
- W3: do not ask mid-item except for the "Stop when" conditions; give short progress updates.
- E4 uses a reviewer that has not seen the author's reasoning (fresh agent / `/code-review`), then **verify each finding against the real code** before fixing.
- Commit / push only after a step's gate passes; commit messages reference `F-xxx` / `CR-xxx` / `M-x`.

---

## 6. Definition of Done (per W3 item)

- [ ] Spec/CR status `done`; reports complete in `docs/reports/<id>/` (test, review, security — final round passing)
- [ ] critical = 0, major = 0, open security = 0
- [ ] Full regression passes
- [ ] No file in any user project changed (fixture test compares hashes before/after)
- [ ] DESIGN.md / PLAN.md / features/README.md / reports/README.md updated
- [ ] Merged into `develop`

---

## 7. Reports (R5)

```
docs/reports/
├── README.md                 # index: every report + latest result per item
├── F-xxx/
│   ├── test-1.md             # template: templates/test-report.md
│   ├── review-1.md           # template: templates/review-report.md
│   ├── security-1.md         # template: templates/security-report.md
│   └── test-2.md …           # next round after fixes (never overwrite earlier rounds)
├── CR-xxx/ …
├── manual/coverage-<n>.md    # template: templates/manual-coverage.md
├── design/                   # DESIGN.md reviews per version
└── regression/<date>.md      # full regression result before merge
```

- Reports are written once and never edited afterwards (append-only), so every round stays traceable.
- No real secrets / tokens / passwords / connection strings in reports (mask as `***`).

---

## 8. Security checklist (R6)

Used for every item in W1/W2 ① (threat model) and W3 E4 (security review).

| Area | Must pass |
|---|---|
| Network | Every port binds `127.0.0.1` by default; LAN exposure only on explicit user action + password; no unintended `0.0.0.0` publish |
| AuthN/AuthZ | Every endpoint requires token/session (except `/_wake`, `/_auth`, `/_webhub/login`, restricted by Host); Host allowlist (DNS rebinding); Origin check (CSRF); cookies `HttpOnly; SameSite=Strict`, host-only; master token never leaves the daemon |
| Input | Validate all input with a schema; never build shell strings (`spawn` with an args array); paths must resolve inside an allowed root (path traversal); SQL uses parameters |
| Secrets | Stored in `data/secrets.json` (user-only file permissions); never in logs, error messages, reports, exports (unless `--with-secrets`), or URL queries; passwords generated with a CSPRNG |
| Privilege | Never run as admin; elevate only for tasks that need it (hosts file) via Platform `elevate()`, one at a time, showing what will happen |
| Project code | Run approval before running a new command/compose/image (DESIGN §21.6); API Studio scripts run in isolated-vm |
| Outbound | API Studio restricts destinations (SSRF); downloaded runtimes/images verified by checksum / digest |
| Docker | webhub containers are not privileged, do not mount the Docker socket (unless required and stated in the spec), mount projects `:ro`; label `webhub.managed=true` |
| Dependencies | webhub's own lockfile; `npm audit` has no high/critical; image versions pinned |
| Data | Dangerous commands require confirmation + backup first; never auto-delete project volumes/data |
| Zero-touch | Fixture-project file hashes identical before/after |

Security severity: exploitable from another machine/website, or leaks a token/secret = **critical**; privilege escalation that needs an existing local user = **major**; missing defense-in-depth = **major** if it is a checklist item, otherwise minor.

---

## 9. Analysis of this workflow — pros / cons

| | Pros | Cons | Mitigation |
|---|---|---|---|
| Planning (W1/W2) separate from doing (W3) | Several items can be designed ahead and built later; the user chooses when to build; the plan is a clear approved backlog | A spec planned long ago may go stale after earlier items change the system | E1 checks the spec against the current system before starting — mismatch → stop, fix spec (W1 ①–③) |
| W3 runs continuously until the plan is done | No need to trigger each item; fast progress | User sees several items at once; a wrong direction costs several items | Short report after each item; user can stop anytime; automatic stop conditions (>3 loops / needs a locked feature / spec insufficient) |
| Design before code (R2) | Consistent design (DESIGN v6–v9 reviews caught issues before any code), estimable work, user steers | Slower start; design may be wrong because untested | Spikes allowed in the scratchpad (never in the repo) to prove assumptions, e.g. §18 |
| Ask for feedback on every function | Builds what the user actually wants; transparent decisions | User answers often; work waits | One question batch per function with recommendations; purely technical choices decided and justified in the spec |
| No feature changes without permission (R1) | Working features don't break silently; change history traceable | Harder refactoring; possible duplication | `refactor` CR + regression suite as proof |
| Pros/cons analysis (R3) | Trade-offs visible before deciding; rationale on record | Longer docs | Short 3-column table, no essays |
| Tests + regression every round | Confidence that nothing old broke | Test time grows with features | Fast suite (unit) / full suite (integration + Docker) — full before merge |
| Review until critical/major = 0 | High quality; no security leaks | Possibly many loops; severity may be interpreted differently | Clear severity definitions in W3; max 3 loops, then ask the user |
| Mandatory doc updates (R4) | Reliable docs; future humans/AI understand the system from docs | Extra doc work every commit | DoD checkbox; E4 checks docs match code |
| Separate reports (R5) | Clear, traceable history; specs stay small | Many files | Folder per item + index in `reports/README.md` |
| Maximum security (R6) | Fits a tool that touches the hosts file, Docker, DBs and runs other repos' code — mistakes affect the whole machine | Slower; heavier UX (more confirmations, password for LAN); some features become harder (easy LAN sharing) | One reusable checklist; confirm once per command change (not every start) |
| HTML manual + coverage check (W4) | Others can use webhub without reading DESIGN.md (matches the "anyone's projects" goal); works offline; inventory surfaces forgotten features | Manual upkeep on every UI/CLI change; screenshots age fast | Manual per MVP (`M-x`), not per commit; inventory partly generated from CLI `--help` / dashboard routes |
| Overall | Suits webhub, which touches Docker/DB/hosts file on a real machine | Not suited to quick experiments | Spikes clearly separated from the workflow |
