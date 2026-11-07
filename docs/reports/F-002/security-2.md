# Security report — F-002 — round 2

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 990ddd5 |
| Reviewer | fresh agent, read-only + probes in scratchpad (no UAC) |

## Verdict
Not clean: S1 guard bypassable — 2 critical (environment), 2 major (file trust set). No PowerShell injection; token logic correct; no round-1 regression.

## Findings
| ID | Sev | Location | Issue | Scenario | Suggested fix |
|---|---|---|---|---|---|
| T1 | critical (verified up to DLL load attempt) | win32-trust.ts nodeEnvProblems | only `NODE_*` refused; node applies `OPENSSL_CONF` (provider `module=` DLL) during startup before JS | user-level malware sets `HKCU\Environment\OPENSSL_CONF` → DLL as admin | refuse `OPENSSL_*`, `SSL_CERT_*`; prefer allowlist |
| T2 | critical (block merge verified; AppInfo premise unverified) | win32-trust.ts ENV_PS | `HKCU\Volatile Environment` + `\<SessionId>` subkey merged by `CreateEnvironmentBlock`, user has FullControl, not read | `NODE_OPTIONS` there bypasses guard | read it + subkeys; also check `process.env` |
| T3 | major (verified, ~95 zod files loaded) | win32-trust.ts elevationFiles | only zod index/package.json/folder checked; subfolders/files (own owner, kept ACEs after same-volume move, sub `package.json`) not | edit `zod/v4/core/core.js` → admin | self-contained elevated entry (only `node:*`), or recursive walk |
| T4 | major (verified) | win32.ts elevatedCommand, win32-trust.ts | reparse points not resolved: `process.execPath` keeps link path, `Get-Acl` reads link object; real node folder/ancestors unchecked; `node_modules\zod` link (user-owned) not in list | symlinked node (nvm) with user-writable real folder → DLL plant | `realpathSync.native` for check AND launch; T3 removes zod |
| T5 | minor | TRUST_PS `$full` | WriteAttributes / WriteExtendedAttributes not in mask | none known | add bits (defense in depth) |
| T6 | info / docs | spec §6 | same-user attacker can show its own runas prompt for signed node.exe, or tamper with the guard (PSModulePath, HKCU SystemRoot → F-001 `systemExe`) — guard really protects against other local users / insecure installs | same user | state as accepted limit; real fix = CR (Program Files helper) |
| T7 | nit (accepted limit) | win32.ts killTree | snapshot→taskkill PID window; spoofed parent (same user only) | small window | optional handle-based kill / Job Object CR |

## S1–S11 status
S1 partially (T1–T4, T6); S2–S11 fixed.

## Status
Open — critical T1, T2; major T3, T4.
