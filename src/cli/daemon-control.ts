/**
 * Starting, stopping and querying the daemon from the CLI (F-004 §3.3–§3.7).
 *
 * - The daemon is spawned detached with no pipe to the CLI (F-003 security-8 Y2): stdout is
 *   ignored, its log goes to `logs/daemon.log` through `--log-file` (CR-003), stderr to a file.
 * - No secret is passed to the daemon (it makes its own token); `NODE_OPTIONS` and the CLI's
 *   `execArgv` are not passed on, so `--inspect` / `--require` never reach the process that
 *   holds the token.
 * - "Ready" = auth.json names the PID we spawned and the daemon proves it holds the token
 *   (F-003 H16, handshake).
 * - A PID is only ever killed together with the start time we read for it (PID reuse).
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, type Paths } from "../config/home.js";
import { assertSafePath } from "../fs/safe-path.js";
import { getPlatform, type Platform } from "../platform/index.js";
import { connectDaemon, type DaemonClient } from "../server/client.js";
import { isServerError, ServerError } from "../server/errors.js";
import { CliError, EXIT, sanitize } from "./output.js";

export const START_TIMEOUT_MS = 20_000;
export const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 100;
const START_ERR_MAX = 4_096;
const STALE_START_ERR_MS = 60 * 60 * 1000;

export const DAEMON_LOG = "daemon.log";
export const DAEMON_ERR = "daemon.err";

export interface DaemonStatus {
  version: string;
  pid: number;
  startedAt: string;
  home: string;
  port: number;
}

export interface ControlOptions {
  env?: NodeJS.ProcessEnv;
  platform?: Platform;
  /** Path of `daemon.js` (default: next to this module in dist/). */
  daemonJs?: string;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function defaultDaemonJs(): string {
  return fileURLToPath(new URL("../daemon.js", import.meta.url));
}

/** Status of the running daemon, proven (handshake) — undefined when it is not running. */
export async function daemonStatus(paths: Paths): Promise<DaemonStatus | undefined> {
  let client: DaemonClient;
  try {
    client = await connectDaemon(paths);
    const s = await client.request<Omit<DaemonStatus, "port">>("GET", "/api/v1/status");
    return { ...s, port: client.port };
  } catch (err) {
    if (isServerError(err, "DAEMON_NOT_RUNNING")) return undefined;
    throw err;
  }
}

/** The env the daemon gets: the user's, without `NODE_OPTIONS` (any case — Windows). */
export function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === "NODE_OPTIONS") continue;
    out[k] = v;
  }
  return out;
}

/** Options of the spawn (exported for tests — F-004 §6: no pipe, no token, cwd = home). */
export function spawnPlan(
  paths: Paths,
  env: NodeJS.ProcessEnv,
  daemonJs: string,
  errFd: number,
): { command: string; args: string[]; options: Parameters<typeof spawn>[2] } {
  return {
    command: process.execPath,
    args: [daemonJs, "--log-file", join(paths.logs, DAEMON_LOG)],
    options: {
      detached: true,
      windowsHide: true,
      cwd: paths.home,
      env: daemonEnv(env),
      stdio: ["ignore", "ignore", errFd],
    },
  };
}

/** Removes `daemon-start-*.err` files of earlier runs that crashed before cleaning up. */
function cleanStartErrors(paths: Paths): void {
  try {
    for (const name of readdirSync(paths.logs)) {
      if (!/^daemon-start-[0-9a-f]+\.err$/.test(name)) continue;
      const f = join(paths.logs, name);
      if (Date.now() - statSync(f).mtimeMs > STALE_START_ERR_MS) rmSync(f, { force: true });
    }
  } catch {
    // best effort
  }
}

function readStartError(file: string): string[] {
  try {
    const buf = readFileSync(file);
    const text = buf.subarray(Math.max(0, buf.length - START_ERR_MAX)).toString("utf8");
    return text
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((l) => sanitize(l.replace(/^webhub daemon: /, "")));
  } catch {
    return [];
  }
}

const childExitCode = (code: number | null) =>
  code === 2 ? EXIT.usage : code === 4 ? EXIT.portBusy : EXIT.error;

/**
 * Starts the daemon unless it already runs. Resolves once it is ready (auth.json names our
 * PID and the daemon proved itself). Idempotent: a concurrent start that lost the lock
 * reports the winner.
 */
