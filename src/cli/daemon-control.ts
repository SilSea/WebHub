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
import { getPlatform, isPlatformError, type Platform } from "../platform/index.js";
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
    const s = await client.request<Record<string, unknown>>("GET", "/api/v1/status");
    // shape checked even from the proven daemon (security-1 D4): strings printed as-is in JSON
    const str = (v: unknown) => (typeof v === "string" ? sanitize(v) : "");
    if (typeof s.pid !== "number" || !Number.isSafeInteger(s.pid) || s.pid <= 0) {
      throw new CliError(EXIT.error, "DAEMON_BAD_STATUS", "the daemon sent an invalid status");
    }
    return {
      version: str(s.version),
      pid: s.pid,
      startedAt: str(s.startedAt),
      home: str(s.home),
      port: client.port,
    };
  } catch (err) {
    if (isServerError(err, "DAEMON_NOT_RUNNING")) return undefined;
    throw err;
  }
}

/**
 * Variables node / libuv / OpenSSL read at startup (same list as F-002's trust check). The
 * daemon holds the token and runs for days: `NODE_DEBUG` would write a line per connection to
 * its stderr (unbounded `daemon.err` — security-1 D1), `OPENSSL_CONF` can load a DLL,
 * `NODE_PATH` changes module lookup. `NODE_ENV` is kept.
 */
const DAEMON_ENV_DROP = /^(NODE_|OPENSSL_|SSL_CERT_|UV_|ICU_)/i;
const DAEMON_ENV_KEEP = new Set(["NODE_ENV"]);
// Windows may map a non-ASCII name to one of the above (best-fit) — such names are dropped
const NON_ASCII_NAME = /[^ -~]/;

/** The env the daemon gets: the user's, without the start-up knobs above (any case). */
export function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (NON_ASCII_NAME.test(k)) continue;
    if (DAEMON_ENV_DROP.test(k) && !DAEMON_ENV_KEEP.has(k.toUpperCase())) continue;
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

interface StartError {
  message: string | undefined;
  details: string[];
  hint: string | undefined;
}

/**
 * The daemon's start error, in the shape its `describe()` prints (`webhub daemon: msg`,
 * `  - detail`, `  hint: …`) — turned back into message / details / hint (review C3).
 */
export function parseStartError(text: string): StartError {
  const out: StartError = { message: undefined, details: [], hint: undefined };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const detail = /^\s*-\s(.*)$/.exec(raw);
    const hint = /^\s*hint:\s?(.*)$/.exec(raw);
    if (detail !== null) out.details.push(sanitize(detail[1] ?? ""));
    else if (hint !== null) out.hint = sanitize(hint[1] ?? "");
    else if (out.message === undefined) out.message = sanitize(raw.replace(/^webhub daemon: /, ""));
    else out.details.push(sanitize(raw.replace(/^webhub daemon: /, "")));
  }
  return out;
}

function readStartError(file: string): StartError {
  try {
    const buf = readFileSync(file);
    return parseStartError(buf.subarray(Math.max(0, buf.length - START_ERR_MAX)).toString("utf8"));
  } catch {
    return { message: undefined, details: [], hint: undefined };
  }
}

const startErrorOpts = (
  e: StartError,
  fallbackHint: string,
): { details: string[]; hint: string } => ({
  details: e.message === undefined ? e.details : [e.message, ...e.details],
  hint: e.hint ?? fallbackHint,
});

/** Temp stderr file of a start in progress — renamed by `abandonStart` on Ctrl+C (C11). */
let pendingStartError: { file: string; logs: string } | undefined;

/**
 * Ctrl+C during `start`: the daemon keeps starting (it is detached); keep its stderr as
 * `daemon.err` instead of leaving a temp file that a later start would delete. Sync, best effort.
 */
