import { spawn } from "node:child_process";
import { readdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../../src/config/config.js";
import { ensureHome, type Paths } from "../../src/config/home.js";
import { isWebhubError } from "../../src/errors.js";
import { acquireLock } from "../../src/store/lock.js";
import { assertUntouched, copyFixture, hashTree, removeFixtureCopy } from "../helpers/fixture.js";
import { tempHome } from "../helpers/home.js";

const LOCK_MODULE = pathToFileURL(join(import.meta.dirname, "../../dist/store/lock.js")).href;
const HOME_MODULE = pathToFileURL(join(import.meta.dirname, "../../dist/config/home.js")).href;

// child processes load the built code: refuse to test a stale dist/ (review-1 R11)
beforeAll(async () => {
  const root = join(import.meta.dirname, "../..");
  const sources = (await readdir(join(root, "src"), { recursive: true, encoding: "utf8" })).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
  );
  for (const rel of sources) {
    const src = join("src", rel);
    const built = join("dist", `${rel.slice(0, -3)}.js`);
    const b = await stat(join(root, built)).catch(() => null);
    if (b === null || b.mtimeMs < (await stat(join(root, src))).mtimeMs) {
      throw new Error(`${built} is missing or older than ${src} — run \`pnpm build\` first`);
    }
  }
});

let h: { root: string; paths: Paths; cleanup(): Promise<void> };
beforeEach(async () => {
  h = await tempHome();
  await ensureHome(h.paths);
});
afterEach(() => h.cleanup());

/** Starts a separate node process that takes the lock, prints READY, then waits. */
function holder(home: string) {
  const code = `
    const { acquireLock } = await import(${JSON.stringify(LOCK_MODULE)});
    const { pathsFor } = await import(${JSON.stringify(HOME_MODULE)});
    await acquireLock(pathsFor(${JSON.stringify(home)}));
    console.log("READY");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "pipe" });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (b: Buffer) => {
      if (b.toString().includes("READY")) resolve();
    });
    child.stderr.on("data", (b: Buffer) => reject(new Error(b.toString())));
    child.on("exit", (c) => reject(new Error(`holder exited ${c}`)));
  });
  return { child, ready };
}

describe("lock across processes", () => {
  it("second process gets LOCKED; lock of a killed process is taken over", async () => {
    const { child, ready } = holder(h.paths.home);
    try {
      await ready;
      await expect(acquireLock(h.paths)).rejects.toSatisfy((e) => isWebhubError(e, "LOCKED"));
    } finally {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
    }
    const lock = await acquireLock(h.paths); // lock file is still there, holder is dead
    await lock.release();
  });
});

/** Separate process: tries the lock once, prints WON or LOST, holds a WON lock for 2 s. */
function racer(home: string): Promise<string> {
  const code = `
    const { acquireLock } = await import(${JSON.stringify(LOCK_MODULE)});
    const { pathsFor } = await import(${JSON.stringify(HOME_MODULE)});
    try {
      const lock = await acquireLock(pathsFor(${JSON.stringify(home)}));
      console.log("WON");
      await new Promise((r) => setTimeout(r, 2000));
      await lock.release();
    } catch (e) { console.log(e.code === "LOCKED" ? "LOST" : "ERR " + e.message); }
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.on("exit", () => resolve(out.trim()));
  });
}

describe("stale lock race across processes", () => {
  it("4 processes taking over the same stale lock → exactly one wins", async () => {
    for (let round = 0; round < 3; round++) {
      await writeFile(
        h.paths.lock,
        JSON.stringify({ pid: 2 ** 22 + 7, startedAt: "x", hostname: hostname(), token: "dead" }),
      );
      const results = await Promise.all(Array.from({ length: 4 }, () => racer(h.paths.home)));
      expect(results.filter((r) => r === "WON")).toHaveLength(1);
      expect(results.filter((r) => r === "LOST")).toHaveLength(3);
    }
  });
});

describe("zero-touch (R0)", () => {
  it("loading/saving config with a scan root never touches the project", async () => {
    const copy = await copyFixture("vite-basic");
    try {
      const before = await hashTree(copy);
      const lock = await acquireLock(h.paths);
      try {
        const { config } = await loadConfig(h.paths, lock);
        await saveConfig(lock, h.paths, { ...config, scanRoots: [copy] });
        const res = await loadConfig(h.paths, lock);
        expect(res.config.scanRoots).toHaveLength(1);
      } finally {
        await lock.release();
      }
      assertUntouched(before, await hashTree(copy));
    } finally {
      await removeFixtureCopy(copy);
    }
  });

  it("refuses WEBHUB_HOME inside a scan root", async () => {
    await writeFile(h.paths.config, JSON.stringify({ schemaVersion: 1, scanRoots: [h.root] }));
    await expect(loadConfig(h.paths)).rejects.toSatisfy((e) => isWebhubError(e, "CONFIG_INVALID"));
  });
});
