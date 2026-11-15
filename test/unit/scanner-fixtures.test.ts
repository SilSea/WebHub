/**
 * F-006 against the fixtures (spec §8 rows 1, 2, 6): expected kind / profile / runner / port /
 * publicDir per folder; every fixture copy is untouched afterwards (Zero-touch).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Paths } from "../../src/config/home.js";
import { scan } from "../../src/scanner/scan.js";
import { ScanResult } from "../../src/scanner/schema.js";
import { assertUntouched, copyFixture, hashTree, removeFixtureCopy } from "../helpers/fixture.js";
import { tempHome } from "../helpers/home.js";

let h: { paths: Paths; cleanup(): Promise<void> };
beforeAll(async () => {
  h = await tempHome();
});
afterAll(() => h.cleanup());

/** Scans a copy of `fixture` (the copy is the scan root); asserts Zero-touch. */
async function scanFixture(fixture: string, prepare?: (dir: string) => void) {
  const dir = await copyFixture(fixture);
  try {
    prepare?.(dir);
    const before = await hashTree(dir);
    const r = await scan(h.paths, { scanRoots: [dir] });
    assertUntouched(before, await hashTree(dir));
    expect(ScanResult.safeParse(r).success).toBe(true);
    expect(r.truncated).toBe(false);
    const rel = (p: string) => p.slice(dir.length + 1).replaceAll("\\", "/") || ".";
    return { r, dir, rows: r.candidates.map((c) => ({ ...c, rel: rel(c.path) })) };
  } finally {
    await removeFixtureCopy(dir);
  }
}

// copies + hashes + a scan each: give a loaded machine room (CR-004 lesson)
describe("single-project fixtures", { timeout: 30_000 }, () => {
  it.each([
    ["static-basic", "static", "static", undefined],
    ["static-spa-basic", "static-spa", "static", undefined],
    ["vite-basic", "vite", "native", { value: 5173, via: "arg", source: "vite.config.js" }],
    [
      "next-basic",
      "next",
      "native",
      { value: 3001, via: "arg", source: "package.json scripts.dev" },
    ],
    [
      "express-basic",
      "express",
      "native",
      { value: 3000, via: "env", env: "PORT", source: "profile express" },
    ],
    [
      "bun-elysia-basic",
      "bun-elysia",
      "native",
      { value: 3000, via: "env", env: "PORT", source: "profile bun-elysia" },
    ],
    ["fastapi-basic", "fastapi", "native", { value: 8000, via: "arg", source: "profile fastapi" }],
  ] as const)("%s → %s / %s", async (fixture, profile, runner, port) => {
    const { rows } = await scanFixture(fixture);
    expect(rows).toHaveLength(1);
    const c = rows[0];
    expect(c?.rel).toBe(".");
    expect(c?.kind).toBe("site");
    expect(c?.profile).toBe(profile);
    expect(c?.runner).toBe(runner);
    expect(c?.name).toBe(fixture);
    expect(c?.services.app?.port).toEqual(port);
    if (runner === "static") expect(c?.services.app?.publicDir).toBe("");
  });
});

