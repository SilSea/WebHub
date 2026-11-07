import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Paths } from "../../src/config/home.js";
import { isWebhubError } from "../../src/errors.js";
import { acquireLock, assertLock, processState } from "../../src/store/lock.js";
import { fakeLock, tempHome } from "../helpers/home.js";

let h: { paths: Paths; cleanup(): Promise<void> };
beforeEach(async () => {
  h = await tempHome();
  await mkdir(h.paths.data, { recursive: true });
});
afterEach(() => h.cleanup());

const writeLock = (info: object) => writeFile(h.paths.lock, JSON.stringify(info));

describe("lock", { timeout: 30_000 }, () => {
  it("acquires, blocks a second writer, releases", async () => {
    const lock = await acquireLock(h.paths);
    expect(lock.held).toBe(true);
    const info = JSON.parse(await readFile(h.paths.lock, "utf8"));
    expect(info.pid).toBe(process.pid);
    expect(info.hostname).toBe(hostname());
    await expect(acquireLock(h.paths)).rejects.toSatisfy((e) => isWebhubError(e, "LOCKED"));
    await lock.release();
    expect(lock.held).toBe(false);
    const again = await acquireLock(h.paths);
    await again.release();
  });

  it("takes over a lock from a dead process", async () => {
    await writeLock({ pid: 2 ** 22 + 7, startedAt: "x", hostname: hostname(), token: "t" });
    const lock = await acquireLock(h.paths);
    await lock.release();
  });

  it("takes over when the PID was reused (start time differs)", async () => {
    await writeLock({
      pid: process.pid,
      startedAt: "1999-01-01",
      hostname: hostname(),
      token: "t",
    });
    const lock = await acquireLock(h.paths);
    await lock.release();
  });

  it("takes over an unreadable lock file", async () => {
    await writeFile(h.paths.lock, "{garbage");
    const lock = await acquireLock(h.paths);
    await lock.release();
  });

  it("stays locked for a live process or another host", async () => {
    const self = await processState(process.pid);
    const startedAt = self.state === "alive" ? self.startedAt : "";
    await writeLock({ pid: process.pid, startedAt, hostname: hostname(), token: "t" });
    await expect(acquireLock(h.paths)).rejects.toSatisfy((e) => isWebhubError(e, "LOCKED"));
    await writeLock({ pid: 1, startedAt: "x", hostname: "other-host.invalid", token: "t" });
    await expect(acquireLock(h.paths)).rejects.toSatisfy((e) => isWebhubError(e, "LOCKED"));
  });

  it("release does not delete a lock taken over by someone else", async () => {
    const lock = await acquireLock(h.paths);
    const foreign = JSON.stringify({ pid: 1, startedAt: "x", hostname: "h", token: "other" });
    await writeFile(h.paths.lock, foreign);
    await lock.release();
    expect(await readFile(h.paths.lock, "utf8")).toBe(foreign);
  });

  it("processState: alive + stable start time; dead for bad/missing PIDs", async () => {
    const a = await processState(process.pid);
    expect(a.state).toBe("alive");
    expect(await processState(process.pid)).toEqual(a);
    expect(await processState(-1)).toEqual({ state: "dead" });
    expect(await processState(1.5)).toEqual({ state: "dead" });
    expect(await processState(2 ** 22 + 7)).toEqual({ state: "dead" });
  });

  it("Windows: a system process (other user / elevated) is never reported dead", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    expect((await processState(4)).state).not.toBe("dead");
  });

  it("verify() detects a lock that was replaced; release keeps the foreign lock", async () => {
    const lock = await acquireLock(h.paths);
    await expect(lock.verify()).resolves.toBeUndefined();
    const foreign = JSON.stringify({ pid: 1, startedAt: "x", hostname: "h", token: "other" });
    await writeFile(h.paths.lock, foreign);
    await expect(lock.verify()).rejects.toSatisfy((e) => isWebhubError(e, "NOT_LOCKED"));
    expect(lock.held).toBe(false);
    expect(await readFile(h.paths.lock, "utf8")).toBe(foreign);
  });

  it("concurrent takeover of a stale lock has exactly one winner", async () => {
    for (let round = 0; round < 5; round++) {
      await writeLock({ pid: 2 ** 22 + 7, startedAt: "x", hostname: hostname(), token: "dead" });
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => acquireLock(h.paths)),
      );
      const won = results.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect(isWebhubError(r.reason, "LOCKED")).toBe(true);
      }
      if (won[0]?.status === "fulfilled") await won[0].value.release();
    }
  });

  it("assertLock checks held + home", () => {
    expect(() => assertLock(undefined, h.paths.home)).toThrow(/lock/);
    expect(() => assertLock(fakeLock(h.paths.home, false), h.paths.home)).toThrow(/lock/);
    expect(() => assertLock(fakeLock(h.paths.data), h.paths.home)).toThrow(/lock/);
    expect(() => assertLock(fakeLock(h.paths.home), h.paths.home)).not.toThrow();
  });
});
