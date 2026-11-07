# Security review — F-002 — round 4

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 84c99a6 |
| Reviewer | fresh agent, read-only; probes in scratchpad only, no UAC prompt triggered |

## Verdict
U1 closed (verified). No critical, no major, no PowerShell injection. Nothing exploitable on a default install.

## Findings
| ID | Sev | Location | Issue | Scenario | Suggested fix |
|---|---|---|---|---|---|
| V1 | minor (path verified; load at startup = strong inference) | win32-trust.ts `elevationFiles` | node reads default `OPENSSLDIR\openssl.cnf` (`C:\Program Files\Common Files\SSL`, compiled into node.exe) at startup; guard does not check it. Default ACL: Users read/execute only; folder absent here | installer creates `SSL` folder with loose ACL → non-admin plants `openssl.cnf` with provider `module=` → DLL loads as admin (T1 primitive) | launch elevated node with `--openssl-config=NUL` (verified: neutralises `ＯPENSSL_CONF` look-alike, crypto still works) — also removes U4; alt: add OPENSSLDIR (or deepest existing ancestor) to trust targets |
| V2 | minor (unverified, install-dependent) | win32-trust.ts `nodeDirEntries` | readdir error → `[]` (fail-open; = review G7); matched DLL entries not resolved to real path (symlink target ancestors unchecked) | node folder not listable but ACL readable; or existing DLL is a link | non-ENOENT readdir error → `ELEVATION_UNSAFE`; `realPath` each matched entry (or refuse reparse points) and check with ancestors |
| V3 | minor (unverified, pre-existing) | win32-trust.ts TRUST_PS | `A` entry with `Test-Path` false → silent `continue`; `Test-Path` swallows access-denied; ancestors of an existing node.exe must exist | contrived ACL: traversable-not-listable admin folder containing attacker subfolder denying read-attributes | report missing `A` path as problem (`missing ancestor`), or drop `Test-Path` and let `Get-Acl` failure → `unreadable` |
| V4 | minor (from memory of node exit codes) | elevated.mts `EXIT.ok = 10`; win32.ts `elevateOutcome` | node uses exit 10 (kBootstrapFailure) itself → bootstrap failure reported as success (= review G3) | not attacker-driven; matters once tasks are not noop | success code outside node's reserved set (1–14, >128), e.g. 42; unit test for no collision |
| V5 | info (unverified) | spec §3.3 | env denylist covers only names node reads; `PATH`, `_NT_SYMBOL_PATH`, `windir`/`SystemRoot` unchecked — not reached by noop task on node 24.20 (static imports all in System32, `DependentLoadFlags` 0 — verified) | future tasks using COM / shell / spawn, or assertion failure while admin | spec note: elevated tasks must not depend on inherited env; consider minimal env in ELEVATE_PS later |
| V6 | info | win32-trust.ts `.local` | `node.exe.local` folder contents not checked (= review G6); embedded manifest has no `dependentAssembly`, `DevOverrideEnable` unset (verified) | none by default; only admin can set DevOverrideEnable | document; optionally check `.local` recursively |
| V7 | info | elevated.mts, win32.ts | no issue: E9 correct; exit 10 only after decode + runTask; `isMain` false → 0 → failed; unknown code → FAILED; UseShellExecute gives own console, no fake `EXIT:` lines | — | — |

## Probes
- Env-name variants: `OPENSSL_CONF` / `openssl_conf` with bad config abort node (134); spaces, `=`, `-`, NBSP, ZWSP, U+2010, embedded NUL → inert or rejected by spawn.
- ASCII 0x20–0x7E byte-identical in ANSI codepages 932/936/949/950/874/1250/1251/1252/1258; DBCS look-alike needs lead byte ≥ 0x81 → non-ASCII in UTF-16 → refused.
- Control chars / embedded NUL in registry names refused by `NON_ASCII` (registry write not done — unverified).
- Leading `=`, duplicates across HKLM/HKCU/Volatile, REG_EXPAND_SZ: cannot turn an accepted name risky (prefix regex anchored).
- Other narrow-CRT readers: OpenSSL (`OPENSSL_*`, `SSL_CERT_*`), ICU (`ICU_*`) covered; `TZ` data only; libuv/node use wide APIs.
- E6 realPath fails closed; E7 length checked before UAC; TRUST_PS no injection (base64 stdin, `-LiteralPath`).
- F-001 helpers untouched.

## Previous findings
U1 closed (verified). U2 closed. U3 mostly closed (gaps V2). U4 accepted (V1 fix removes it). U5 accepted. U6 fixed for throwing ancestors (silent-skip = V3). No regression of T1–T7, S*, C*, CR-001, E1–E10.

## Status
critical 0, major 0. Minor V1–V4; info V5–V7.
