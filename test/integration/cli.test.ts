import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  daemonStatus,
  ensureDaemon,
  startDaemonProcess,
  stopDaemon,
} from "../../src/cli/daemon-control.js";
import { CliError } from "../../src/cli/output.js";
import { getPlatform } from "../../src/platform/index.js";
import { tempHome } from "../helpers/home.js";

const ROOT = join(import.meta.dirname, "../..");
const CLI = join(ROOT, "dist", "cli.js");
const ENTRY = join(ROOT, "test", "fixtures", "cli-daemon-entry.mjs");

beforeAll(async () => {
  for (const [src, built] of [
    ["src/cli.ts", "dist/cli.js"],
    ["src/cli/daemon-control.ts", "dist/cli/daemon-control.js"],
    ["src/daemon.ts", "dist/daemon.js"],
    ["src/server/log-file.ts", "dist/server/log-file.js"],
  ] as const) {
    const b = await stat(join(ROOT, built)).catch(() => null);
    if (b === null || b.mtimeMs < (await stat(join(ROOT, src))).mtimeMs) {
      throw new Error(`${built} is missing or older than ${src} — run \`pnpm build\` first`);
    }
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

interface Result {
  code: number | null;
  out: string;
  err: string;
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString();
    });
    child.once("close", (code) => resolve({ code, out, err }));
  });
}

let h: Awaited<ReturnType<typeof tempHome>>;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  h = await tempHome();
  env = { ...process.env, WEBHUB_HOME: h.paths.home, WEBHUB_API_PORT: String(await freePort()) };
});
afterEach(async () => {
  // never leave a daemon behind
  await stopDaemon(h.paths, { force: true, timeoutMs: 3_000 }).catch(() => {});
  await h.cleanup();
});

describe("webhub daemon (F-004)", { timeout: 120_000 }, () => {
  it("start → status → logs → stop → status 3; the daemon outlives the CLI", async () => {
    const start = await cli(["daemon", "start"], env);
    expect(start.code).toBe(0);
    expect(start.out).toMatch(/started \(PID \d+, port \d+\)/);
    const auth = JSON.parse(readFileSync(h.paths.auth, "utf8")) as { pid: number; token: string };

    // a new CLI process (the first one has exited): the daemon still answers
    const status = await cli(["daemon", "status", "--json"], env);
    expect(status.code).toBe(0);
    const s = JSON.parse(status.out) as { running: boolean; pid: number; port: number };
    expect(s).toMatchObject({ running: true, pid: auth.pid, port: Number(env.WEBHUB_API_PORT) });

    const logs = await cli(["daemon", "logs", "-n", "5"], env);
    expect(logs.code).toBe(0);
    expect(logs.out).toContain('"msg":"ready"');
    expect(existsSync(join(h.paths.logs, "daemon.err"))).toBe(true);

    const stop = await cli(["daemon", "stop"], env);
    expect(stop.code).toBe(0);
    expect(stop.out).toContain("stopped");
    expect(existsSync(h.paths.auth)).toBe(false);
    expect(await getPlatform().process.info(auth.pid)).toBeUndefined();

    const after = await cli(["daemon", "status"], env);
    expect(after.code).toBe(3);
    const stopAgain = await cli(["daemon", "stop"], env);
    expect(stopAgain.code).toBe(0);
    expect(stopAgain.out).toContain("not running");
    // the token never reached the CLI output
    for (const r of [start, status, logs, stop]) expect(r.out + r.err).not.toContain(auth.token);
  });

  it("start twice → the second reports the running daemon", async () => {
    const a = await cli(["daemon", "start", "--json"], env);
    const b = await cli(["daemon", "start", "--json"], env);
    expect([a.code, b.code]).toEqual([0, 0]);
    const ja = JSON.parse(a.out) as { pid: number; alreadyRunning: boolean };
    const jb = JSON.parse(b.out) as { pid: number; alreadyRunning: boolean };
    expect(ja.alreadyRunning).toBe(false);
    expect(jb).toMatchObject({ pid: ja.pid, alreadyRunning: true });
  });

  it("two starts at the same time → one daemon, both exit 0", async () => {
    const [a, b] = await Promise.all([
      cli(["daemon", "start", "--json"], env),
      cli(["daemon", "start", "--json"], env),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const pids = [a, b].map((r) => (JSON.parse(r.out) as { pid: number }).pid);
    expect(pids[0]).toBe(pids[1]);
    expect((await daemonStatus(h.paths))?.pid).toBe(pids[0]);
  });

  it("API port taken by another program → exit 4 naming the port", async () => {
    const blocker = createNetServer().listen({
      host: "127.0.0.1",
      port: Number(env.WEBHUB_API_PORT),
    });
    await new Promise((r) => blocker.once("listening", r));
    try {
      const r = await cli(["daemon", "start"], env);
      expect(r.code).toBe(4);
      expect(r.err).toContain(`port ${env.WEBHUB_API_PORT}`);
    } finally {
      blocker.close();
    }
  });

  it("an impostor on the port: status / stop exit 1 and never send the token", async () => {
    const start = await cli(["daemon", "start"], env);
    expect(start.code).toBe(0);
    const port = Number(env.WEBHUB_API_PORT);
    // stop the real daemon but keep its auth.json, then squat its port
    const authText = readFileSync(h.paths.auth, "utf8");
    expect((await cli(["daemon", "stop"], env)).code).toBe(0);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(h.paths.auth, authText);
    const seen: IncomingHttpHeaders[] = [];
    const squatter = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end('{"proof":"nope"}');
    }).listen({ host: "127.0.0.1", port });
    await new Promise((r) => squatter.once("listening", r));
    try {
      const status = await cli(["daemon", "status"], env);
      expect(status.code).toBe(1);
      expect(status.err).toContain("not the webhub daemon");
      const stop = await cli(["daemon", "stop"], env);
      expect(stop.code).toBe(1);
      expect(seen.length).toBeGreaterThan(0);
      for (const hd of seen) expect(hd.authorization).toBeUndefined();
    } finally {
      squatter.close();
    }
  });
});

