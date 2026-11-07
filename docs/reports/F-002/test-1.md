# Test report — F-002 — round 1

| | |
|---|---|
| Date | 2026-11-07 |
| Commit | (this commit — first implementation) |
| Environment | Windows 11 Pro 26200, Node 24.20.0, pnpm 12.9.1 (CI blocked by GitHub billing lock — Linux / Node 22 not run) |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| all (unit + integration, F-000 + F-001 + F-002) | 144 | 0 | 5 |
| — F-002 unit (`test/unit/platform.test.ts`) | 16 | 0 | 0 |
| — F-002 integration (`test/integration/platform.test.ts`) | 7 | 0 | 0 |
| regression F-000 + F-001 | 121 | 0 | 5 |

## Test plan coverage (spec §8)
| # | Case | Test | Result |
|---|---|---|---|
| 1 | `listening()` sees own port + own PID | integration | pass |
| 2 | parse CIM/netsh fixtures, malformed → `PLATFORM_TOOL` | unit (`parseListening`, `parseExcluded`) | pass |
| 3 | `reserved()` numbers + administered flag | unit fixture + integration (sane ranges) | pass |
| 4 | `canBind` false while used / true after | integration | pass |
| 5 | `findFree` skips taken/unbindable/avoid; exhausted / invalid range | unit (`pickFree`) + integration | pass |
| 6 | `info` own PID; unknown PID → undefined | integration | pass |
| 7 | `killTree` child + grandchild; wrong start time → `PROCESS_MISMATCH`, process stays alive; second call on dead PID ok | integration | pass |
| 8 | `usage` own PID numbers | integration | pass |
| 9 | elevate: unknown kind / extra field / malformed token refused in `parseTask`, `decodeTask`, `elevated.main` (exit 2), and `platform.elevate` before UAC; `elevatedCommand` absolute paths | unit | pass |
| 10 | real UAC elevation | **manual — not run yet** (needs a human to click UAC; only `noop` kind exists, no admin action to verify in MVP-1) | pending |
| 11 | notify with `'";$(calc)<b>&` never throws; `cleanText` strips control chars + caps length | unit + integration | pass |
| 12 | non-win32 → `PLATFORM_UNSUPPORTED`, notify → false | unit | pass |
| 13 | regression F-000 + F-001 | full suite | pass |

Other checks: lint (Biome), typecheck, build — pass.
