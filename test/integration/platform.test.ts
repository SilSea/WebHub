import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPlatform, isPlatformError } from "../../src/platform/index.js";
import { elevatedCommand } from "../../src/platform/win32.js";
import {
  elevationFiles,
  nodeEnvProblems,
  pathTrustProblems,
  persistentEnvNames,
  trustTargets,
} from "../../src/platform/win32-trust.js";
import { processState } from "../../src/store/lock.js";

const win = process.platform === "win32";
const p = getPlatform();

function listen(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ port, host: "127.0.0.1" }, () => resolve(s));
  });
}
const portOf = (s: Server) => {
  const a = s.address();
  if (a === null || typeof a === "string") throw new Error("no port");
  return a.port;
};
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

const children: ChildProcess[] = [];
const extraPids: number[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const pid of extraPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
});

/**
 * Listener in ANOTHER process on `host`; resolves its port, or undefined when the child could
 * not listen (e.g. no IPv6 stack) — never hangs (review-2 D9).
 */
function foreignListener(host: string): Promise<number | undefined> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen({port:0,host:process.env.H},function(){console.log(this.address().port)})",
    ],
    { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, H: host } },
  );
  children.push(child);
  return new Promise((resolve) => {
    child.stdout?.once("data", (b: Buffer) => resolve(Number(b.toString().trim())));
    child.once("exit", () => resolve(undefined));
    child.once("error", () => resolve(undefined));
  });
}

