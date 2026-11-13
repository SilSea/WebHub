/**
 * Daemon log file with a byte cap (CR-003): `node dist/daemon.js --log-file <path>`.
 *
 * - The file must sit directly in `$WEBHUB_HOME/logs` (no sub-directory) with a plain name
 *   (`[A-Za-z0-9][A-Za-z0-9._-]*`, no trailing dot, no Windows device name). `logs/` and the
 *   file may not be symlinks/junctions; an existing file must be a regular file with one link
 *   (no hardlink to another file of the user). Checked before start-up and again before
 *   every open; after opening, the handle itself is checked (`fstat`). On POSIX the open uses
 *   `O_NOFOLLOW | O_NONBLOCK` (no symlink followed, a FIFO never blocks the event loop).
 * - Lines are appended synchronously. Before a line that would push the file past `maxBytes`,
 *   the file is renamed to `<path>.1` (replacing the old one) and a new file is started, so the
 *   two files together stay under ~2 × `maxBytes` (F-003 security-6 U4, security-8 Y1).
 *   If the rename fails (a reader on Windows without delete sharing, an antivirus scan, `.1`
 *   is a directory), the file is truncated instead: the cap always holds, recent lines are
 *   lost. A file that was already larger than the cap before start-up moves to `.1` as is.
 * - A failed or short write never throws (disk full, file locked): the line is dropped and the
 *   file is re-opened at most once per second (monotonic clock), like EPIPE on stdout (K2).
 */
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { Paths } from "../config/home.js";
import { WebhubError } from "../errors.js";
import { assertSafePath } from "../fs/safe-path.js";

export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const REOPEN_AFTER_MS = 1_000;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export interface LogFile {
  readonly path: string;
  /** Appends one JSON line; never throws. */
  write(entry: Record<string, unknown>): void;
  close(): void;
}

export interface LogFileOptions {
  maxBytes?: number;
  /** Monotonic milliseconds (tests). */
  now?: () => number;
  /** Test hook: replaces `fs.writeSync`. */
  writeSync?: (fd: number, buf: Buffer) => number;
}

/**
 * Validates `file` (relative paths resolve against the current directory) and returns its
 * absolute path. Throws `WebhubError` (`PATH_OUTSIDE_HOME`, `SYMLINK_REFUSED`, `HOME_INVALID`).
 */
export async function resolveLogFile(paths: Paths, file: string): Promise<string> {
  const abs = resolve(file);
  const name = basename(abs);
  if (dirname(abs) !== resolve(paths.logs)) {
    throw new WebhubError(
      "PATH_OUTSIDE_HOME",
      `--log-file must be a file directly in ${paths.logs}`,
      {
        file: abs,
      },
    );
  }
  if (!NAME.test(name) || name.endsWith(".") || DEVICE.test(name)) {
    throw new WebhubError(
      "HOME_INVALID",
      "--log-file name must be letters, digits, '.', '_' or '-' (not a device name)",
      { file: abs },
    );
  }
  await assertSafePath(paths.home, abs);
  await assertSafePath(paths.home, `${abs}.1`);
  assertUsable(abs);
  return abs;
}

/** `logs/` is a real directory; the file is missing or a regular file with a single link. */
function assertUsable(abs: string): BigIntStats | undefined {
  const dir = lstatSync(dirname(abs), { throwIfNoEntry: false, bigint: true });
  if (dir !== undefined && (dir.isSymbolicLink() || !dir.isDirectory())) {
    throw new WebhubError("SYMLINK_REFUSED", `not a plain directory: ${dirname(abs)}`, {
      file: dirname(abs),
    });
  }
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (st === undefined) return dir;
  if (st.isSymbolicLink()) {
    throw new WebhubError("SYMLINK_REFUSED", `refusing symlink/junction: ${abs}`, { file: abs });
  }
  if (!st.isFile() || st.nlink !== 1) {
    throw new WebhubError(
      "HOME_INVALID",
      `--log-file must be a regular file with one link: ${abs}`,
      { file: abs },
    );
  }
  return dir;
}

// Node 22 on Windows reports `dev` = 0 from lstat (fstat is right): compare it only when both
// sides know it; `ino` (NTFS file id) identifies the file within the volume of `logs/`
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  a.ino === b.ino && (a.dev === b.dev || a.dev === 0n || b.dev === 0n);

