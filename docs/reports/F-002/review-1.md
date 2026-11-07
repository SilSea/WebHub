# Code review — F-002 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | 0d10906 |
| Reviewer | fresh agent (no prior context), read-only + probes outside repo |

## Findings
| ID | Sev | Location | Problem | Scenario | Suggested fix |
|---|---|---|---|---|---|
| C1 | major (verified) | win32.ts canBind / findFree | `canBind` binds only 127.0.0.1 → returns true while another process listens on `::1`, `[::]` or `0.0.0.0` | Vite on `localhost` (::1) → webhub hands out same port | also try `::1` (and `::` for 0.0.0.0), skip if no IPv6; re-read listening fresh in findFree; test with other-process listeners |
| C2 | major | win32.ts killTree | poll = 50 × (processState ≈0.45 s + 100 ms) → real timeout ≈27 s, spec says 5 s | access-denied kill hangs CLI ~27 s | deadline-based loop; fail fast when taskkill fails and process alive |
| C3 | major (verified) | win32.ts elevate | PS 5.1 `Start-Process` throws `InvalidOperationException` for missing file too → reported as DENIED | node/elevated.js missing → "permission not granted" | `[Diagnostics.Process]::Start` + `Win32Exception.NativeErrorCode -eq 1223`; check exe/script exist first |
| C4 | major (missing test) | test/unit/platform.test.ts | spec §8 #11 needs proof notify script never contains user text | future regression passes tests | export script builders; assert script constant, text only in stdin |
| C5 | minor (verified) | win32.ts notify stdin | `.Trim()` drops empty field → empty title/body ⇒ false | `notify("x","")` fails | per-field split/trim |
| C6 | minor (verified) | win32.ts elevatedCommand | from source → `node elevated.ts` → ERR_MODULE_NOT_FOUND | dev UAC yes → FAILED | clear error / point to dist; doc #10 runs from build |
| C7 | minor | win32.ts killTree | `unknown` state reported as `PROCESS_MISMATCH` | CIM hiccup looks like PID reuse | `PLATFORM_TOOL` |
| C8 | minor | index.ts unsupported | stub throws synchronously though API returns Promise | `.catch()` bypassed on Linux/macOS | async throw |
| C9 | minor | win32.ts elevate timeout | 600 s timeout kills PS but UAC prompt remains | task runs after FAILED reported | document / idempotent; distinct timeout message |
| C10 | minor | win32.ts | notify failure not logged; spawn/`SYSTEM_TOOL` errors leak as non-PlatformError | undiagnosable; `isPlatformError` misses | log hook; wrap tool errors as `PLATFORM_TOOL` |
| C11 | minor (unverified) | win32.ts killTree | check→kill window; orphaned grandchildren not killed by `/T` | npm wrapper exits, vite survives | Job Object (later CR) |
| C12 | minor (unverified, **needs CR on F-001**) | src/store/lock.ts:91 | start time compared as string from local→UTC conversion; TZ/DST change → mismatch | cannot stop own processes after TZ change (fails safe) | CIM UTC / compare instants |
| C13 | minor (test) | test/integration/platform.test.ts | killTree test leaks processes on failure; ports tests only same-process 127.0.0.1; no reserved/exhausted integration | false confidence | finally-kill; cross-process IPv6/0.0.0.0 tests |
| C14 | nit | win32.ts listening cache | shared mutable array; no in-flight dedupe; no reset | caller mutation corrupts cache | copy, share promise, fresh option |
| C15 | nit | win32.ts info/usage | `parentPid` 0 not undefined; bad PID → `PROCESS_MISMATCH` | contract mismatch | map 0 → undefined |
| C16 | nit | win32.ts cleanText | cut by UTF-16 unit; keeps U+FFFE/FFFF | toast lost | code-point slice, strip invalid XML chars |

Overlap with security-1: C3≈S4, C5≈S7, C9≈S3, C11≈S5, C14≈S11, C16≈S10.

## Checked OK
PID integer validation before WQL; `ConvertTo-Json -InputObject @()` array for 0/1 rows; CIM State 2 = Listen; usage units; port bounds; parseExcluded; isMain under dist/vitest; elevate data on stdin.

## Status
Open — critical 0, major 4 (C1–C4) + security S1 (major, scope decision).
