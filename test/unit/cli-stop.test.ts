import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authVanished, isStopping, stopDaemon } from "../../src/cli/daemon-control.js";
import { CliError } from "../../src/cli/output.js";
import type { Paths } from "../../src/config/home.js";
import { type Platform, PlatformError, type ProcInfo } from "../../src/platform/index.js";
import { helloProof } from "../../src/server/auth.js";
import { isServerError, ServerError } from "../../src/server/errors.js";
import { tempHome } from "../helpers/home.js";

const PID = 4242;
const STARTED = "2026-11-14T01:02:03.0000000Z";
const TOKEN = "A".repeat(43);

/** A fake process table: `procs` is edited by the tests; every kill is recorded. */
function fakePlatform() {
  const procs = new Map<number, ProcInfo>();
  const kills: { pid: number; startedAt: string }[] = [];
  let infoFails = false;
  let onKill: (pid: number, startedAt: string) => void = (pid) => {
    procs.delete(pid);
  };
  const platform = {
    name: "win32",
    process: {
      info: async (pid: number) => {
        if (infoFails) throw new PlatformError("PLATFORM_TOOL", "powershell failed");
        return procs.get(pid);
      },
      killTree: async (pid: number, startedAt: string) => {
        kills.push({ pid, startedAt });
        onKill(pid, startedAt);
      },
      usage: async () => new Map(),
    },
    ports: { listening: async () => [] },
  } as unknown as Platform;
  return {
    platform,
    procs,
    kills,
    add(pid: number, startedAt: string | undefined) {
      procs.set(pid, { pid, name: "node.exe", exe: undefined, startedAt, parentPid: 1 });
    },
    failInfo() {
      infoFails = true;
    },
    setOnKill(fn: (pid: number, startedAt: string) => void) {
      onKill = fn;
    },
  };
}

function writeJson(file: string, v: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(v));
}
const writeAuth = (paths: Paths, pid: number, port: number) =>
  writeJson(paths.auth, { schemaVersion: 1, token: TOKEN, pid, port, startedAt: STARTED });
const writeLock = (paths: Paths, pid: number, startedAt: string) =>
  writeJson(paths.lock, { pid, startedAt });

/** A program on the API port that never proves itself (answers 503 like a closing daemon). */
async function squatter(): Promise<{ server: Server; port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(503, { "content-type": "application/json" }).end('{"error":{}}');
  });
  await new Promise<void>((r) => server.listen({ host: "127.0.0.1", port: 0 }, r));
  const a = server.address();
  return { server, port: typeof a === "object" && a !== null ? a.port : 0, seen };
}

let h: Awaited<ReturnType<typeof tempHome>>;
let sq: Awaited<ReturnType<typeof squatter>>;
beforeEach(async () => {
  h = await tempHome();
  sq = await squatter();
});
afterEach(async () => {
  await new Promise((r) => sq.server.close(r));
  await h.cleanup();
});

describe("stop without proof (F-004 §3.4, review C1 / C2 / C6 / C7)", () => {
  it("our daemon stopping (503) → waited for, stopped, auth.json removed, nothing killed", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    setTimeout(() => f.procs.delete(PID), 300);
    const r = await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 5_000 });
    expect(r).toEqual({ wasRunning: true, forced: false });
    expect(f.kills).toEqual([]);
    expect(existsSync(h.paths.auth)).toBe(false);
    for (const hd of sq.seen) expect(hd.authorization).toBeUndefined();
  });

  it("our daemon hangs: no --force → DAEMON_STOP_TIMEOUT, nothing killed", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    const err = await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 300 }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe("DAEMON_STOP_TIMEOUT");
    expect((err as CliError).hint).toContain("--force");
    expect(f.kills).toEqual([]);
  });

  it("--force kills exactly (lock PID, lock start time)", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    const r = await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 300, force: true });
    expect(r).toEqual({ wasRunning: true, forced: true });
    expect(f.kills).toEqual([{ pid: PID, startedAt: STARTED }]);
    expect(existsSync(h.paths.auth)).toBe(false);
  });

  it("--force keeps an auth.json a new daemon wrote meanwhile", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    f.setOnKill((pid) => {
      f.procs.delete(pid);
      writeAuth(h.paths, PID + 1, sq.port); // another `start` won the lock right after
    });
    await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 300, force: true });
    expect(existsSync(h.paths.auth)).toBe(true);
  });

  it("PID reused while waiting (start time changed) → stopped, nothing killed even with --force", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    setTimeout(() => f.add(PID, "2026-11-14T09:09:09.0000000Z"), 300);
    const r = await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 5_000, force: true });
    expect(r).toEqual({ wasRunning: true, forced: false });
    expect(f.kills).toEqual([]);
  });

  it("--force: killTree refuses (start time differs) → DAEMON_FORCE_REFUSED", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    f.setOnKill(() => {
      throw new PlatformError("PROCESS_MISMATCH", "x");
    });
    const err = await stopDaemon(h.paths, {
      platform: f.platform,
      timeoutMs: 300,
      force: true,
    }).catch((e: unknown) => e);
    expect((err as CliError).code).toBe("DAEMON_FORCE_REFUSED");
  });

  it("--force: kill fails (access denied) → DAEMON_KILL_FAILED, not 'not the daemon'", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    f.setOnKill(() => {
      throw new PlatformError("PROCESS_KILL_FAILED", "x", { details: ["taskkill exit 1"] });
    });
    const err = (await stopDaemon(h.paths, {
      platform: f.platform,
      timeoutMs: 300,
      force: true,
    }).catch((e: unknown) => e)) as CliError;
    expect(err.code).toBe("DAEMON_KILL_FAILED");
    expect(err.details).toEqual(["taskkill exit 1"]);
    expect(existsSync(h.paths.auth)).toBe(true);
  });
});