describe.skipIf(!win)("Windows platform (real system)", { timeout: 60_000 }, () => {
  it("ports.listening (fresh) finds our own listener with our PID; result is a copy", async () => {
    const s = await listen();
    try {
      const all = await p.ports.listening({ fresh: true });
      expect(all.some((o) => o.port === portOf(s) && o.pid === process.pid)).toBe(true);
      all.length = 0;
      expect((await p.ports.listening()).length).toBeGreaterThan(0);
    } finally {
      await close(s);
    }
  });

  it("ports.reserved returns sane ranges", async () => {
    for (const r of await p.ports.reserved()) {
      expect(r.start).toBeGreaterThan(0);
      expect(r.end).toBeLessThanOrEqual(65535);
      expect(r.start).toBeLessThanOrEqual(r.end);
    }
  });

  it("ports.canBind: false while used here, true after", async () => {
    const s = await listen();
    const port = portOf(s);
    expect(await p.ports.canBind(port)).toBe(false);
    await close(s);
    expect(await p.ports.canBind(port)).toBe(true);
  });

  it.for(["::1", "0.0.0.0", "::"])(
    "ports.canBind: false while another process listens on %s",
    async (host, ctx) => {
      const port = await foreignListener(host);
      if (port === undefined) return ctx.skip(); // address family not available here
      expect(await p.ports.canBind(port)).toBe(false);
    },
  );

  it("ports.findFree skips used ports (also foreign IPv6) and the avoid set", async (ctx) => {
    const s = await listen();
    const used = portOf(s);
    const v6 = await foreignListener("::1");
    if (v6 === undefined) {
      await close(s);
      return ctx.skip();
    }
    try {
      const lo = Math.min(used, v6);
      const hi = Math.min(Math.max(used, v6) + 50, 65535);
      const free = await p.ports.findFree([lo, hi], new Set([lo + 1]));
      expect([used, v6, lo + 1]).not.toContain(free);
      expect(await p.ports.canBind(free)).toBe(true);
    } finally {
      await close(s);
    }
  });

  it("ports.findFree inside an excluded range → skips the whole run (if the machine has one)", async (ctx) => {
    const ranges = [...(await p.ports.reserved())].sort((a, b) => a.start - b.start);
    const first = ranges[0];
    if (first === undefined) return ctx.skip();
    // adjacent/overlapping ranges (Hyper-V/WSL reserve 100-port blocks) form one run (D3)
    let runEnd = first.end;
    for (const r of ranges) if (r.start <= runEnd + 1 && r.end > runEnd) runEnd = r.end;
    if (runEnd + 300 > 65535) return ctx.skip();
    const free = await p.ports.findFree([first.start, runEnd + 300]);
    expect(free).toBeGreaterThan(runEnd);
  });

  it("process.info / usage of ourselves; unknown PID → undefined", async () => {
    const me = await p.process.info(process.pid);
    expect(me?.name.toLowerCase()).toContain("node");
    expect(me?.parentPid).toBeGreaterThan(0);
    expect(me?.startedAt).toMatch(/Z$/);
    expect(await p.process.info(2 ** 22 + 7)).toBeUndefined();
    const u = (await p.process.usage([process.pid])).get(process.pid);
    expect(u?.workingSetBytes).toBeGreaterThan(0);
    expect(u?.cpuSeconds).toBeGreaterThanOrEqual(0);
  });

  it("process.killTree kills child + grandchild; refuses a wrong start time", async () => {
    // child spawns a grandchild, prints its PID, both wait forever
    const code = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      console.log(g.pid);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    const grandPid = await new Promise<number>((resolve) =>
      child.stdout.once("data", (b: Buffer) => resolve(Number(b.toString().trim()))),
    );
    extraPids.push(grandPid);
    const pid = child.pid ?? 0;
    const st = await processState(pid);
    expect(st.state).toBe("alive");
    const startedAt = st.state === "alive" ? st.startedAt : "";
    expect((await p.process.info(pid))?.startedAt).toBe(startedAt); // same format as F-001

    await expect(p.process.killTree(pid, "1999-01-01T00:00:00.0000000Z")).rejects.toSatisfy((e) =>
      isPlatformError(e, "PROCESS_MISMATCH"),
    );
    expect((await processState(pid)).state).toBe("alive");

    const t0 = Date.now();
    await p.process.killTree(pid, startedAt);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await processState(pid)).state).toBe("dead");
    expect((await processState(grandPid)).state).toBe("dead");
    await p.process.killTree(pid, startedAt); // already gone → fine
  });

  it("trust check: system file trusted; user temp folder not; missing file reported", async () => {
    const sys = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe");
    expect(await pathTrustProblems(trustTargets([sys]))).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "webhub-trust-"));
    try {
      // owner is the user, or Administrators when the suite runs elevated → either way a problem (D8)
      expect((await pathTrustProblems([["F", dir]])).length).toBeGreaterThan(0);
      expect(await pathTrustProblems([["F", join(dir, "missing.js")]])).toEqual([
        `${join(dir, "missing.js")}: missing`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trust check: trusted owner but an ACE lets others write → 'writable by' (D7)", async (ctx) => {
    const pub = join(process.env.SystemDrive ?? "C:", "\\Users\\Public");
    const problems = await pathTrustProblems([["F", pub]]);
    if (problems.some((x) => x.endsWith("unreadable"))) return ctx.skip();
    expect(problems.some((x) => x.startsWith(`${pub}: writable by S-1-`))).toBe(true);
    expect(problems.some((x) => x.includes(": owner "))).toBe(false);
  });

  it("environment sources include the volatile keys (T2)", async () => {
    const names = (await persistentEnvNames()).map((n) => n.toUpperCase());
    // USERDOMAIN / SESSIONNAME / LOGONSERVER exist only in HKCU\Volatile Environment (+ session subkey)
    expect(
      names.some((n) => ["USERDOMAIN", "SESSIONNAME", "LOGONSERVER", "USERNAME"].includes(n)),
    ).toBe(true);
  });

  it("elevate refuses (ELEVATION_UNSAFE) when webhub's files are user-writable — no UAC shown", async (ctx) => {
    const { exe, script } = elevatedCommand();
    const problems = [
      ...nodeEnvProblems([...(await persistentEnvNames()), ...Object.keys(process.env)]),
      ...(await pathTrustProblems(trustTargets(elevationFiles(exe, script)))),
    ];
    // a dev checkout is user-owned; if this machine is fully trusted, skip (would show UAC)
    if (problems.length === 0) return ctx.skip();
    await expect(p.elevate({ kind: "noop" })).rejects.toSatisfy(
      (e) => isPlatformError(e, "ELEVATION_UNSAFE") && e.details.length > 0,
    );
  });

  it("built elevated.mjs runs standalone and loads nothing but node built-ins", async () => {
    const { script } = elevatedCommand();
    const { encodeTask } = await import("../../src/platform/tasks.js");
    // trace every module node loads for the real entry (no UAC: run as the current user)
    const hook =
      "data:text/javascript,import{registerHooks}from'node:module';registerHooks({resolve(s,c,n){const r=n(s,c);if(!r.url.startsWith('node:'))process.stderr.write('LOAD '+r.url+'\\n');return r}})";
    const child = spawn(
      process.execPath,
      ["--import", hook, script, encodeTask({ kind: "noop" })],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let err = "";
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString();
    });
    const exit = await new Promise<number | null>((r) => child.once("exit", r));
    expect(exit).toBe(0);
    const loaded = err.split(/\r?\n/).filter((l) => l.startsWith("LOAD "));
    expect(loaded.every((l) => l.endsWith("/elevated.mjs"))).toBe(true);
  });

  it("notify never throws (special characters stay data)", async () => {
    const ok = await p.notify(`webhub test '"; $(calc) <b>&`, "integration test — ignore");
    expect(typeof ok).toBe("boolean");
  });
});
