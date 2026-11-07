import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Paths } from "../../src/config/home.js";
import { isWebhubError } from "../../src/errors.js";
import { acquireLock, assertLock, processStartTime } from "../../src/store/lock.js";
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
    const startedAt = await processStartTime(process.pid);
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

  it("processStartTime is stable and undefined for bad PIDs", async () => {
    const a = await processStartTime(process.pid);
    expect(a).toBeTruthy();
    expect(await processStartTime(process.pid)).toBe(a);
    expect(await processStartTime(-1)).toBeUndefined();
    expect(await processStartTime(1.5)).toBeUndefined();
  });

  it("assertLock checks held + home", () => {
    expect(() => assertLock(undefined, h.paths.home)).toThrow(/lock/);
    expect(() => assertLock(fakeLock(h.paths.home, false), h.paths.home)).toThrow(/lock/);
    expect(() => assertLock(fakeLock(h.paths.data), h.paths.home)).toThrow(/lock/);
    expect(() => assertLock(fakeLock(h.paths.home), h.paths.home)).not.toThrow();
  });
});
