# Code review — F-002 — round 2

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 990ddd5 (fixes for review-1 / security-1) |
| Reviewer | fresh agent, read-only + probes against dist in scratchpad (no UAC) |

## Findings
| ID | Sev | Location | Problem | Scenario | Suggested fix |
|---|---|---|---|---|---|
| D1 | major (security, verified) | win32-trust.ts nodeEnvProblems | env guard only rejects `NODE_*`; node reads `OPENSSL_CONF` at startup (verified: provider DLL load attempted before JS) | user-level malware sets `HKCU\Environment\OPENSSL_CONF` → DLL runs as admin on a trusted install | also reject `OPENSSL_*`; prefer allowlist approach; test + spec |
| D2 | major (security, unverified) | win32-trust.ts ENV_PS | `CreateEnvironmentBlock` also merges `HKCU\Volatile Environment` (+ per-session subkey), not read | `NODE_OPTIONS` there bypasses guard | enumerate Volatile Environment + subkeys |
| D3 | minor (test flake) | integration excluded-range test | adjacent reserved 100-port blocks → window fully excluded → `PORT_EXHAUSTED` | fails on Hyper-V/WSL/Docker machines | pick window past merged run of adjacent ranges |
| D4 | minor (verified) | win32-trust.ts elevationFiles | missing `<root>/node_modules` → `missing` → false `ELEVATION_UNSAFE` | hoisted install | only when exists / ancestor mode |
| D5 | minor (unverified) | win32.ts killTree | children killed before root → supervisor may respawn a child not in tree → success reported | orphan dev server keeps port | root first; optional rescan |
| D6 | minor (perf, verified) | win32.ts canBind | fresh CIM (~1 s) per call | N sequential checks ≈ N s | document parallel / batch |
| D7 | minor (test gap) | trust tests | "writable by" branch / masks never exercised on real ACL | mask regression undetected | test with C:\Windows\Temp-like folder |
| D8 | nit | trust test | elevated shell → temp owner = Administrators → owner assert fails | test fails as admin | assert problems non-empty |
| D9 | nit | foreignListener | never resolves if child fails | 60 s hang | reject on exit/error |
| D10 | nit | killTree fail-fast | taskkill 128 when any PID already gone; possible spurious fail | unlikely | stricter fail-fast |
| D11 | nit | listening fresh | joins in-flight query started earlier | stale snapshot | new query when fresh |
| D12 | nit | elevate timeout | 330 s covers prompt + task run | late Yes + long task → "timed out" while task ran | note for MVP-2 |
| D13 | nit (docs) | spec §3.3/§3.5 | still mentions `Start-Process -Verb RunAs -Wait`, exit codes 0/2/1 | docs ≠ code | update |
| D14 | nit | win32-shell.ts runExe | taskkill/netsh output OEM codepage decoded as UTF-8 | mojibake in details | accept / decode OEM |

## Round-1 fixes
Verified OK: C1, C2, C3/S4, C4, C5/S7, C6, C7, C8, C9/S3 (docs stale → D13), C10, C14/S11, C15, C16/S10, S2, S5 (ordering → D5), S8 (PS only → D14), S9.
Incomplete: S1 guard (D1, D2, D4); C13 (D3, D9).

## Status
Open — major D1, D2.