describe("stop with an impostor (F-004 §3.4 step 2)", () => {
  const impostor = (e: unknown) => isServerError(e, "DAEMON_IMPOSTOR");

  it("daemon dead, program on the port → DAEMON_IMPOSTOR at once; --force kills nothing", async () => {
    const f = fakePlatform(); // PID not in the table: dead
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    const t0 = Date.now();
    const err = await stopDaemon(h.paths, {
      platform: f.platform,
      timeoutMs: 5_000,
      force: true,
    }).catch((e: unknown) => e);
    expect(impostor(err)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000); // no stop wait
    expect(f.kills).toEqual([]);
    for (const hd of sq.seen) expect(hd.authorization).toBeUndefined();
  });

  it("auth.json and lock name different PIDs (both alive) → DAEMON_IMPOSTOR, nothing killed", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    f.add(PID + 1, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID + 1, STARTED);
    const err = await stopDaemon(h.paths, {
      platform: f.platform,
      timeoutMs: 5_000,
      force: true,
    }).catch((e: unknown) => e);
    expect(impostor(err)).toBe(true);
    expect(f.kills).toEqual([]);
  });

  it("PID alive but with another start time than the lock → DAEMON_IMPOSTOR, nothing killed", async () => {
    const f = fakePlatform();
    f.add(PID, "2026-11-14T09:09:09.0000000Z");
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    const err = await stopDaemon(h.paths, {
      platform: f.platform,
      timeoutMs: 5_000,
      force: true,
    }).catch((e: unknown) => e);
    expect(impostor(err)).toBe(true);
    expect(f.kills).toEqual([]);
  });

  it("process table unreadable → not taken as ours or as dead: DAEMON_IMPOSTOR", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    f.failInfo();
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    const err = await stopDaemon(h.paths, {
      platform: f.platform,
      timeoutMs: 5_000,
      force: true,
    }).catch((e: unknown) => e);
    expect(impostor(err)).toBe(true);
    expect(f.kills).toEqual([]);
    expect(err).not.toBeInstanceOf(CliError);
  });
});

describe("missing branches (review-2 E4 a / e)", () => {
  it("process table fails while waiting → not taken as dead: timeout, auth.json kept", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    setTimeout(() => f.failInfo(), 150);
    const err = await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 600 }).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe("DAEMON_STOP_TIMEOUT");
    expect(existsSync(h.paths.auth)).toBe(true);
    expect(f.kills).toEqual([]);
  });

  it("PID alive without a known start time → not ours: DAEMON_IMPOSTOR, nothing killed", async () => {
    const f = fakePlatform();
    f.add(PID, undefined);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    const err = await stopDaemon(h.paths, {
      platform: f.platform,
      timeoutMs: 300,
      force: true,
    }).catch((e: unknown) => e);
    expect(isServerError(err, "DAEMON_IMPOSTOR")).toBe(true);
    expect(f.kills).toEqual([]);
  });
});

describe("a stopping daemon without auth.json (review-2 E3)", () => {
  it("the lock names a live PID with its start time → waited for until it is gone", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeLock(h.paths, PID, STARTED);
    setTimeout(() => f.procs.delete(PID), 300);
    const t0 = Date.now();
    const r = await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 5_000 });
    expect(r).toEqual({ wasRunning: true, forced: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(f.kills).toEqual([]);
  });

  it("stale lock (dead PID / other start time) → not running at once", async () => {
    const f = fakePlatform();
    writeLock(h.paths, PID, STARTED);
    expect(await stopDaemon(h.paths, { platform: f.platform })).toEqual({
      wasRunning: false,
      forced: false,
    });
    f.add(PID, "2026-11-14T09:09:09.0000000Z");
    expect(await stopDaemon(h.paths, { platform: f.platform })).toEqual({
      wasRunning: false,
      forced: false,
    });
  });
});

