import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopDaemon } from "../../src/cli/daemon-control.js";
import { CliError } from "../../src/cli/output.js";
import type { Paths } from "../../src/config/home.js";
import { type Platform, PlatformError, type ProcInfo } from "../../src/platform/index.js";
import { isServerError } from "../../src/server/errors.js";
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