export async function startDaemonProcess(
  paths: Paths,
  opts: ControlOptions = {},
): Promise<{ pid: number; port: number; alreadyRunning: boolean }> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? getPlatform();
  const timeoutMs = opts.timeoutMs ?? START_TIMEOUT_MS;
  await ensureHome(paths);
  const running = await daemonStatus(paths);
  if (running !== undefined) return { pid: running.pid, port: running.port, alreadyRunning: true };

  cleanStartErrors(paths);
  const errFile = join(
    paths.logs,
    `daemon-start-${process.pid.toString(16)}${Date.now().toString(16)}.err`,
  );
  await assertSafePath(paths.home, errFile);
  // "wx": a fresh file — never follows / truncates something planted under that name
  const errFd = openSync(errFile, "wx", 0o600);
  let child: ChildProcess;
  try {
    const plan = spawnPlan(paths, env, opts.daemonJs ?? defaultDaemonJs(), errFd);
    child = spawn(plan.command, plan.args, plan.options);
  } finally {
    closeSync(errFd); // the child has its own handle
  }
  let exited: { code: number | null } | undefined;
  let spawnError: Error | undefined;
  child.once("exit", (code) => {
    exited = { code };
  });
  child.once("error", (err) => {
    spawnError = err;
  });
  child.unref();
  const pid = child.pid;
  const startedAt =
    pid === undefined
      ? undefined
      : await platform.process
          .info(pid)
          .then((i) => i?.startedAt)
          .catch(() => undefined);

  const deadline = Date.now() + timeoutMs;
  let kept = false;
  try {
    while (Date.now() < deadline) {
      if (spawnError !== undefined || pid === undefined) {
        throw new CliError(EXIT.error, "SPAWN_FAILED", "could not start the daemon process", {
          details: [spawnError?.name ?? "no PID"],
        });
      }
      if (exited !== undefined) {
        if (exited.code === 3) {
          // another `start` won the lock: report that daemon (it may still be starting)
          const other = await waitForAny(paths, deadline);
          if (other !== undefined) return { ...other, alreadyRunning: true };
          break;
        }
        const lines = readStartError(errFile);
        throw new CliError(
          childExitCode(exited.code),
          "DAEMON_START_FAILED",
          lines[0] ?? `the daemon exited with code ${exited.code}`,
          { details: lines.slice(1) },
        );
      }
      const s = await daemonStatus(paths).catch(() => undefined);
      if (s !== undefined && s.pid === pid) {
        kept = keepStartError(paths, errFile);
        return { pid, port: s.port, alreadyRunning: false };
      }
      await sleep(POLL_MS);
    }
    // not ready in time: do not leave a half-started daemon behind
    if (pid !== undefined && startedAt !== undefined && exited === undefined) {
      await platform.process.killTree(pid, startedAt).catch(() => {});
    }
    throw new CliError(
      EXIT.error,
      "DAEMON_START_TIMEOUT",
      `the daemon did not become ready in ${Math.round(timeoutMs / 1000)} s`,
      { hint: "See `webhub daemon logs`." },
    );
  } finally {
    if (!kept) rmSync(errFile, { force: true });
  }
}

/** After a successful start the stderr file becomes `daemon.err` (crash lines of this run). */
function keepStartError(paths: Paths, errFile: string): boolean {
  try {
    renameSync(errFile, join(paths.logs, DAEMON_ERR));
    return true;
  } catch {
    return false; // best effort: the daemon keeps its handle either way
  }
}

async function waitForAny(
  paths: Paths,
  deadline: number,
): Promise<{ pid: number; port: number } | undefined> {
  while (Date.now() < deadline) {
    const s = await daemonStatus(paths).catch(() => undefined);
    if (s !== undefined) return { pid: s.pid, port: s.port };
    await sleep(POLL_MS);
  }
  return undefined;
}

interface LockFile {
  pid: number;
  startedAt: string;
}

function readLockFile(paths: Paths): LockFile | undefined {
  try {
    const v = JSON.parse(readFileSync(paths.lock, "utf8")) as Partial<LockFile>;
    if (typeof v.pid === "number" && typeof v.startedAt === "string") {
      return { pid: v.pid, startedAt: v.startedAt };
    }
  } catch {
    // missing / unreadable
  }
  return undefined;
}