/**
 * After the open (review-2 B4): `logs/` is still the directory checked before it, and the path
 * now names exactly the file behind `fd` (not a link swapped in between check and open).
 */
function assertOpenedInPlace(abs: string, fd: number, dirBefore: BigIntStats | undefined): void {
  const dir = lstatSync(dirname(abs), { bigint: true });
  if (dir.isSymbolicLink() || (dirBefore !== undefined && !sameFile(dir, dirBefore))) {
    throw new Error("logs/ changed during open");
  }
  const handle = fstatSync(fd, { bigint: true });
  const path = lstatSync(abs, { bigint: true });
  if (path.isSymbolicLink() || !sameFile(handle, path)) throw new Error("file changed during open");
}

const APPEND: string | number =
  process.platform === "win32"
    ? "a"
    : constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK;

/** Empties the file behind `appendFd`; on Windows through a second handle checked to be the same file. */
function truncateChecked(appendFd: number, abs: string): void {
  if (process.platform !== "win32") {
    ftruncateSync(appendFd, 0);
    return;
  }
  const a = fstatSync(appendFd, { bigint: true });
  // the path is not re-resolved blindly: the new handle must be the same file (dev + ino)
  const rw = openSync(abs, "r+");
  try {
    const b = fstatSync(rw, { bigint: true });
    if (a.dev !== b.dev || a.ino !== b.ino || b.nlink !== 1n) throw new Error("file changed");
    ftruncateSync(rw, 0);
  } finally {
    closeSync(rw);
  }
}

/** `abs` must come from `resolveLogFile`. The file is opened lazily (after `ensureHome`). */
export function openLogFile(abs: string, opts: LogFileOptions = {}): LogFile {
  const maxBytes = opts.maxBytes ?? LOG_FILE_MAX_BYTES;
  const now = opts.now ?? (() => performance.now());
  const write = opts.writeSync ?? ((fd: number, buf: Buffer) => writeSync(fd, buf));
  let fd: number | undefined;
  let size = 0;
  let failedAt: number | undefined;
  /** The last write was short: the file ends in a cut line. */
  let cut = false;

  const closeFd = () => {
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {
      // already gone
    }
    fd = undefined;
  };

  const fail = () => {
    closeFd();
    failedAt = now();
  };

  /** Opens for append (`truncate` → empties it after the checks). */
  const open = (truncate: boolean): boolean => {
    try {
      // re-checked before every open: a link planted later is refused
      const dirBefore = assertUsable(abs);
      fd = openSync(abs, APPEND, 0o600);
      const st = fstatSync(fd); // the handle itself
      if (!st.isFile() || st.nlink !== 1) throw new Error("not a single-link regular file");
      assertOpenedInPlace(abs, fd, dirBefore); // closes the check → open race (B4)
      // Windows: an append-only handle cannot truncate → a second, checked read-write handle
      if (truncate) truncateChecked(fd, abs);
      size = truncate ? 0 : st.size;
      failedAt = undefined;
      return true;
    } catch {
      fail();
      return false;
    }
  };

  const rotate = (): boolean => {
    closeFd();
    try {
      renameSync(abs, `${abs}.1`);
    } catch {
      return open(true); // cannot rename: truncate to keep the cap
    }
    return open(false);
  };

  return {
    path: abs,
    write(entry) {
      const line = `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`;
      if (fd === undefined) {
        // a clock that is never earlier than failedAt (monotonic); still guarded
        if (failedAt !== undefined) {
          const elapsed = now() - failedAt;
          if (elapsed >= 0 && elapsed < REOPEN_AFTER_MS) return;
        }
        if (!open(false)) return;
      }
      // after a short write, end the cut line first so this one stays parseable (Z7)
      const withPrefix = () => Buffer.from(cut && size > 0 ? `\n${line}` : line);
      // the cap counts the prefix too (review-2 B2); a rotate starts a new file (no prefix)
      if (size > 0 && size + withPrefix().length > maxBytes && !rotate()) return;
      const buf = withPrefix();
      try {
        const n = write(fd as number, buf);
        size += n;
        // `cut` changes only once a write was attempted and its result is known (review-2 B1)
        cut = n !== buf.length;
        if (cut) fail(); // a short write: start over from a fresh open
      } catch {
        fail(); // nothing known to be written: `cut` keeps its value
      }
    },
    close: closeFd,
  };
}
