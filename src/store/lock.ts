import { randomBytes } from "node:crypto";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import type { Paths } from "../config/home.js";
import { WebhubError } from "../errors.js";
import { assertSafePath } from "../fs/safe-path.js";
import { execFile, powershell, systemExe } from "../proc/exec.js";

interface LockInfo {
  pid: number;
  startedAt: string;
  hostname: string;
  token: string;
}

/** Proof that this process is the single writer of `data/` (DESIGN §2). */
export interface Lock {
  readonly file: string;
  readonly home: string;
  readonly held: boolean;
  /** Throws NOT_LOCKED if the lock file on disk is no longer ours. Called before every write. */
  verify(): Promise<void>;
  release(): Promise<void>;
}

const rand = () => randomBytes(6).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 20;

class FileLock implements Lock {
  #held = true;
  constructor(
    readonly file: string,
    readonly home: string,
    private readonly token: string,
  ) {}
  get held(): boolean {
    return this.#held;
  }
  async verify(): Promise<void> {
    const info = parseInfo(await readRaw(this.file));
    if (!this.#held || info?.token !== this.token) {
      this.#held = false;
      throw new WebhubError("NOT_LOCKED", "the data lock was lost (lock file changed)", {
        file: this.file,
      });
    }
  }
  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    await removeIf(this.file, (raw) => parseInfo(raw)?.token === this.token);
  }
}

/**
 * Deletes `file` only if its content passes `isOurs`: rename aside (atomic, one winner),
 * check, and put it back (link, never overwrites) if it belonged to someone else.
 */
async function removeIf(file: string, isOurs: (raw: string | undefined) => boolean): Promise<void> {
  const aside = `${file}.aside-${rand()}`;
  try {
    await rename(file, aside);
  } catch {
    return; // already gone
  }
  if (!isOurs(await readRaw(aside))) await link(aside, file).catch(() => {});
  await rm(aside, { force: true });
}

export type ProcessState =
  | { state: "alive"; startedAt: string }
  | { state: "dead" }
  /** exists but cannot be inspected (access denied, tool failure) — treated as alive */
  | { state: "unknown" };

/** Whether a process exists and when it started (start time defeats PID reuse). */
export async function processState(pid: number): Promise<ProcessState> {
  if (!Number.isInteger(pid) || pid <= 0) return { state: "dead" };
  if (process.platform === "win32") {
    // CIM CreationDate is readable across elevation/users (Get-Process StartTime is not)
    const res = await powershell(
      [
        "try {",
        `  $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop`,
        "  if ($p) { 'ALIVE:' + $p.CreationDate.ToUniversalTime().ToString('o') } else { 'DEAD' }",
        "} catch { 'UNKNOWN' }",
      ].join("\n"),
    );
    const line = res.stdout.split(/\r?\n/).find((l) => /^(ALIVE:|DEAD|UNKNOWN)/.test(l));
    if (res.code !== 0 || line === undefined || line === "UNKNOWN") return { state: "unknown" };
    if (line === "DEAD") return { state: "dead" };
    return { state: "alive", startedAt: line.slice("ALIVE:".length).trim() };
  }
  const res = await execFile(systemExe("ps"), ["-o", "lstart=", "-p", String(pid)]);
  const out = res.stdout.trim();
  if (res.code === 0 && out !== "") return { state: "alive", startedAt: out };
  if (res.code === 1 && out === "") return { state: "dead" };
  return { state: "unknown" };
}

async function readRaw(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, "utf8");
    return text.length > 4096 ? text.slice(0, 4096) : text;
  } catch {
    return undefined;
  }
}

function parseInfo(raw: string | undefined): LockInfo | undefined {
  if (raw === undefined) return undefined;
  try {
    const p: unknown = JSON.parse(raw);
    if (
      typeof p === "object" &&
      p !== null &&
      "pid" in p &&
      typeof p.pid === "number" &&
      "startedAt" in p &&
      typeof p.startedAt === "string" &&
      "hostname" in p &&
      typeof p.hostname === "string" &&
      "token" in p &&
      typeof p.token === "string"
    ) {
      return p as LockInfo;
    }
  } catch {
    // corrupt lock file → stale
  }
  return undefined;
}

