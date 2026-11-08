#!/usr/bin/env node
/**
 * webhub daemon (F-003 §3.1): the single writer of `$WEBHUB_HOME/data` and the API server on
 * 127.0.0.1:7400. Foreground process; `webhub daemon start` (F-004) runs it detached.
 *
 * Exit codes: 0 stopped normally, 1 other error, 2 config invalid, 3 another daemon runs,
 * 4 API port busy.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config/config.js";
import { ensureHome, type Paths, pathsFor, resolveHome } from "./config/home.js";
import { WebhubError } from "./errors.js";
import { getPlatform } from "./platform/index.js";
import { createApi, type RouteRegistrar } from "./server/api.js";
import { SessionStore } from "./server/auth.js";
import { AUTH_FILE_VERSION, type AuthFile } from "./server/auth-file.js";
import { ServerError } from "./server/errors.js";
import { writeDoc } from "./store/json-store.js";
import { acquireLock, type Lock } from "./store/lock.js";
import { readVersion } from "./version.js";

/** Fixed in F-003 (Q3); configurable later with the Port Manager (F-014 + CR). */
export const API_PORT = 7400;
const STOP_GRACE_MS = 5_000;

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** Test/dev only: API port (default 7400, or WEBHUB_API_PORT). */
  port?: number;
  /** nginx http port for the Host allowlist (default 80; set by setup/Port Manager later). */
  httpPort?: number;
  log?: (entry: Record<string, unknown>) => void;
  registrars?: readonly RouteRegistrar[];
  /** Aborted (e.g. by a signal) → the daemon stops as soon as it is ready. */
  signal?: AbortSignal;
  /**
   * Called right after auth.json is written, with a synchronous remover (only removes it while
   * it holds our token): lets `main()` clean up even when start-up crashes later (J6).
   */
  onAuthFile?: (removeSync: () => void) => void;
}

export interface RunningDaemon {
  readonly paths: Paths;
  readonly port: number;
  readonly app: FastifyInstance;
  /**
   * Idempotent stop: close server, remove auth.json (if ours), release lock. Also triggered by
   * POST /api/v1/shutdown and by `signal`. Never rejects (J2): a failing close is logged and
   * reported through `stopped`.
   */
  stop(): Promise<void>;
  /** Resolves once the daemon has stopped (any trigger); `clean` = the server closed without error. */
  readonly stopped: Promise<{ clean: boolean }>;
  /** Synchronous last-resort removal of our auth.json (process `exit` hook). */
  removeAuthFileSync(): void;
}

const jsonLog = (entry: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);

function portFrom(env: NodeJS.ProcessEnv, explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = env.WEBHUB_API_PORT;
  if (raw === undefined || raw === "") return API_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new WebhubError("CONFIG_INVALID", `WEBHUB_API_PORT is not a port: ${raw}`);
  }
  return n;
}

async function portOwner(port: number): Promise<string[]> {
  try {
    const owners = (await getPlatform().ports.listening({ fresh: true })).filter(
      (o) => o.port === port,
    );
    const out: string[] = [];
    for (const o of owners) {
      const info = await getPlatform()
        .process.info(o.pid)
        .catch(() => undefined);
      out.push(
        `PID ${o.pid}${info?.name ? ` (${info.name})` : ""} listens on ${o.address}:${port}`,
      );
    }
    return out;
  } catch {
    return [];
  }
}

/** Removes auth.json only if it still holds our token (never another daemon's file). */
async function removeAuthFile(file: string, token: string): Promise<void> {
  try {
    const doc = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
    if (doc.token === token) await rm(file, { force: true });
  } catch {
    // missing / unreadable: nothing of ours to remove
  }
}

