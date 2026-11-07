import { appendFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
    expect(() => assertUntouched(before, new Map(before))).not.toThrow();
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

  it("does not follow symlinks", async () => {
    const dir = await copy();
    try {
      await symlink(tmpdir(), join(dir, "link"), "junction");
    } catch {
      return; // symlinks not permitted on this machine
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