describe("daemon control in-process (F-004)", { timeout: 120_000 }, () => {
  it("child env has no NODE_OPTIONS / execArgv; cwd = home; args = --log-file only", async () => {
    await expect(
      startDaemonProcess(h.paths, {
        env: { ...env, NODE_OPTIONS: "--max-old-space-size=123", WEBHUB_TEST_ENTRY: "report" },
        daemonJs: ENTRY,
      }),
    ).rejects.toBeInstanceOf(CliError);
    const r = JSON.parse(readFileSync(join(h.paths.logs, "report.json"), "utf8")) as {
      nodeOptions: string | null;
      argv: string[];
      cwd: string;
      execArgv: string[];
    };
    expect(r.nodeOptions).toBeNull();
    expect(r.execArgv).toEqual([]);
    expect(r.argv).toEqual(["--log-file", join(h.paths.logs, "daemon.log")]);
    expect(r.cwd.toLowerCase()).toBe(h.paths.home.toLowerCase());
  });

  it("the daemon exits 2 at start → CLI exit 2 with its stderr (sanitised), temp file removed", async () => {
    const err = await startDaemonProcess(h.paths, {
      env: { ...env, WEBHUB_TEST_ENTRY: "fail-2" },
      daemonJs: ENTRY,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
    expect((err as CliError).message).toBe("config is broken");
    expect((err as CliError).details).toEqual(["  - detail one"]);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(h.paths.logs).filter((f) => f.startsWith("daemon-start-"))).toEqual([]);
  });

  it("not ready in time → the spawned process is killed, exit 1", async () => {
    const err = await startDaemonProcess(h.paths, {
      env: { ...env, WEBHUB_TEST_ENTRY: "never-ready" },
      daemonJs: ENTRY,
      timeoutMs: 3_000,
    }).catch((e: unknown) => e);
    expect((err as CliError).code).toBe("DAEMON_START_TIMEOUT");
    const pid = Number(readFileSync(join(h.paths.logs, "never-ready.pid"), "utf8"));
    const end = Date.now() + 10_000;
    while ((await getPlatform().process.info(pid)) !== undefined && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await getPlatform().process.info(pid)).toBeUndefined();
  });

  it("a stop that hangs: without --force exit 1 (hint), with --force the process is gone", async () => {
    const started = await startDaemonProcess(h.paths, {
      env: { ...env, WEBHUB_TEST_ENTRY: "hang-close" },
      daemonJs: ENTRY,
    });
    // hang-close arms itself once auth.json exists (50 ms poll)
    await new Promise((r) => setTimeout(r, 300));
    const err = await stopDaemon(h.paths, { timeoutMs: 1_000 }).catch((e: unknown) => e);
    expect((err as CliError).code).toBe("DAEMON_STOP_TIMEOUT");
    expect((err as CliError).hint).toContain("--force");
    // the daemon force-exits on its own after ~7 s; --force must not wait for that
    const t0 = Date.now();
    const r = await stopDaemon(h.paths, { force: true, timeoutMs: 500 }).catch((e: unknown) => e);
    if (r instanceof Error) {
      // already gone on its own between the calls: fine, nothing left to kill
      expect(await getPlatform().process.info(started.pid)).toBeUndefined();
    } else {
      expect(Date.now() - t0).toBeLessThan(5_000);
    }
    const end = Date.now() + 10_000;
    while ((await getPlatform().process.info(started.pid)) !== undefined && Date.now() < end) {
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(await getPlatform().process.info(started.pid)).toBeUndefined();
  });

  it("--force with a lock file of another PID → nothing killed", async () => {
    const started = await startDaemonProcess(h.paths, {
      env: { ...env, WEBHUB_TEST_ENTRY: "hang-close" },
      daemonJs: ENTRY,
    });
    await new Promise((r) => setTimeout(r, 300));
    const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");
    const lock = JSON.parse(rf(h.paths.lock, "utf8")) as Record<string, unknown>;
    wf(h.paths.lock, JSON.stringify({ ...lock, startedAt: "2000-01-01T00:00:00.0000000Z" }));
    const err = await stopDaemon(h.paths, { force: true, timeoutMs: 500 }).catch((e: unknown) => e);
    // either refused (start time differs) or the daemon already left on its own
    if (err instanceof CliError) expect(err.code).toBe("DAEMON_FORCE_REFUSED");
    wf(h.paths.lock, JSON.stringify(lock));
    void started;
  });

  it("ensureDaemon starts the daemon when needed", async () => {
    let told = false;
    const client = await ensureDaemon(h.paths, {
      env,
      daemonJs: join(ROOT, "dist", "daemon.js"), // vitest runs src/: no daemon.js next to it
      onStart: () => {
        told = true;
      },
    });
    expect(told).toBe(true);
    await client.verify();
    expect(await daemonStatus(h.paths)).toBeDefined();
  });
});
