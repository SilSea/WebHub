import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { getPlatform, isPlatformError } from "../../src/platform/index.js";
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

describe.skipIf(!win)("Windows platform (real system)", { timeout: 60_000 }, () => {
  it("ports.listening finds our own listener with our PID", async () => {
    const s = await listen();
    try {
      await new Promise((r) => setTimeout(r, 2100)); // past the listener cache
      const all = await p.ports.listening();
      expect(all.some((o) => o.port === portOf(s) && o.pid === process.pid)).toBe(true);
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

  it("ports.canBind: false while used, true after", async () => {
    const s = await listen();
    const port = portOf(s);
    expect(await p.ports.canBind(port)).toBe(false);
    await close(s);
    expect(await p.ports.canBind(port)).toBe(true);
  });

  it("ports.findFree skips a used port and the avoid set", async () => {
    const s = await listen();
    const used = portOf(s);
    try {
      await new Promise((r) => setTimeout(r, 2100));
      const free = await p.ports.findFree([used, Math.min(used + 50, 65535)], new Set([used + 1]));
      expect(free).not.toBe(used);
      expect(free).not.toBe(used + 1);
      expect(await p.ports.canBind(free)).toBe(true);
    } finally {
      await close(s);
    }
  });

  it("process.info / usage of ourselves; unknown PID → undefined", async () => {
    const me = await p.process.info(process.pid);
    expect(me?.name.toLowerCase()).toContain("node");
    expect(me?.parentPid).toBeGreaterThan(0);
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
    const grandPid = await new Promise<number>((resolve) =>
      child.stdout.once("data", (b: Buffer) => resolve(Number(b.toString().trim()))),
    );
    const pid = child.pid ?? 0;
    const st = await processState(pid);
    expect(st.state).toBe("alive");
    const startedAt = st.state === "alive" ? st.startedAt : "";

    await expect(p.process.killTree(pid, "1999-01-01T00:00:00.0000000Z")).rejects.toSatisfy((e) =>
      isPlatformError(e, "PROCESS_MISMATCH"),
    );
    expect((await processState(pid)).state).toBe("alive");

    await p.process.killTree(pid, startedAt);
    expect((await processState(pid)).state).toBe("dead");
    expect((await processState(grandPid)).state).toBe("dead");
    await p.process.killTree(pid, startedAt); // already gone → fine
  });

  it("notify never throws (special characters stay data)", async () => {
    const ok = await p.notify(`webhub test '"; $(calc) <b>&`, "integration test — ignore");
    expect(typeof ok).toBe("boolean");
  });
});