function readAuthPid(paths: Paths): number | undefined {
  try {
    const v = JSON.parse(readFileSync(paths.auth, "utf8")) as { pid?: unknown };
    return typeof v.pid === "number" ? v.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Who listens on `port` (for an impostor message). */
export async function portOwners(platform: Platform, port: number): Promise<string[]> {
  try {
    const owners = (await platform.ports.listening({ fresh: true })).filter((o) => o.port === port);
    const out: string[] = [];
    for (const o of owners) {
      const info = await platform.process.info(o.pid).catch(() => undefined);
      out.push(`PID ${o.pid}${info?.name ? ` (${sanitize(info.name)})` : ""} on ${o.address}`);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Stops the daemon: shutdown request, then waits until the process is gone and auth.json is
 * removed. `force` kills it when it does not stop (or does not answer) — only the PID named
 * by both auth.json and the lock file, and only if it still has the lock's start time.
 */
export async function stopDaemon(
  paths: Paths,
  opts: ControlOptions & { force?: boolean } = {},
): Promise<{ wasRunning: boolean; forced: boolean }> {
  const platform = opts.platform ?? getPlatform();
  const timeoutMs = opts.timeoutMs ?? STOP_TIMEOUT_MS;
  let status: DaemonStatus | undefined;
  let unreachable: unknown;
  try {
    status = await daemonStatus(paths);
  } catch (err) {
    if (!isServerError(err, "DAEMON_UNREACHABLE") && !isServerError(err, "DAEMON_IMPOSTOR")) {
      throw err;
    }
    // no proof: either a daemon that hangs / is already stopping (it answers 503 then), or
    // another program on the port. Only the first is ours: auth.json and the lock file name
    // the same PID, and that PID still has the lock's start time.
    if (!(await ownDaemonAlive(platform, paths))) throw err;
    unreachable = err; // our daemon does not answer: only --force can help
  }
  if (status === undefined && unreachable === undefined)
    return { wasRunning: false, forced: false };

  const lock = readLockFile(paths);
  const pid = status?.pid ?? readAuthPid(paths);
  if (status !== undefined) {
    const client = await connectDaemon(paths);
    await client.request("POST", "/api/v1/shutdown").catch((err: unknown) => {
      // the daemon may close the connection while answering: it stops anyway (F-003 H10)
      if (!isServerError(err, "DAEMON_UNREACHABLE") && !isServerError(err, "DAEMON_NOT_RUNNING")) {
        throw err;
      }
    });
  }
  // also when it does not answer: it may be stopping already (503) and leave by itself
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(paths.auth) && !(await alive(platform, pid, lock))) {
      return { wasRunning: true, forced: false };
    }
    await sleep(POLL_MS);
  }
  if (opts.force !== true) {
    throw new CliError(EXIT.error, "DAEMON_STOP_TIMEOUT", "the daemon did not stop", {
      ...(unreachable === undefined ? {} : { details: ["it does not answer"] }),
      hint: "Run `webhub daemon stop --force` to end the process.",
    });
  }
  if (pid === undefined || lock === undefined || lock.pid !== pid) {
    throw new CliError(
      EXIT.error,
      "DAEMON_FORCE_REFUSED",
      "cannot tell which process is the daemon (auth.json and the lock file disagree); nothing was killed",
    );
  }
  try {
    await platform.process.killTree(pid, lock.startedAt);
  } catch (err) {
    throw new CliError(
      EXIT.error,
      "DAEMON_FORCE_REFUSED",
      `PID ${pid} is not the daemon that holds the lock; nothing was killed`,
      { details: [err instanceof Error ? err.name : "error"] },
    );
  }
  rmSync(paths.auth, { force: true });
  return { wasRunning: true, forced: true };
}

async function ownDaemonAlive(platform: Platform, paths: Paths): Promise<boolean> {
  const lock = readLockFile(paths);
  const pid = readAuthPid(paths);
  if (lock === undefined || pid === undefined || lock.pid !== pid) return false;
  const info = await platform.process.info(pid).catch(() => undefined);
  return info?.startedAt !== undefined && info.startedAt === lock.startedAt;
}

async function alive(
  platform: Platform,
  pid: number | undefined,
  lock: LockFile | undefined,
): Promise<boolean> {
  if (pid === undefined) return false;
  const info = await platform.process.info(pid).catch(() => undefined);
  if (info === undefined) return false;
  // a reused PID is another program: the daemon is gone
  if (lock !== undefined && lock.pid === pid && info.startedAt !== undefined) {
    return info.startedAt === lock.startedAt;
  }
  return true;
}

/**
 * For commands that need the daemon (F-004 Q3): start it when it is not running, unless
 * `noStart` (`--no-start` / `WEBHUB_NO_AUTOSTART=1`) → exit 3.
 */
export async function ensureDaemon(
  paths: Paths,
  opts: ControlOptions & { noStart?: boolean; onStart?: () => void } = {},
): Promise<DaemonClient> {
  const status = await daemonStatus(paths);
  if (status === undefined) {
    if (opts.noStart === true) {
      throw new CliError(
        EXIT.notRunning,
        "DAEMON_NOT_RUNNING",
        "the webhub daemon is not running",
        {
          hint: "Run `webhub daemon start`.",
        },
      );
    }
    opts.onStart?.();
    await startDaemonProcess(paths, opts);
  }
  return connectDaemon(paths);
}

export { ServerError };
