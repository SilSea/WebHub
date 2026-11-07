# Security report — F-002 (+ CR-001) — round 3

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 3474911 |
| Reviewer | fresh agent, read-only + probes in scratchpad (no UAC) |

## Verdict
Not clean: 1 critical (U1). No PowerShell injection; CR-001 OK; no regression of rounds 1–2.

## Findings
| ID | Sev | Location | Issue | Scenario | Suggested fix |
|---|---|---|---|---|---|
| U1 | critical (verified) | win32-trust.ts RISKY_ENV / nodeEnvProblems | ASCII-only regex; OpenSSL reads `OPENSSL_*` via CRT narrow `getenv` (ANSI codepage + best-fit, case-insensitive) → `ＯPENSSL_CONF`, `OPENŚSL_CONF`, `ŌPENSSL_CONF`, `OPENSSL＿CONF` … all load the config (verified on node 24.20, ACP 1252). `NODE_*` not affected (wide API) | same attacker as T1 sets non-ASCII-named `OPENSSL_CONF` → provider DLL as admin; guard passes | refuse any env name with non-ASCII chars; unit test |
| U2 | minor (env read verified; no current impact) | RISKY_ENV | ICU honors `ICU_TIMEZONE_FILES_DIR` (verified), likely `ICU_DATA` | relevant once an elevated task uses Intl/dates | add `ICU_` prefix |
| U3 | minor (unverified, install-dependent) | elevationFiles | existing `*.dll` in node's folder with a user ACE not checked individually | insecure/custom node install | F-check `*.dll`/`*.manifest`/`*.local` in node's folder |
| U4 | info | node.exe build | compiled-in MODULESDIR `c:\ws\…`; `C:\ws` creatable by any user; only used for name-loaded providers (blocked / admin-only config) | not exploitable by default (unverified) | document |
| U5 | info | ENV_PS | `ParseAutoexec` → `C:\autoexec.bat` admin-only | none | note in spec |
| U6 | nit (verified) | TRUST_PS | unreadable ancestor → `Test-Path` throws → `PLATFORM_TOOL` instead of `ELEVATION_UNSAFE` (still fails closed) | misleading code | move Test-Path inside try → "unreadable" |

## T1–T7 status
T1 partially (U1); T2–T5 fixed; T6 documented accurately; T7 accepted.

## CR-001
OK — only `.mts`→`.mjs(.map)` added; unexpected files still fail.

## Status
Open — critical U1. W3 loop limit (3) reached → user decision.