export function abandonStart(): void {
  const p = pendingStartError;
  if (p === undefined) return;
  pendingStartError = undefined;
  try {
    renameSync(p.file, join(p.logs, DAEMON_ERR));
  } catch {
    // best effort
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
  pendingStartError = { file: errFile, logs: paths.logs };
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
  const startTime = async () =>
    pid === undefined
      ? undefined
      : await platform.process
          .info(pid)
          .then((i) => i?.startedAt)
          .catch(() => undefined);
  let startedAt = await startTime();

  const deadline = Date.now() + timeoutMs;
  let ready = false;
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
          throw new CliError(
            EXIT.error,
            "DAEMON_START_TIMEOUT",
            "another webhub daemon holds the lock but does not answer",
            startErrorOpts(readStartError(errFile), "Run `webhub daemon stop --force`."),
          );
        }
        const e = readStartError(errFile);
        throw new CliError(
          childExitCode(exited.code),
          "DAEMON_START_FAILED",
          e.message ?? `the daemon exited with code ${exited.code}`,
          { details: e.details, ...(e.hint === undefined ? {} : { hint: e.hint }) },
        );
      }
      const s = await daemonStatus(paths).catch(transientAsUndefined);
      if (s !== undefined && s.pid === pid) {
        ready = true;
        return { pid, port: s.port, alreadyRunning: false };
      }
      await sleep(POLL_MS);
    }
    throw new CliError(
      EXIT.error,
      "DAEMON_START_TIMEOUT",
      `the daemon did not become ready in ${Math.round(timeoutMs / 1000)} s`,
      startErrorOpts(readStartError(errFile), "See `webhub daemon logs`."),
    );
  } finally {
    pendingStartError = undefined;
    if (ready) {
      keepStartError(paths, errFile);
    } else {
      // never leave a half-started daemon behind (timeout, or an error while polling)
      if (pid !== undefined && exited === undefined) {
        startedAt ??= await startTime();
        if (startedAt !== undefined) {
          await platform.process.killTree(pid, startedAt).catch(() => {});
        } else {
          // start time unknown: kill through our own handle (cannot hit a reused PID)
          child.kill();
        }
      }
      rmSync(errFile, { force: true });
    }
  }
}

/** Errors that only mean "not ready yet" while a start is in progress (review C8). */
function transientAsUndefined(err: unknown): undefined {
  if (
    isServerError(err, "DAEMON_NOT_RUNNING") ||
    isServerError(err, "DAEMON_IMPOSTOR") ||
    isServerError(err, "DAEMON_UNREACHABLE")
  ) {
    return undefined;
  }
  throw err;
}

/** After a successful start the stderr file becomes `daemon.err` (crash lines of this run). */
function keepStartError(paths: Paths, errFile: string): void {
  try {
    renameSync(errFile, join(paths.logs, DAEMON_ERR));
  } catch {
    rmSync(errFile, { force: true }); // best effort: the daemon keeps its handle either way
  }
}