describe("multi-folder fixtures", { timeout: 30_000 }, () => {
  it("compose build → compose; container port fixed; infra listed; no env values", async () => {
    const { rows } = await scanFixture("compose-build");
    const c = rows[0];
    expect(c?.runner).toBe("compose");
    expect(c?.compose).toEqual({
      files: ["docker-compose.yml"],
      app: ["api"],
      infra: ["db"],
      mountsSource: false,
    });
    expect(c?.services.app?.port).toEqual({
      value: 3000,
      via: "fixed",
      source: "compose api 3200:3000",
    });
    expect(c?.services.app?.runtime).toContainEqual({
      lang: "docker",
      hint: "oven/bun:1.2 (hint)",
      source: "Dockerfile FROM",
    });
    expect(JSON.stringify(rows)).not.toContain("fixture-not-a-secret");
  });

  it("compose with anchors + source mount → hybrid", async () => {
    const { rows } = await scanFixture("compose-hybrid");
    expect(rows[0]?.profile).toBe("vite");
    expect(rows[0]?.runner).toBe("hybrid");
    expect(rows[0]?.compose?.infra).toEqual(["db", "cache"]);
    expect(rows[0]?.compose?.mountsSource).toBe(true);
  });

  it("frontend + backend folders → one site, two services", async () => {
    const { rows } = await scanFixture("monorepo-split");
    expect(rows.map((c) => c.rel)).toEqual(["."]);
    const c = rows[0];
    expect(c?.kind).toBe("site");
    expect(c?.name).toBe("monorepo-split");
    expect(Object.keys(c?.services ?? {}).sort()).toEqual(["backend", "frontend"]);
    expect(c?.services.frontend).toMatchObject({
      cwd: "frontend",
      profile: "vite",
      port: { value: 5174, via: "arg" },
    });
    expect(c?.services.backend).toMatchObject({ cwd: "backend", profile: "express" });
  });

  it("compose at the monorepo root → runner compose, files from the parent (review-1 C4)", async () => {
    const { rows } = await scanFixture("monorepo-compose");
    expect(rows.map((c) => c.rel)).toEqual(["."]);
    const c = rows[0];
    expect(c?.runner).toBe("compose");
    expect(c?.compose).toEqual({
      files: ["docker-compose.yml"],
      app: ["web", "api"],
      infra: ["db"],
      mountsSource: false,
    });
    expect(Object.keys(c?.services ?? {}).sort()).toEqual(["backend", "frontend"]);
  });

  it("a copy inside another project → duplicate of the original; names prefer sites", async () => {
    const { rows } = await scanFixture("nested-duplicate");
    const by = Object.fromEntries(rows.map((c) => [c.rel, c]));
    expect(by.main?.kind).toBe("site");
    expect(by.main?.name).toBe("main");
    expect(by.hobby?.kind).toBe("site");
    expect(by["hobby/project/main"]?.kind).toBe("duplicate");
    expect(by["hobby/project/main"]?.duplicateOf).toBe(by.main?.key);
    expect(by["hobby/project/main"]?.name).toBe("main-2");
  });

  it("not-web markers win over profile matches", async () => {
    const { rows } = await scanFixture("not-web-cases");
    const by = Object.fromEntries(rows.map((c) => [c.rel, c]));
    expect(by.extension?.kind).toBe("not-web");
    expect(by.extension?.notWeb).toEqual(["browser extension (manifest.json)"]);
    expect(by.unity?.notWeb).toEqual(["Unity project (ProjectSettings/)"]);
    expect(by.electron?.notWeb).toEqual(["desktop app (dep electron)"]);
    expect(by.pyscript?.notWeb).toEqual(["Python without a web framework"]);
    for (const c of rows) {
      expect(c.kind).toBe("not-web");
      expect(c.runner).toBeUndefined();
      expect(c.services).toEqual({});
    }
  });

  it(".env: the port is used, no other value is kept (Q5)", async () => {
    const { r, rows } = await scanFixture("express-basic", (dir) => {
      writeFileSync(
        join(dir, ".env"),
        "SESSION_SECRET=fixture-secret-value-xyz\nDATABASE_URL=postgres://u:pw-xyz@h/d\nPORT=4321\n",
      );
    });
    expect(rows[0]?.services.app?.port).toEqual({
      value: 4321,
      via: "env",
      env: "PORT",
      source: ".env PORT",
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain("fixture-secret-value-xyz");
    expect(text).not.toContain("pw-xyz");
  });

  it("the whole fixtures folder in one scan: every project once, stable keys", async () => {
    const all = [
      "static-basic",
      "vite-basic",
      "monorepo-split",
      "nested-duplicate",
      "not-web-cases",
    ];
    const dirs = await Promise.all(all.map((f) => copyFixture(f)));
    try {
      const a = await scan(h.paths, { scanRoots: dirs });
      const b = await scan(h.paths, { scanRoots: dirs });
      expect(a.candidates.map((c) => c.key)).toEqual(b.candidates.map((c) => c.key));
      expect(new Set(a.candidates.map((c) => c.name)).size).toBe(a.candidates.length);
      expect(a.candidates.filter((c) => c.kind === "site")).toHaveLength(5);
    } finally {
      await Promise.all(dirs.map(removeFixtureCopy));
    }
  });
});
