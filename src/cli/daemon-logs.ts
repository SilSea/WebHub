/**
 * `webhub daemon logs [-n N] [-f]` (F-004 §3.6): reads `logs/daemon.log(.1)` straight from
 * disk — no daemon route, so no stream over the API. Every line is sanitised: log lines hold
 * request paths sent by browsers / local programs (terminal escape injection).
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Paths } from "../config/home.js";
import { DAEMON_LOG } from "./daemon-control.js";
import { sanitize } from "./output.js";

export const FOLLOW_POLL_MS = 500;
const CHUNK = 64 * 1024;

const clean = (line: string) => sanitize(line.endsWith("\r") ? line.slice(0, -1) : line);

const readLines = (file: string): string[] => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  } catch {
    return [];
  }
};

/** The last `n` lines over `daemon.log.1` + `daemon.log`, oldest first. */
export function tailLogs(paths: Paths, n: number): string[] {
  const file = join(paths.logs, DAEMON_LOG);
  const all = [...readLines(`${file}.1`), ...readLines(file)];
  return all.slice(Math.max(0, all.length - n)).map(clean);
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
    const st = stat(file);
    if (st === undefined) continue;
    if (pos !== undefined && st.ino !== pos.ino) {
      // rotated: finish the old file (now `.1`) before starting on the new one
      const old = stat(`${file}.1`);
      if (old !== undefined && old.ino === pos.ino) emit(`${file}.1`, pos, Number(old.size));
    }
    if (pos === undefined || st.ino !== pos.ino || Number(st.size) < pos.offset) {
      pos = { ino: st.ino, offset: 0 };
      partial = "";
      decoder = new StringDecoder("utf8");
    }
    emit(file, pos, Number(st.size));
  }
}
