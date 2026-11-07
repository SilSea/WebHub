# Security report — F-002 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 0d10906 |
| Reviewer | fresh agent (no prior context), read-only + probes in scratchpad |

## Verdict
No caller-controlled data reaches PowerShell script text or admin argv beyond the zod allowlist. All scripts are fixed text; data goes on stdin (base64) or as integer-validated PIDs. One major finding (S1) is largely inherent to the approved Q2 design and needs a user decision on scope.

## Findings
| ID | Sev | Location | Issue | Scenario | Suggested fix |
|---|---|---|---|---|---|
| S1 | major (critical under R6 if same-user attacker in scope — user decision) | win32.ts elevate, elevated.ts | Admin node loads code/config writable by non-admin: `dist/platform/*.js`, `node_modules/zod`, possibly `node.exe` (nvm/volta/scoop). Verified: global npm prefix `E:\UtilityPrograms\npm-global` and repo `dist` grant `Authenticated Users: Modify`. Unverified: elevated process rebuilds env from profile → `HKCU\Environment` `NODE_OPTIONS=--import …` reaches admin node | malware as user edits elevated.js or sets NODE_OPTIONS, waits for next UAC (shows genuine signed Node.js) → admin | (a) state same-user attacker scope in §6; (b) refuse elevate when node dir / package root writable by non-admins; (c) refuse when `NODE_*` loader vars set in HKCU/HKLM Environment; (d) long term CR: helper installed in Program Files |
| S2 | minor (unverified) | win32.ts Start-Process | Working directory of elevated process inherited (maybe user project dir) → DLL planting for missing DLLs | plant DLL | `-WorkingDirectory $env:SystemRoot\System32` |
| S3 | minor | win32.ts timeout | After timeout only powershell killed; UAC prompt still valid → task runs later after webhub reported failure | user delay | idempotent tasks or token expiry (issued-at + max age) checked in elevated.js |
| S4 | minor | win32.ts catch | every `InvalidOperationException` → `DENIED` hides real failures | misleading error | DENIED only on Win32 error 1223 |
| S5 | minor (unverified) | win32.ts killTree | `taskkill /T` walks by ParentProcessId → may include a process whose parent was an earlier holder of the PID; small window between check and kill | unrelated same-user process killed | enumerate tree with CreationDate ≥ parent, re-check each; or Job Object later |
| S6 | nit | win32.ts killTree | (pid, startedAt) from any `info()` passes → not proof that webhub spawned it | tampered state file (same-user) | document: callers use webhub's own records only |
| S7 | minor (verified) | win32.ts notify/elevate stdin split | `Trim()` + split drops empty fields → empty body ⇒ notify always false; empty title shifts body | silent failure | per-field marker / split before trim |
| S8 | minor (verified) | win32.ts scripts | PowerShell 5.1 pipe uses OEM codepage → non-ASCII path/name become `??` | wrong `info().exe` | UTF-8 output encoding or base64 UTF-8 JSON |
| S9 | nit | win32.ts info | `CreationDate` `$null` → method call throws → `PLATFORM_TOOL` instead of undefined | availability | null guard |
| S10 | nit | win32.ts cleanText | keeps U+FFFE/FFFF, may cut surrogate pair → `LoadXml` throws → false | one toast lost | strip those + lone surrogates, slice by code point |
| S11 | nit | win32.ts listening cache | cached array returned by reference | caller mutation corrupts cache | return copy |

## Checked clean
ArgumentList quoting (no `"` possible in Windows paths, token `[A-Za-z0-9_-]`); no PowerShell injection; elevated.js re-validates, reads no files, realpath isMain; JSON output cannot be forged via CIM strings; netsh parser digits-only; killTree fails safe on unknown/mismatch.

## Status
Open — fixes tracked in review round 1 response.
