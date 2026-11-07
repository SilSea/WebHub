/** Tests for F-001 review round 3 (F1, F5). See docs/reports/F-001/review-3.md. */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ensureHome, type Paths } from "../../src/config/home.js";
import { isWebhubError } from "../../src/errors.js";
import { execFile, systemExe } from "../../src/proc/exec.js";
import { type DocSpec, readDoc } from "../../src/store/json-store.js";
import { tempHome } from "../helpers/home.js";

let h: { root: string; paths: Paths; cleanup(): Promise<void> };
beforeEach(async () => {
  h = await tempHome();
});
afterEach(() => h.cleanup());

describe("F1: an existing home with a loose ACL is locked before the audit", {
  timeout: 120_000,
}, () => {
  it("Windows: pre-existing home (inherited ACL) + child → home protected, child inherits only", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    await mkdir(join(h.paths.home, "data"), { recursive: true }); // made outside webhub: inherits temp ACL
    await ensureHome(h.paths);
    const home = (await execFile(systemExe("icacls.exe"), [h.paths.home])).stdout;
    expect(home).not.toMatch(/\(I\)/);
    const child = (await execFile(systemExe("icacls.exe"), [h.paths.data])).stdout;
    const entries = child
      .split(/\r?\n/)
      .map((l) => l.replace(h.paths.data, "").trim())
      .filter((l) => l !== "" && !/^Successfully/.test(l));
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e).toMatch(/\(I\)/);
  });
});

describe("G1/G3: an existing folder that is not a webhub home is refused untouched", {
  timeout: 120_000,
}, () => {
  it("foreign content → HOME_INVALID, ACL and content unchanged; checks run before any restrict", async () => {
    await mkdir(h.paths.home, { recursive: true });
    await writeFile(join(h.paths.home, "notes.txt"), "mine");
    const acl = async () =>
      process.platform === "win32"
        ? (await execFile(systemExe("icacls.exe"), [h.paths.home])).stdout
        : String((await import("node:fs/promises").then((f) => f.stat(h.paths.home))).mode);
    const before = await acl();
    try {
      await ensureHome(h.paths);
      expect.unreachable();
    } catch (err) {
      expect(isWebhubError(err, "HOME_INVALID")).toBe(true);
      if (isWebhubError(err)) expect(err.details).toContain("notes.txt");
    }
    expect(await acl()).toBe(before);
    expect((await readdir(h.paths.home)).sort()).toEqual(["notes.txt"]);
  });

  it("an empty existing folder or webhub layout is accepted", async () => {
    await mkdir(join(h.paths.home, "data"), { recursive: true });
    await writeFile(h.paths.config, "{}");
    await expect(ensureHome(h.paths)).resolves.toBeUndefined();
  });
});

describe("F5: parse errors", () => {
  const spec: DocSpec<unknown> = { version: 1, schema: z.unknown(), migrations: [] };

  it("very deep nesting: no bogus position", async () => {
    await mkdir(h.paths.data, { recursive: true });
    const file = join(h.paths.data, "deep.json");
    await writeFile(file, `${"[".repeat(200_000)}x`);
    try {
      await readDoc(file, spec, { home: h.paths.home });
      expect.unreachable();
    } catch (err) {
      expect(isWebhubError(err, "JSON_PARSE")).toBe(true);
      expect((err as Error).message).not.toMatch(/line 1, column 1$/);
    }
  });

  it("secrets-like (sensitive) docs do not point to a .bak", async () => {
    await mkdir(h.paths.data, { recursive: true });
    const file = join(h.paths.data, "s.json");
    await writeFile(file, "{bad");
    try {
      await readDoc(file, { ...spec, sensitive: true }, { home: h.paths.home });
      expect.unreachable();
    } catch (err) {
      expect(isWebhubError(err, "JSON_PARSE")).toBe(true);
      if (isWebhubError(err)) expect(err.hint).not.toMatch(/\.bak/);
    }
  });
});