function removeAuthFileSync(file: string, token: string): void {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { token?: unknown };
    if (doc.token === token) rmSync(file, { force: true });
  } catch {
    // nothing of ours
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? jsonLog;
  const port = portFrom(env, opts.port);
  const paths = pathsFor(resolveHome(env, process.platform, homedir()));
  await ensureHome(paths);
  let lock: Lock;
  try {
    lock = await acquireLock(paths);
  } catch (err) {
    if (err instanceof WebhubError && err.code === "LOCKED") {
      throw new ServerError("DAEMON_RUNNING", "another webhub daemon is already running", {
        ...(err.hint === undefined ? {} : { hint: err.hint }),
        cause: err,
      });
    }
    throw err;
  }
  let app: FastifyInstance | undefined;
  const token = randomBytes(32).toString("base64url");
  // a shutdown request may arrive between listen and the return below → queued (H5)
  let stopFn: (() => Promise<void>) | undefined;
  let stopQueued = false;
  const requestStop = () => {
    if (stopFn === undefined) stopQueued = true;
    else void stopFn();
  };
  let resolveStopped: (r: { clean: boolean }) => void = () => {};
  const stopped = new Promise<{ clean: boolean }>((r) => {
    resolveStopped = r;
  });
  try {
    const { config } = await loadConfig(paths, lock);
    const startedAt = new Date().toISOString();
    const sessions = new SessionStore();
    let stopping: Promise<void> | undefined;
    app = await createApi(
      {
        token,
        hosts: { apiPort: port, httpPort: opts.httpPort ?? 80, domainSuffix: config.domainSuffix },
        sessions,
        status: () => ({
          version: readVersion(),
          pid: process.pid,
          startedAt,
          home: paths.home,
          mode: config.mode,
        }),
        onShutdown: requestStop,
        log,
      },
      opts.registrars ?? [],
    );
    // auth.json BEFORE listen: an old file of a crashed daemon is never next to a live
    // port (client would report an impostor — H16); a failed listen removes it again
    const doc: AuthFile = {
      schemaVersion: AUTH_FILE_VERSION,
      token,
      pid: process.pid,
      port,
      startedAt,
    };
    await writeDoc(lock, paths.auth, doc, { keepBackup: false });
    opts.onAuthFile?.(() => removeAuthFileSync(paths.auth, token));
    try {
      await app.listen({ host: "127.0.0.1", port });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") {
        throw new ServerError(
          "DAEMON_PORT_BUSY",
          code === "EADDRINUSE"
            ? `port ${port} (webhub API) is already in use`
            : `port ${port} (webhub API) cannot be used (access denied)`,
          {
            details: await portOwner(port),
            hint:
              code === "EADDRINUSE"
                ? "Stop the program that uses this port, then start webhub again."
                : "Windows may reserve this port (Hyper-V / WinNAT excluded range: `netsh int ipv4 show excludedportrange protocol=tcp`).",
          },
        );
      }
      throw err;
    }
    const running = app;
    stopFn = () => {
      stopping ??= (async () => {
        const timer = setTimeout(() => running.server.closeAllConnections(), STOP_GRACE_MS);
        let clean = true;
        try {
          await running.close();
        } catch (err) {
          // e.g. an onClose hook of a later feature throws: still clean up, never reject (J2)
          clean = false;
          log({ level: "error", msg: "stop failed", error: (err as Error).name ?? "Error" });
        } finally {
          clearTimeout(timer);
          await removeAuthFile(paths.auth, token).catch(() => {});
          await lock.release().catch(() => {});
          log({ msg: "stopped" });
          resolveStopped({ clean });
        }
      })();
      return stopping;
    };
    log({ msg: "ready", port, home: paths.home });
    if (stopQueued || opts.signal?.aborted === true) void stopFn();
    else opts.signal?.addEventListener("abort", () => void stopFn?.(), { once: true });
    return {
      paths,
      port,
      app: running,
      stop: stopFn,
      stopped,
      removeAuthFileSync: () => removeAuthFileSync(paths.auth, token),
    };
  } catch (err) {
    // cleanup must never hide the original error (exit code — H14)
    await app?.close().catch(() => {});
    await removeAuthFile(paths.auth, token).catch(() => {});
    await lock.release().catch(() => {});
    throw err;
  }
}

/** Exit code for a start-up error (see header). */
export function exitCodeFor(err: unknown): number {
  if (err instanceof ServerError) {
    if (err.code === "DAEMON_RUNNING") return 3;
    if (err.code === "DAEMON_PORT_BUSY") return 4;
  }
  if (
    err instanceof WebhubError &&
    (err.code === "CONFIG_INVALID" ||
      err.code === "CONFIG_FROM_NEWER_VERSION" ||
      err.code === "JSON_PARSE")
  ) {
    return 2;
  }
  return 1;
}

function describe(err: unknown): string[] {
  if (err instanceof ServerError || err instanceof WebhubError) {
    // with details, the message's first line is enough (CONFIG_INVALID repeats them — H11)
    const message = err.details.length > 0 ? (err.message.split("\n")[0] ?? "") : err.message;
    return [
      `webhub daemon: ${message}`,
      ...err.details.map((d) => `  - ${d}`),
      ...(err.hint === undefined ? [] : [`  hint: ${err.hint}`]),
    ];
  }
  return [`webhub daemon: ${err instanceof Error ? err.message : String(err)}`];
}

/** SIGHUP = console window closed (Windows) / terminal gone; SIGBREAK = Ctrl+Break. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const;

export async function main(): Promise<number> {
  // a closed stdout (parent gone) must not crash the daemon via EPIPE (K2)
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  // handlers BEFORE start: a signal during the slow start-up stops cleanly once ready (H8)
  const abort = new AbortController();
  let daemon: RunningDaemon | undefined;
  const onSignal = () => {
    abort.abort();
    void daemon?.stop();
  };
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  // last resort, installed BEFORE start (J6): never leave our token file behind (K2); the lock
  // is taken over by the next daemon anyway (F-001: dead PID / start time)
  let removeAuthSync: (() => void) | undefined;
  process.once("exit", () => removeAuthSync?.());
  process.once("uncaughtException", (err) => {
    process.stderr.write(`webhub daemon: internal error (${err.name})\n`);
    if (daemon === undefined) process.exit(1); // during start-up: the `exit` hook cleans up
    const force = setTimeout(() => process.exit(1), STOP_GRACE_MS + 1_000);
    void daemon.stop().finally(() => {
      clearTimeout(force);
      process.exit(1);
    });
  });
  try {
    daemon = await startDaemon({
      signal: abort.signal,
      onAuthFile: (remove) => {
        removeAuthSync = remove;
      },
    });
  } catch (err) {
    for (const line of describe(err)) process.stderr.write(`${line}\n`);
    return exitCodeFor(err);
  }
  const { clean } = await daemon.stopped;
  return clean ? 0 : 1;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
