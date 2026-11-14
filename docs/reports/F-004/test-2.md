# Test report — F-004 — round 2

| | |
|---|---|
| Date | 2026-11-14 |
| Commit | fixes for review-1 / security-1 on `feat/F-004-cli-client` (after `d8ca148`) |
| Environment | Windows 11 Pro 26200. Node 24.20.0 (full suite), Node 22.12.0 (F-004 suites). pnpm 12.9.1. CI is blocked, so Linux was not run. |

## Summary
| Suite | Pass | Fail | Skip |
|---|---|---|---|
| Full suite, Node 24.20 | 365 | 0 | 6 |
| `cli`, `cli-daemon`, `cli-stop` (unit) + `cli` (integration), Node 22.12 | 71 | 0 | 0 |

Lint, typecheck, build and `pnpm audit` (high) pass.

## New / changed tests (per finding)
| Finding | Test |
|---|---|
| D1, D2 | `daemonEnv` drops `NODE_DEBUG`, `node_debug_native`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_V8_COVERAGE`, `OPENSSL_CONF`, `SSL_CERT_FILE`, `UV_THREADPOOL_SIZE`, `ICU_DATA`, a non-ASCII name; keeps `NODE_ENV`, `Path`, `NODEJS_HOME`. Real child (`report` entry) started with `NODE_DEBUG=http,net` sees no `NODE_DEBUG` |
| C1 | integration: 4 × `daemon stop` at once on a real daemon → all exit 0 with empty stderr, PID gone, auth.json gone. unit: our daemon answering 503 (stopping) → waited for, stopped, nothing killed |
| C2 | new `test/unit/cli-stop.test.ts` (fake `Platform` + a 503 squatter): `--force` kills exactly `(lock pid, lock startedAt)`; PID reused while waiting → stopped, `killTree` never called; impostor with dead daemon → `DAEMON_IMPOSTOR` in < 3 s, no kill even with `--force`; auth.json / lock disagree → no kill; process table unreadable → no kill; squatter never sees `authorization`. integration: hung daemon `--force` asserted unconditionally (`forced: true`, < 5 s); lock start time changed → not forced, process still alive right after; impostor `stop --force` exit 1 with "not the webhub daemon" in < 8 s |
| C3 | `parseStartError` unit (describe() format, CRLF, sanitised); `fail-2` fixture prints exactly describe() → `details ["detail one"]`, `hint`; busy port: no doubled `-   -` prefix |
| C4 | `never-ready` stderr line appears in the timeout error's details; process table unreadable → child killed through its handle, PID gone |
| C5 | `killTree` PROCESS_MISMATCH → `DAEMON_FORCE_REFUSED`; PROCESS_KILL_FAILED → `DAEMON_KILL_FAILED` with the platform details, auth.json kept |
| C6 / D3 | a new auth.json written during the kill is kept |
| C7 | covered by the C1 / C2 unit tests (unreadable table ≠ dead; dead PID → stale auth.json removed) |
| C8 | reasoned (non-transient errors rethrown; child killed in `finally`) — no test with a broken home mid-start |
| C9 | `readLastLines`: 3000 × 100-byte lines, last 3 / 2000 lines, byte cap drops the cut line, short file keeps its first line |
| C12 | `errorJson` unit (code, message without prefix, details, hint; unknown error → class name only) |
| D5 | `sanitize` replaces U+061C, U+200B, U+200E, U+200F, U+FEFF; keeps a ZWJ emoji family |

Correction to test-1 row 10: the round-1 integration test did not show "nothing killed"; it is now shown by the unit tests above.

## Not run
- Linux and macOS.
- A real Ctrl+C on a terminal (`logs -f`, and `start` interrupted → temp file renamed to `daemon.err`).
- `logs -f | head` EPIPE handling (reasoned).