async function isStale(info: LockInfo | undefined): Promise<boolean> {
  if (info === undefined) return true; // content is always written whole (link), so this is corrupt
  if (info.hostname !== hostname()) return false; // cannot check another machine: stay locked
  const st = await processState(info.pid);
  if (st.state === "dead") return true;
  if (st.state === "alive") return st.startedAt !== info.startedAt;
  return false; // unknown → assume alive
}

const GUARD_STALE_MS = 30_000;

/**
 * Removes a stale lock. Every takeover runs under `<lock>.takeover` (created with wx = one
 * owner at a time) and re-checks, under the guard, that the lock is still exactly the content
 * judged stale. Nothing else removes another process's lock, so no live lock is ever deleted.
 * Returns false when another process is taking over right now (caller waits and retries).
 */
async function takeOver(file: string, judged: string | undefined): Promise<boolean> {
  const guard = `${file}.takeover`;
  const mine = `${process.pid}:${rand()}`;
  try {
    await writeFile(guard, mine, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // a takeover that crashed leaves the guard behind; it only lives for milliseconds.
    // Break it only if it is still the same old guard (content compared after an atomic move).
    const seen = await readRaw(guard);
    const st = await stat(guard).catch(() => null);
    if (st !== null && Date.now() - st.mtimeMs > GUARD_STALE_MS) {
      await removeIf(guard, (raw) => raw === seen);
    }
    return false;
  }
  try {
    if ((await readRaw(file)) === judged) await rm(file, { force: true });
    return true;
  } finally {
    await removeIf(guard, (raw) => raw === mine);
  }
}

/**
 * Takes `data/.lock` exclusively. The lock file appears atomically with its full content
 * (hard link from a temp file). A lock left by a dead process (or a reused PID) is taken over.
 * Throws LOCKED if another live — or uninspectable — process holds it.
 */
export async function acquireLock(paths: Paths): Promise<Lock> {
  await assertSafePath(paths.home, paths.lock);
  const self = await processState(process.pid);
  if (self.state !== "alive") throw new Error("cannot read own process start time");
  const token = randomBytes(16).toString("hex");
  const info: LockInfo = {
    pid: process.pid,
    startedAt: self.startedAt,
    hostname: hostname(),
    token,
  };
  const content = JSON.stringify(info);
  const tmp = `${paths.lock}.new-${rand()}`;
  await writeFile(tmp, content, { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await createFrom(tmp, paths.lock, content);
        return new FileLock(paths.lock, paths.home, token);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const raw = await readRaw(paths.lock);
      const existing = parseInfo(raw);
      if (attempt < MAX_ATTEMPTS - 1 && (await isStale(existing))) {
        if (!(await takeOver(paths.lock, raw))) await sleep(50 + Math.random() * 100);
        continue;
      }
      throw new WebhubError("LOCKED", "another webhub process is running (data is locked)", {
        file: paths.lock,
        hint:
          existing === undefined
            ? "If no webhub is running, delete the lock file."
            : `Held by PID ${existing.pid} on ${existing.hostname}. Stop it, or delete the lock file if it is not running.`,
      });
    }
    throw new WebhubError("LOCKED", "could not acquire data lock", { file: paths.lock });
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Atomic create-with-content: hard link (fails with EEXIST). Filesystems without links → wx. */
async function createFrom(tmp: string, file: string, content: string): Promise<void> {
  try {
    await link(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || !(code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS")) {
      throw err;
    }
    await writeFile(file, content, { flag: "wx", mode: 0o600 });
  }
}

/** Throws unless `lock` is held and belongs to `home`. */
export function assertLock(lock: Lock | undefined, home: string): asserts lock is Lock {
  if (lock === undefined || !lock.held || lock.home !== home) {
    throw new WebhubError("NOT_LOCKED", "write requires the data lock (daemon only)");
  }
}
