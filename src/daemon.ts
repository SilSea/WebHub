#!/usr/bin/env node
/**
 * webhub daemon (F-003 §3.1): the single writer of `$WEBHUB_HOME/data` and the API server on
 * 127.0.0.1:7400. Foreground process; `webhub daemon start` (F-004) runs it detached.
 *
 * Exit codes: 0 stopped normally, 1 other error, 2 config invalid, 3 another daemon runs,
 * 4 API port busy.
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
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
  /** Called when the API asked for shutdown (POST /api/v1/shutdown). */
  onShutdownRequest?: () => void;
}

export interface RunningDaemon {
  readonly paths: Paths;
  readonly port: number;
  readonly app: FastifyInstance;
  /** Idempotent clean stop: close server, remove auth.json (if ours), release lock. */
  stop(): Promise<void>;
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
        onShutdown: () => opts.onShutdownRequest?.(),
        log,
      },
      opts.registrars ?? [],
    );
    try {
      await app.listen({ host: "127.0.0.1", port });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new ServerError("DAEMON_PORT_BUSY", `port ${port} (webhub API) is already in use`, {
          details: await portOwner(port),
          hint: "Stop the program that uses this port, then start webhub again.",
        });
      }
      throw err;
    }
    const doc: AuthFile = {
      schemaVersion: AUTH_FILE_VERSION,
      token,
      pid: process.pid,
      port,
      startedAt,
    };
    await writeDoc(lock, paths.auth, doc, { keepBackup: false });
    const running = app;
    log({ msg: "ready", port, home: paths.home });
    return {
      paths,
      port,
      app: running,
      stop: () => {
        stopping ??= (async () => {
          const timer = setTimeout(() => running.server.closeAllConnections(), STOP_GRACE_MS);
          try {
            await running.close();
          } finally {
            clearTimeout(timer);
            await removeAuthFile(paths.auth, token);
            await lock.release();
            log({ msg: "stopped" });
          }
        })();
        return stopping;
      },
    };
  } catch (err) {
    await app?.close().catch(() => {});
    await removeAuthFile(paths.auth, token);
    await lock.release();
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
    return [
      `webhub daemon: ${err.message}`,
      ...err.details.map((d) => `  - ${d}`),
      ...(err.hint === undefined ? [] : [`  hint: ${err.hint}`]),
    ];
  }
  return [`webhub daemon: ${err instanceof Error ? err.message : String(err)}`];
}

export async function main(): Promise<number> {
  let daemon: RunningDaemon | undefined;
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });
  const stop = () => {
    if (daemon === undefined) return;
    void daemon.stop().then(
      () => resolveDone(0),
      () => resolveDone(1),
    );
  };
  try {
    daemon = await startDaemon({ onShutdownRequest: stop });
  } catch (err) {
    for (const line of describe(err)) process.stderr.write(`${line}\n`);
    return exitCodeFor(err);
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(sig, stop);
  return done;
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
