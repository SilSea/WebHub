# Security review — F-006 — round 1

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | `2fb0673` (`feat/F-006-scanner`) |
| Reviewer | AI agent, separate from the author |
| Scope | `src/scanner/*`, `src/cli/scan-command.ts`, wiring in `src/daemon.ts`, the helpers they rely on |
| PoCs | Scratchpad `f006-sec/` (`redos.mjs`, `e2e.mjs`, `b/e2e.mjs`, `yaml.mjs`), outside the repo |

## Verdict: **FAIL** (1 critical, 2 major)
Scanner tests pass (35/35).

### S1 — CRITICAL — `src/scanner/hints.ts:67` (EXPOSE), `:161` (FROM): ReDoS freezes the daemon
With the `m` flag, `^\s*` re-scans the rest of the file from every line start: quadratic in file size, which can be up to 256 KB.
- **Attack:** a repo with `package.json` `{"dependencies":{"express":"4"}}` and a Dockerfile of 262 144 `\n`. The synchronous regex blocks the event loop: API, cancel and shutdown all stop. The 60 s limit cannot interrupt it, and every rescan repeats the freeze.
- **Evidence:** regex 16 KB 157 ms, 32 KB 559 ms, 64 KB 4.9 s. Through `scan()`: 64 KB took 6.7 s, 256 KB took **183 s** for one candidate (not truncated).
- **Fix:**
  - Match line by line with `[ \t]` instead of `\s`.
  - Use a smaller Dockerfile cap.
  - Add a regression test: 256 KB of newlines in under 100 ms.
  - Audit every `/m` regex. Others were measured linear: `envPorts`, `scriptPort`, `vitePort`, deps, `INFRA_IMAGE`.

### S2 — MAJOR — `routes.ts:94`, `scan.ts:415`, `hints.ts:196`: a crafted repo makes the result invalid and breaks scanning everywhere
`writeDoc` saves the result without checking it against `ScanResult`.
- **Name overflow:** the fallback `${base.slice(0,36)}-${i}` reaches 41 characters at `i ≥ 1000` (cap 40).
- **`notWeb` overflow:** `.NET … (${n})` with a 255-character `n` exceeds 200.
- **`reasons` overflow:** monorepo `reasons` can exceed 400.
- **Effect:** the CLI's `State.safeParse` rejects the result, so every `webhub scan` / `--last` fails with `DAEMON_BAD_ANSWER`. After a restart `last` is `null`, and F-007 would get data that was never checked.
- **Evidence:** `e2e.mjs`: `safeParse` failed at `candidates[0].notWeb[0]` and at `candidates[1000].name`.
- **Fix:**
  - `ScanResult.parse` before saving and before setting `last`.
  - Producers clamp every field.
  - Names use `base.slice(0, 40 - suffix.length - 1)`.
  - Drop or trim a bad candidate instead of failing the whole scan.

### S3 — MAJOR — `scan.ts:471-486`: one wide repo empties the whole scan (budget starvation)
All roots are walked before any detection runs, and a `Truncated` during the walk skips detection.
- **Attack:** `a/p0..p4/d0..d4499` (22 500 folders) gives `truncated: folders` with **0 candidates**, real projects in other roots included. The 60 s time limit has the same effect.
- **Evidence:** `b/e2e.mjs`: a vite site was found alone, but next to the wide tree the result was `candidates 0`.
- **Fix:**
  - Detect what was found anyway, with a reserved time and byte budget.
  - Give each root its own folder share.
  - Record which root caused the truncation.

### S4 — minor — `scan.ts:317, 347-349`: a monorepo merge can propose a site outside the scan roots
Roots `D:\w\frontend` + `D:\w\backend` give a candidate at `D:\w`. A root of `C:\` gives a parent of `"C:"` (drive-relative). Merge only when the parent is strictly inside the scan root, and use `path.dirname`.

### S5 — minor — `compose.ts:266`: raw compose port text is stored
`"\e[2J\u202e${DB_PASSWORD:-hunter2}:3000"` ends up in `port.source`, `scan.json` and the API, with an env default value and control / bidi characters. Rebuild the text from the parsed numbers.

### S6 — minor — `hints.ts:120-152`: runtime hints are free text that F-007 will consume
`pnpm@9.0.0; curl x|sh` is kept as a hint. Fix:
- Restrict hints to a version grammar.
- Require `packageManager` to match `^(npm|pnpm|yarn|bun)@\d+\.\d+\.\d+$`.
- Note in F-007 / F-015 that hints are untrusted and never reach a shell.

### S7 — low / info
- **(a)** Sub-folder listings in `view.fill` are not filtered with `badName`.
- **(b)** `readSmall` checks only the last segment, so a junction swap of an intermediate folder (needs a concurrent local process) can redirect the read. Hard links (`nlink > 1`) are not detected either.
- **(c)** The `rootStatus` inside-home check does not `realpath` the home path.
- **(d)** About 2000 long-path duplicates gave a 2.3 MB `scan.json`. The 5 MB cap is reachable, and then the whole scan is lost as `FILE_TOO_LARGE`.

## Checked and OK
- **Links:** symlinks, junctions and reparse points are skipped. The root link check, `realpath` / `isInside` after listing, and the `ino` match on open all hold.
- **Windows path tricks:** ADS, `..` and 8.3 names cannot get in, because lookups use only names from the listing.
- **YAML:** billion-laughs, merge bombs, deep nesting and the node cap are refused in about 30 ms. Forbidden keys are blocked.
- **`.env`:** read once, not cached, only port numbers kept.
- **Error messages:** compose problems are code-only; `lastError` is fixed text.
- **CLI:** the table and `--json` are sanitized.
- **API:**
  - Auth and CSRF apply (default `user` access).
  - Starting a scan is single-flight.
  - Close aborts and waits, so nothing is written after it.
  - No project code is executed or imported, and the scanner has no code that writes files.
