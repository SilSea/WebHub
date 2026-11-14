/**
 * `webhub daemon logs [-n N] [-f]` (F-004 §3.6): reads `logs/daemon.log(.1)` straight from
 * disk — no daemon route, so no stream over the API. Every line is sanitised: log lines hold
 * request paths sent by browsers / local programs (terminal escape injection).
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Paths } from "../config/home.js";
import { DAEMON_LOG } from "./daemon-control.js";
import { sanitize } from "./output.js";

export const FOLLOW_POLL_MS = 500;
const CHUNK = 64 * 1024;

const clean = (line: string) => sanitize(line.endsWith("\r") ? line.slice(0, -1) : line);

/** Bytes read back from the end of one log file at most (a pre-existing `.1` may be huge). */
export const TAIL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The last `n` lines of `file`, read backwards in chunks — never the whole file (review C9).
 * A line cut by the byte limit is dropped, not printed half.
 */
export function readLastLines(file: string, n: number, maxBytes = TAIL_MAX_BYTES): string[] {
  return readTail(file, n, maxBytes).lines;
}

/** `readLastLines` + whether everything before the first returned line is read too. */
function readTail(
  file: string,
  n: number,
  maxBytes = TAIL_MAX_BYTES,
): { lines: string[]; reachedStart: boolean } {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], reachedStart: true };
  }
  try {
    const size = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let start = size;
    let newlines = 0;
    while (start > 0 && newlines <= n && size - start < maxBytes) {
      const len = Math.min(CHUNK, start, maxBytes - (size - start));
      start -= len;
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, start);
      const part = buf.subarray(0, got);
      for (const b of part) if (b === 0x0a) newlines++;
      chunks.unshift(part);
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // partial first line
    const full = lines.filter((l) => l !== "");
    return { lines: full.slice(Math.max(0, full.length - n)), reachedStart: start === 0 };
  } catch {
    return { lines: [], reachedStart: false };
  } finally {
    closeSync(fd);
  }
}

/** The last `n` lines over `daemon.log.1` + `daemon.log`, oldest first. */
export function tailLogs(paths: Paths, n: number): string[] {
  const file = join(paths.logs, DAEMON_LOG);
  const current = readTail(file, n);
  // `.1` only when the current file was read to its start: no gap between the two (E6)
  const older =
    current.lines.length < n && current.reachedStart
      ? readLastLines(`${file}.1`, n - current.lines.length)
      : [];
  return [...older, ...current.lines].map(clean);
}

interface Pos {
  ino: bigint;
  offset: number;
}

const stat = (file: string) => {
  try {
    return statSync(file, { bigint: true });
  } catch {
    return undefined;
  }
};

/**
 * Prints lines appended after the call until `signal` aborts. After a rotation the rest of
 * the old file (now `.1`) is printed first; a truncation (smaller size) restarts at 0.
 */
export async function followLogs(
  paths: Paths,
  out: (line: string) => void,
  signal: AbortSignal,
  pollMs = FOLLOW_POLL_MS,
): Promise<void> {
  const file = join(paths.logs, DAEMON_LOG);
  const first = stat(file);
  let pos: Pos | undefined =
    first === undefined ? undefined : { ino: first.ino, offset: Number(first.size) };
  let partial = "";
  // a multi-byte character split between two reads stays whole
  let decoder = new StringDecoder("utf8");

  const emit = (from: string, at: Pos, size: number): void => {
    if (size <= at.offset) return;
    let fd: number;
    try {
      fd = openSync(from, "r");
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(CHUNK);
      while (at.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - at.offset), at.offset);
        if (n <= 0) break;
        at.offset += n;
        partial += decoder.write(buf.subarray(0, n));
        const parts = partial.split("\n");
        partial = parts.pop() ?? "";
        for (const l of parts) if (l !== "") out(clean(l));
      }
    } finally {
      closeSync(fd);
    }
  };

  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
    if (signal.aborted) break;
    try {
      const st = stat(file);
      if (st === undefined) continue;
      if (pos !== undefined && st.ino !== pos.ino) {
        // rotated: finish the old file (now `.1`) before starting on the new one
        const old = stat(`${file}.1`);
        if (old !== undefined && old.ino === pos.ino) emit(`${file}.1`, pos, Number(old.size));
      }
      if (pos === undefined || st.ino !== pos.ino || Number(st.size) < pos.offset) {
        // the old file's last line had no newline: print it, do not drop it (review-2 E6)
        const rest = partial + decoder.end();
        if (rest !== "") out(clean(rest));
        pos = { ino: st.ino, offset: 0 };
        partial = "";
        decoder = new StringDecoder("utf8");
      }
      emit(file, pos, Number(st.size));
    } catch {
      // a read refused for a moment (antivirus / backup holds the file): next poll (review C9)
    }
  }
}
