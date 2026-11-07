import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
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
  release(): Promise<void>;
}

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
  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    const info = await readInfo(this.file);
    if (info?.token === this.token) await rm(this.file, { force: true });
  }
}

/** Start time of a process, or undefined if it does not exist. Used to defeat PID reuse. */
export async function processStartTime(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "win32") {
    const res = await powershell(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
    );
    const out = res.stdout.trim();
    return out === "" ? undefined : out;
  }
  const res = await execFile(systemExe("ps"), ["-o", "lstart=", "-p", String(pid)]);
  const out = res.stdout.trim();
  return res.code === 0 && out !== "" ? out : undefined;
}

async function readInfo(file: string): Promise<LockInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      "startedAt" in parsed &&
      "hostname" in parsed &&
      "token" in parsed
    ) {
      return parsed as LockInfo;
    }
  } catch {
    // unreadable / partial lock file → treated as stale below
  }
  return undefined;
}

async function isStale(info: LockInfo | undefined): Promise<boolean> {
  if (info === undefined) return true;
  if (info.hostname !== hostname()) return false; // cannot check another machine: stay locked
  const started = await processStartTime(info.pid);
  return started === undefined || started !== info.startedAt;
}

/**
 * Takes `data/.lock` exclusively. A lock left by a dead process (or a reused PID) is taken over.
 * Throws LOCKED if another live process holds it.
 */
export async function acquireLock(paths: Paths): Promise<Lock> {
  await assertSafePath(paths.home, paths.lock);
  const startedAt = await processStartTime(process.pid);
  if (startedAt === undefined) throw new Error("cannot read own process start time");
  const token = randomBytes(16).toString("hex");
  const info: LockInfo = { pid: process.pid, startedAt, hostname: hostname(), token };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(paths.lock, JSON.stringify(info), { flag: "wx", mode: 0o600 });
      return new FileLock(paths.lock, paths.home, token);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = await readInfo(paths.lock);
      if (attempt === 0 && (await isStale(existing))) {
        await rm(paths.lock, { force: true });
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
  }
  throw new WebhubError("LOCKED", "could not acquire data lock", { file: paths.lock });
}

/** Throws unless `lock` is held and belongs to `home`. */
export function assertLock(lock: Lock | undefined, home: string): asserts lock is Lock {
  if (lock === undefined || !lock.held || lock.home !== home) {
    throw new WebhubError("NOT_LOCKED", "write requires the data lock (daemon only)");
  }
}