describe("auth.json of another run is kept (review-2 E5)", () => {
  it("same PID, new token written while waiting → not removed", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    writeAuth(h.paths, PID, sq.port);
    writeLock(h.paths, PID, STARTED);
    setTimeout(() => {
      writeJson(h.paths.auth, {
        schemaVersion: 1,
        token: "B".repeat(43),
        pid: PID,
        port: sq.port,
        startedAt: STARTED,
      });
      f.procs.delete(PID);
    }, 300);
    await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 5_000 });
    expect(existsSync(h.paths.auth)).toBe(true);
  });
});

/** A daemon that proves itself (hello HMAC) — behaviour switched by the tests. */
async function fakeDaemon(opts: {
  statusPid: number;
  helloFailsFirst?: boolean;
  shutdown?: "ok" | "stopping";
  onShutdown?: () => void;
}): Promise<{ server: Server; port: number; shutdowns: () => number }> {
  let hellos = 0;
  let shutdowns = 0;
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/v1/hello") {
      hellos++;
      if (opts.helloFailsFirst === true && hellos === 1) {
        json(res, 503, { error: { code: "SHUTTING_DOWN", message: "webhub is stopping" } });
        return;
      }
      json(res, 200, { proof: helloProof(TOKEN, url.searchParams.get("n") ?? "") });
      return;
    }
    if (url.pathname === "/api/v1/status") {
      json(res, 200, { pid: opts.statusPid, version: "t", startedAt: STARTED, home: "h" });
      return;
    }
    if (url.pathname === "/api/v1/shutdown") {
      shutdowns++;
      if (opts.shutdown === "stopping") {
        json(res, 503, { error: { code: "SHUTTING_DOWN", message: "webhub is stopping" } });
      } else {
        json(res, 202, { stopping: true });
      }
      opts.onShutdown?.();
      return;
    }
    json(res, 404, {});
  });
  await new Promise<void>((r) => server.listen({ host: "127.0.0.1", port: 0 }, r));
  const a = server.address();
  return {
    server,
    port: typeof a === "object" && a !== null ? a.port : 0,
    shutdowns: () => shutdowns,
  };
}

describe("a proven daemon (review-2 E1 / E4 b / d)", () => {
  it("shutdown answered 503 SHUTTING_DOWN after the proof → waited for, stopped", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    const d = await fakeDaemon({
      statusPid: PID,
      shutdown: "stopping",
      onShutdown: () => setTimeout(() => f.procs.delete(PID), 200),
    });
    try {
      writeAuth(h.paths, PID, d.port);
      writeLock(h.paths, PID, STARTED);
      const r = await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 5_000 });
      expect(r).toEqual({ wasRunning: true, forced: false });
      expect(d.shutdowns()).toBe(1);
    } finally {
      d.server.close();
    }
  });

  it("our daemon gone, a new one answers meanwhile → the new one is stopped", async () => {
    const NEW = PID + 7;
    const f = fakePlatform(); // PID (auth.json) dead
    f.add(NEW, STARTED);
    const d = await fakeDaemon({
      statusPid: NEW,
      helloFailsFirst: true,
      onShutdown: () => setTimeout(() => f.procs.delete(NEW), 100),
    });
    try {
      writeAuth(h.paths, PID, d.port);
      writeLock(h.paths, NEW, STARTED);
      const r = await stopDaemon(h.paths, { platform: f.platform, timeoutMs: 5_000 });
      expect(r).toEqual({ wasRunning: true, forced: false });
      expect(d.shutdowns()).toBe(1);
      expect(f.kills).toEqual([]);
    } finally {
      d.server.close();
    }
  });

  it("--force when the lock names another PID than the proven daemon → refused, nothing killed", async () => {
    const f = fakePlatform();
    f.add(PID, STARTED);
    f.add(PID + 1, STARTED);
    const d = await fakeDaemon({ statusPid: PID });
    try {
      writeAuth(h.paths, PID, d.port);
      writeLock(h.paths, PID + 1, STARTED);
      const err = await stopDaemon(h.paths, {
        platform: f.platform,
        timeoutMs: 300,
        force: true,
      }).catch((e: unknown) => e);
      expect((err as CliError).code).toBe("DAEMON_FORCE_REFUSED");
      expect(f.kills).toEqual([]);
    } finally {
      d.server.close();
    }
  });
});

describe("error mapping (review-2 E1 / E2)", () => {
  it("ENOENT (auth.json removed mid-read) = not running; 503 SHUTTING_DOWN = stopping", () => {
    const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(authVanished(enoent)).toBe(true);
    expect(authVanished(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(
      isStopping(new ServerError("API_ERROR", "x", { status: 503, apiCode: "SHUTTING_DOWN" })),
    ).toBe(true);
    expect(isStopping(new ServerError("API_ERROR", "x", { status: 500, apiCode: "X" }))).toBe(
      false,
    );
  });
});
