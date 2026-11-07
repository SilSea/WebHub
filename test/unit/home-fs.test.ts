import { chmod, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureHome, pathsFor } from "../../src/config/home.js";
import { isWebhubError } from "../../src/errors.js";
import { assertSafePath, isInside } from "../../src/fs/safe-path.js";
import { execFile, systemExe } from "../../src/proc/exec.js";
import { tempHome } from "../helpers/home.js";

let h: Awaited<ReturnType<typeof tempHome>>;
beforeEach(async () => {
  h = await tempHome();
});
afterEach(() => h.cleanup());

describe("isInside / assertSafePath", () => {
  it("isInside handles prefixes and parents", () => {
    expect(isInside(h.root, join(h.root, "a"))).toBe(true);
    expect(isInside(h.root, h.root)).toBe(true);
    expect(isInside(join(h.root, "a"), join(h.root, "ab"))).toBe(false);
    expect(isInside(join(h.root, "a"), h.root)).toBe(false);
  });

  it("allows missing components, refuses outside + symlinks", async (ctx) => {
    await mkdir(h.paths.home, { recursive: true });
    await expect(
      assertSafePath(h.paths.home, join(h.paths.home, "x", "y")),
    ).resolves.toBeUndefined();
    await expect(assertSafePath(h.paths.home, join(h.paths.home, "..", "z"))).rejects.toSatisfy(
      (e) => isWebhubError(e, "PATH_OUTSIDE_HOME"),
    );
    try {
      await symlink(h.root, join(h.paths.home, "link"), "junction");
    } catch {
      ctx.skip();
    }
    await expect(assertSafePath(h.paths.home, join(h.paths.home, "link", "f"))).rejects.toSatisfy(
      (e) => isWebhubError(e, "SYMLINK_REFUSED"),
    );
  });
});

describe("ensureHome", { timeout: 30_000 }, () => {
  it("creates the layout", async () => {
    await ensureHome(h.paths);
    for (const d of [h.paths.data, h.paths.backups, h.paths.logs, h.paths.runtimes]) {
      expect((await stat(d)).isDirectory()).toBe(true);
    }
    await ensureHome(h.paths); // idempotent
  });

  it("POSIX: home is 0700", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    await ensureHome(h.paths);
    expect((await stat(h.paths.home)).mode & 0o777).toBe(0o700);
  });

  it("Windows: ACL has no inheritance and only user + SYSTEM", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    await ensureHome(h.paths);
    const res = await execFile(systemExe("icacls.exe"), [h.paths.home]);
    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.replace(h.paths.home, "").trim())
      .filter((l) => l !== "" && !l.startsWith("Successfully"));
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toMatch(/\(I\)/);
    expect(lines.join("\n")).not.toMatch(/Everyone|Users|Authenticated/i);
  });

  it("Windows: a pre-existing child with its own permissive ACL is reset", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    await mkdir(h.paths.data, { recursive: true });
    await writeFile(join(h.paths.data, "secrets.json"), "{}");
    const grant = await execFile(systemExe("icacls.exe"), [
      h.paths.data,
      "/inheritance:r",
      "/grant:r",
      "*S-1-1-0:(OI)(CI)F",
    ]);
    expect(grant.code).toBe(0);
    await ensureHome(h.paths);
    for (const p of [h.paths.data, join(h.paths.data, "secrets.json")]) {
      const out = (await execFile(systemExe("icacls.exe"), [p])).stdout;
      expect(out).not.toMatch(/Everyone/i);
    }
  });

  it("POSIX: group/other bits are stripped from existing children", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    await mkdir(h.paths.data, { recursive: true, mode: 0o777 });
    const f = join(h.paths.data, "secrets.json");
    await writeFile(f, "{}", { mode: 0o666 });
    await chmod(h.paths.home, 0o755);
    await chmod(h.paths.data, 0o777);
    await chmod(f, 0o666);
    await ensureHome(h.paths);
    expect((await stat(h.paths.data)).mode & 0o077).toBe(0);
    expect((await stat(f)).mode & 0o077).toBe(0);
  });

  it("refuses a symlinked home and a file home", async (ctx) => {
    const file = join(h.root, "file-home");
    await writeFile(file, "x");
    await expect(ensureHome(pathsFor(file))).rejects.toSatisfy((e) =>
      isWebhubError(e, "HOME_INVALID"),
    );
    const target = join(h.root, "real");
    await mkdir(target);
    const link = join(h.root, "linked-home");
    try {
      await symlink(target, link, "junction");
    } catch {
      ctx.skip();
    }
    await expect(ensureHome(pathsFor(link))).rejects.toSatisfy((e) =>
      isWebhubError(e, "SYMLINK_REFUSED"),
    );
  });
});
