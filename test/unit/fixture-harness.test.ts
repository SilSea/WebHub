import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoSymlinks,
  assertUntouched,
  copyFixture,
  FIXTURES_ROOT,
  hashTree,
  isInside,
  removeFixtureCopy,
} from "../helpers/fixture.js";

const copies: string[] = [];
async function copy(): Promise<string> {
  const dir = await copyFixture("vite-basic");
  copies.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of copies.splice(0)) await removeFixtureCopy(dir);
});

describe("fixture harness", () => {
  it("copy is outside fixtures/ and identical to the source", async () => {
    const dir = await copy();
    expect(isInside(FIXTURES_ROOT, dir)).toBe(false);
    const src = await hashTree(join(FIXTURES_ROOT, "vite-basic"));
    expect(await hashTree(dir)).toEqual(src);
  });

  it("untouched copy passes", async () => {
    const dir = await copy();
    const before = await hashTree(dir);
    expect(() => assertUntouched(before, new Map())).toThrow();
    const again = await hashTree(dir);
    expect(() => assertUntouched(before, again)).not.toThrow();
  });

  it("reports added, removed and changed files", async () => {
    const dir = await copy();
    const before = await hashTree(dir);
    await writeFile(join(dir, "new.txt"), "x");
    await rm(join(dir, "index.html"));
    await appendFile(join(dir, "package.json"), " ");
    const after = await hashTree(dir);
    expect(() => assertUntouched(before, after)).toThrow(
      /\+ new\.txt[\s\S]*- index\.html[\s\S]*~ package\.json/,
    );
  });

  it("detects a change in a nested file", async () => {
    const dir = await copy();
    const before = await hashTree(dir);
    await writeFile(join(dir, "src", "main.js"), "changed");
    await expect(hashTree(dir).then((t) => assertUntouched(before, t))).rejects.toThrow(
      /~ src\/main\.js/,
    );
  });

  it("ignores allowlisted top-level dirs the project creates itself", async () => {
    const dir = await copy();
    const opts = { ignore: ["node_modules", "dist"] };
    const before = await hashTree(dir, opts);
    await mkdir(join(dir, "node_modules", "vite"), { recursive: true });
    await writeFile(join(dir, "node_modules", "vite", "index.js"), "x");
    await mkdir(join(dir, "dist"));
    const tree = await hashTree(dir, opts);
    expect(() => assertUntouched(before, tree)).not.toThrow();
    // without the allowlist the same change is a violation
    const strictBefore = new Map([...before]);
    const strictAfter = await hashTree(dir);
    expect(() => assertUntouched(strictBefore, strictAfter)).toThrow(/\+ node_modules/);
  });

  it("detects a permission change (read-only / mode bits)", async () => {
    const dir = await copy();
    const before = await hashTree(dir);
    await chmod(join(dir, "index.html"), 0o444);
    await expect(hashTree(dir).then((t) => assertUntouched(before, t))).rejects.toThrow(
      /~ index\.html/,
    );
    await chmod(join(dir, "index.html"), 0o644);
  });

  it("does not follow symlinks", async (ctx) => {
    const dir = await copy();
    try {
      await symlink(tmpdir(), join(dir, "link"), "junction");
    } catch {
      ctx.skip(); // symlinks not permitted on this machine
    }
    const tree = await hashTree(dir);
    expect(tree.get("link")).toMatch(/^link:/);
    expect([...tree.keys()].some((k) => k.startsWith("link/"))).toBe(false);
  });
});

describe("fixture harness — security", () => {
  it.each(["../package", "..", "/etc", "a/b", "C:\\x", "", "Vite"])(
    "rejects fixture name %j",
    async (name) => {
      await expect(copyFixture(name)).rejects.toThrow(/invalid fixture name/);
    },
  );

  it("rejects a missing fixture before creating any temp dir", async () => {
    // a private temp dir for this worker: other test files copy fixtures at the same time, so
    // counting `webhub-fx-*` in the shared temp dir raced with them (CR-005). Changing
    // process.env relies on per-file process isolation (forks pool): keep this file's tests
    // sequential, not `concurrent` (CR-005 review-1 n1). Checks "no leftover dir" only: a dir
    // made and removed again on error is not seen (review-1 m2).
    const own = await mkdtemp(join(tmpdir(), "webhub-fxtmp-"));
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    try {
      process.env.TEMP = own;
      process.env.TMP = own;
      process.env.TMPDIR = own;
      expect(tmpdir()).toBe(own);
      await expect(copyFixture("does-not-exist")).rejects.toThrow(/fixture not found/);
      expect(await readdir(own)).toEqual([]);
      // positive control: a real copy lands in `own`, so the empty check above means something
      // (it would pass vacuously if the helper cached the temp dir — review-1 m1)
      const copy = await copyFixture("vite-basic");
      expect(copy.startsWith(own)).toBe(true);
      await removeFixtureCopy(copy);
      expect(await readdir(own)).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(own, { recursive: true, force: true });
    }
  });

  it("rejects a fixture dir that is itself a symlink/junction", async (ctx) => {
    const root = await mkdtemp(join(tmpdir(), "webhub-fxroot-"));
    try {
      await mkdir(join(root, "real"));
      await writeFile(join(root, "real", "a.txt"), "a");
      try {
        await symlink(join(root, "real"), join(root, "linked"), "junction");
      } catch {
        ctx.skip();
      }
      await expect(copyFixture("linked", root)).rejects.toThrow(/must not contain symlinks/);
      const ok = await copyFixture("real", root);
      copies.push(ok);
      expect(isInside(root, ok)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects fixtures that contain symlinks", async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), "webhub-fxsrc-"));
    try {
      try {
        await symlink(tmpdir(), join(dir, "escape"), "junction");
      } catch {
        ctx.skip();
      }
      await expect(assertNoSymlinks(dir)).rejects.toThrow(/must not contain symlinks/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to remove anything but a fixture temp copy", async () => {
    await expect(removeFixtureCopy(join(FIXTURES_ROOT, "vite-basic"))).rejects.toThrow(/refusing/);
    await expect(removeFixtureCopy(join(tmpdir(), "x"))).rejects.toThrow(/refusing/);
  });

  it("isInside handles traversal and siblings", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/../c")).toBe(false);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
  });
});