async function waitForAny(
  paths: Paths,
  deadline: number,
): Promise<{ pid: number; port: number } | undefined> {
  while (Date.now() < deadline) {
    const s = await daemonStatus(paths).catch(transientAsUndefined);
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

type ProcState = "alive" | "dead" | "unknown";

/**
 * Is `pid` still the daemon? "dead" also when the PID now belongs to another program (start
 * time differs from the lock file's). "unknown" when the process table cannot be read — never
 * taken as "dead" (review C7).
 */
async function procState(
  platform: Platform,
  pid: number,
  lock: LockFile | undefined,
): Promise<{ state: ProcState; startedAt?: string | undefined }> {
  let info: Awaited<ReturnType<Platform["process"]["info"]>>;
  try {
    info = await platform.process.info(pid);
  } catch {
    return { state: "unknown" };
  }
  if (info === undefined) return { state: "dead" };
  if (lock?.pid === pid && info.startedAt !== undefined && info.startedAt !== lock.startedAt) {
    return { state: "dead" };
  }
  return { state: "alive", startedAt: info.startedAt };
}

/**
 * After a request without proof (no answer, or a 503 / foreign answer): whose process is it?
 * - "ours": auth.json and the lock file name the same PID, alive with the lock's start time —
 *   our daemon, hung or already stopping (it answers 503 while closing)
 * - "gone": no auth.json, or its PID is dead / reused
 * - "unknown": the process table could not be read
 * - "foreign": anything else (lock and auth.json disagree)
 */
async function ownerOfAuth(
  platform: Platform,
  paths: Paths,
): Promise<{ owner: "ours" | "gone" | "unknown" | "foreign"; pid?: number; lock?: LockFile }> {
  const pid = readAuthPid(paths);
  if (!existsSync(paths.auth) || pid === undefined) return { owner: "gone" };
  const lock = readLockFile(paths);
  const p = await procState(platform, pid, lock);
  if (p.state === "dead") return { owner: "gone", pid };
  if (p.state === "unknown") return { owner: "unknown", pid };
  if (lock !== undefined && lock.pid === pid && p.startedAt === lock.startedAt) {
    return { owner: "ours", pid, lock };
  }
  return { owner: "foreign", pid };
}

const noProof = (err: unknown) =>
  isServerError(err, "DAEMON_UNREACHABLE") || isServerError(err, "DAEMON_IMPOSTOR");

/** Removes auth.json only while it still names `pid` (never a newer daemon's — review C6). */
function removeAuthOf(paths: Paths, pid: number): void {
  if (readAuthPid(paths) === pid) rmSync(paths.auth, { force: true });
}

/**
 * Stops the daemon: shutdown request, then waits until the process is gone. Idempotent: a
 * daemon that is already stopping (another `stop`) is waited for, not reported as an error
 * (review C1). `force` kills it when it does not stop (or does not answer) — only the PID
 * named by both auth.json and the lock file, and only if it still has the lock's start time.
 * Nothing is ever sent to (or killed because of) a program that did not prove itself.
 */
export async function stopDaemon(
  paths: Paths,
  opts: ControlOptions & { force?: boolean } = {},
): Promise<{ wasRunning: boolean; forced: boolean }> {
  const platform = opts.platform ?? getPlatform();
  const timeoutMs = opts.timeoutMs ?? STOP_TIMEOUT_MS;
  let status: DaemonStatus | undefined;
  let silent = false;
  let pid: number | undefined;
  try {
    status = await daemonStatus(paths);
    pid = status?.pid;
  } catch (err) {
    if (!noProof(err)) throw err;
    const o = await ownerOfAuth(platform, paths);
    if (o.owner === "gone") {
      // our daemon has left (e.g. a concurrent stop): unless a program still squats the port
      const again = await daemonStatus(paths).catch((e: unknown) => {
        if (isServerError(e, "DAEMON_UNREACHABLE")) return undefined;
        throw e;
      });
      if (again === undefined) {
        if (o.pid !== undefined) removeAuthOf(paths, o.pid);
        return { wasRunning: true, forced: false };
      }
      status = again; // a new daemon started meanwhile: stop that one
      pid = again.pid;
    } else if (o.owner !== "ours") {
      throw err;
    } else {
      silent = true; // hung or stopping: wait, then only --force can help
      pid = o.pid;
    }
  }
  if (status === undefined && !silent) return { wasRunning: false, forced: false };
  if (pid === undefined) return { wasRunning: false, forced: false };
  const lock = readLockFile(paths);

  if (status !== undefined) {
    try {
      const client = await connectDaemon(paths);
      await client.request("POST", "/api/v1/shutdown");
    } catch (err) {
      // closed the connection while answering (F-003 H10), already gone, or already
      // stopping (503 → no proof, token not sent): wait for it either way
      if (!noProof(err) && !isServerError(err, "DAEMON_NOT_RUNNING")) throw err;
    }
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await procState(platform, pid, lock);
    if (p.state === "dead") {
      removeAuthOf(paths, pid); // a hard-killed daemon leaves its auth.json (review C7)
      return { wasRunning: true, forced: false };
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  if (opts.force !== true) {
    throw new CliError(EXIT.error, "DAEMON_STOP_TIMEOUT", "the daemon did not stop", {
      ...(silent ? { details: ["it does not answer"] } : {}),
      hint: "Run `webhub daemon stop --force` to end the process.",
    });
  }
  if (lock === undefined || lock.pid !== pid) {
    throw new CliError(
      EXIT.error,
      "DAEMON_FORCE_REFUSED",
      "cannot tell which process is the daemon (auth.json and the lock file disagree); nothing was killed",
    );
  }
  try {
    await platform.process.killTree(pid, lock.startedAt);
  } catch (err) {
    if (isPlatformError(err, "PROCESS_MISMATCH")) {
      throw new CliError(
        EXIT.error,
        "DAEMON_FORCE_REFUSED",
        `PID ${pid} is not the daemon that holds the lock; nothing was killed`,
      );
    }
    throw new CliError(EXIT.error, "DAEMON_KILL_FAILED", `could not end PID ${pid}`, {
      details: isPlatformError(err) ? [...err.details] : [],
      hint: "End it in Task Manager, or run the command as the user that started it.",
    });
  }
  removeAuthOf(paths, pid);
  return { wasRunning: true, forced: true };
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
