/**
 * Read-only file access of the scanner (F-006 §3.1 / §3.2). Nothing here writes, locks or runs
 * anything: files are opened O_RDONLY, links of every kind (symlink, junction, other reparse
 * points) are never followed, and what was opened is checked to be what was looked at.
 */
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isInside } from "../fs/safe-path.js";

/** Why a folder was not walked. */
export type SkipReason = "link" | "too-many-entries" | "changed" | "bad-name" | "no-access";

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "link" | "other";
}

/** Shared limits of one scan (§3.1). Every read and every folder counts. */
export interface ScanLimits {
  depth: number;
  folders: number;
  entriesPerFolder: number;
  bytes: number;
  fileBytes: number;
  timeMs: number;
  candidates: number;
  skipped: number;
  deps: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  // config `maxDepth` (F-001, default 3) replaces it per scan
  depth: 3,
  folders: 20_000,
  entriesPerFolder: 5_000,
  bytes: 64 * 1024 * 1024,
  fileBytes: 256 * 1024,
  timeMs: 60_000,
  candidates: 2_000,
  skipped: 500,
  deps: 2_000,
};

export type TruncateReason = "time" | "folders" | "bytes" | "candidates";

/** Thrown when a limit is reached: the walk stops and keeps what it has. */
export class Truncated extends Error {
  constructor(readonly reason: TruncateReason) {
    super(`scan limit reached: ${reason}`);
    this.name = "Truncated";
  }
}

/** Counters of one scan; `check()` throws Truncated / the abort reason. */
export class Budget {
  folders = 0;
  bytes = 0;
  #deadline: number;
  #maxBytes: number;
  #maxFolders: number;
  #reserved = false;

  constructor(
    readonly limits: ScanLimits,
    readonly signal: AbortSignal | undefined,
    readonly now: () => number = Date.now,
  ) {
    this.#deadline = now() + limits.timeMs;
    this.#maxBytes = limits.bytes;
    this.#maxFolders = limits.folders;
  }

  /**
   * Once per scan, after the walk was cut short: extra time (1/6), bytes and folders (1/8) so the folders
   * already found are still detected (review-1 C1 / security-1 S3).
   */
  reserve(): void {
    if (this.#reserved) return;
    this.#reserved = true;
    this.#deadline = Math.max(this.#deadline, this.now()) + Math.ceil(this.limits.timeMs / 6);
    this.#maxBytes = Math.max(this.#maxBytes, this.bytes) + Math.ceil(this.limits.bytes / 8);
    this.#maxFolders =
      Math.max(this.#maxFolders, this.folders) + Math.ceil(this.limits.folders / 8);
  }

  check(): void {
    this.signal?.throwIfAborted();
    if (this.now() > this.#deadline) throw new Truncated("time");
  }

  folder(): void {
    this.check();
    if (++this.folders > this.#maxFolders) throw new Truncated("folders");
  }

  /** Bytes that may still be read by one file (≤ fileBytes). */
  allowance(max: number): number {
    this.check();
    const left = this.#maxBytes - this.bytes;
    if (left <= 0) throw new Truncated("bytes");
    return Math.min(max, this.limits.fileBytes, left);
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * A name that cannot reach a terminal or a Windows API safely: control / C1 characters, lone
 * surrogates, bidi controls, Windows reserved device names, a trailing dot or space.
 */
export function badName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return true;
  if (CONTROL.test(name) || LONE_SURROGATE.test(name)) return true;
  if (process.platform === "win32" && (RESERVED.test(name) || /[. ]$/.test(name))) return true;
  return false;
}

/** Path compare as the file system does (case-insensitive on Windows). */
export const samePath = (a: string, b: string): boolean =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Entries of a folder that is not a link and still is the folder that was looked at
 * (`realpath` equals the expected path, inside `root` — a folder swapped for a junction between
 * the two calls is refused). At most `limits.entriesPerFolder` entries.
 */
export async function listDir(
  abs: string,
  root: string,
  budget: Budget,
): Promise<{ entries: DirEntry[] } | { skip: SkipReason }> {
  budget.folder();
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return { skip: "link" };
    if (!st.isDirectory()) return { skip: "changed" };
    const dir = await opendir(abs, { bufferSize: 64 });
    const entries: DirEntry[] = [];
    try {
      for await (const d of dir) {
        if (entries.length >= budget.limits.entriesPerFolder) return { skip: "too-many-entries" };
        entries.push({
          name: d.name,
          type: d.isSymbolicLink()
            ? "link"
            : d.isFile()
              ? "file"
              : d.isDirectory()
                ? "dir"
                : "other",
        });
      }
    } finally {
      await dir.close().catch(() => {});
    }
    const real = await realpath(abs);
    if (!samePath(real, abs) || !isInside(root, real)) return { skip: "changed" };
    return { entries };
  } catch (err) {
    if (err instanceof Truncated || budget.signal?.aborted === true) throw err;
    return { skip: "no-access" };
  }
}

/**
 * At most `max` bytes of a regular file that is not a link (UTF-8, BOM removed); undefined when
 * missing, a link, not a file, swapped while opening, or unreadable. Counts toward the budget.
 */
export async function readSmall(
  abs: string,
  max: number,
  budget: Budget,
): Promise<string | undefined> {
  const allowed = budget.allowance(max);
  try {
    const st = await lstat(abs, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    const fh = await open(abs, constants.O_RDONLY);
    try {
      const fst = await fh.stat({ bigint: true });
      if (fst.ino !== st.ino || !fst.isFile()) return undefined;
      const buf = Buffer.alloc(Math.min(allowed, Number(fst.size)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      budget.bytes += bytesRead;
      const text = buf.subarray(0, bytesRead).toString("utf8");
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err instanceof Truncated || budget.signal?.aborted === true) throw err;
    return undefined;
  }
}
