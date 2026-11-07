/**
 * Tests for F-001 review round 2 (N1–N3) and the round-1 minor/nit fixes.
 * See docs/reports/F-001/review-2.md, review-1.md, security-1.md.
 */
import { mkdir, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkConfig, defaultConfig, loadConfig } from "../../src/config/config.js";
import { ensureHome, type Paths } from "../../src/config/home.js";
import { isWebhubError, type WebhubError } from "../../src/errors.js";
import { isInside } from "../../src/fs/safe-path.js";
import { execFile, systemExe } from "../../src/proc/exec.js";
import { type DocSpec, readDoc, writeDoc } from "../../src/store/json-store.js";
import { acquireLock } from "../../src/store/lock.js";
import { dpapiBackend, type SecretBackend, SecretStore } from "../../src/store/secrets.js";
import { fakeLock, tempHome } from "../helpers/home.js";

let h: { root: string; paths: Paths; cleanup(): Promise<void> };
beforeEach(async () => {
  h = await tempHome();
  await mkdir(h.paths.data, { recursive: true });
});
afterEach(() => h.cleanup());

async function caught(p: Promise<unknown>): Promise<WebhubError> {
  try {
    await p;
  } catch (err) {
    if (isWebhubError(err)) return err;
    throw err;
  }
  throw new Error("expected a WebhubError");
}

const xor: SecretBackend = {
  name: "fake",
  protect: async (items) => items.map((b) => Buffer.from(b.map((v) => v ^ 0x5a))),
  unprotect: async (items) => items.map((b) => Buffer.from(b.map((v) => v ^ 0x5a))),
};
const CREDENTIAL = "postgres://admin:hunter2-very-secret@db";

describe("json-store minors (R6, S5, R11)", () => {
  const spec: DocSpec<{ schemaVersion: 1; a: number }> = {
    version: 1,
    schema: z.strictObject({ schemaVersion: z.literal(1), a: z.number() }),
    migrations: [],
  };
  const opts = () => ({ home: h.paths.home });

  it("accepts a UTF-8 BOM (PowerShell 5.1 Set-Content -Encoding utf8)", async () => {
    const file = join(h.paths.data, "bom.json");
    await writeFile(file, `﻿${JSON.stringify({ schemaVersion: 1, a: 1 })}`);
    expect((await readDoc(file, spec, opts()))?.value.a).toBe(1);
  });

  it("JSON_PARSE gives line/column and never quotes file content", async () => {
    const file = join(h.paths.data, "bad.json");
    await writeFile(file, `{\n  "schemaVersion": 1,\n  "DB_URL": ${CREDENTIAL}\n}`);
    const err = await caught(readDoc(file, spec, opts()));
    expect(err.code).toBe("JSON_PARSE");
    expect(err.message).toMatch(/line 3, column \d+/);
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain("hunter2");
  });

  it("a leftover tmp file from a crash does not affect the main file", async () => {
    const file = join(h.paths.data, "doc.json");
    await writeDoc(fakeLock(h.paths.home), file, { schemaVersion: 1, a: 1 });
    await writeFile(`${file}.tmp-deadbeef0000`, "{ partial");
    expect((await readDoc(file, spec, opts()))?.value.a).toBe(1);
    await writeDoc(fakeLock(h.paths.home), file, { schemaVersion: 1, a: 2 });
    expect((await readDoc(file, spec, opts()))?.value.a).toBe(2);
  });
});

describe("config minors (R8, R10, S7)", () => {
  it("errors show the received value, but never defaultEnv values", async () => {
    await writeFile(
      h.paths.config,
      JSON.stringify({
        schemaVersion: 1,
        maxDepth: 99,
        mode: "turbo",
        defaultEnv: { "1X": CREDENTIAL },
      }),
    );
    const err = await caught(loadConfig(h.paths));
    const text = err.details.join("\n");
    expect(text).toContain("(got 99)");
    expect(text).toContain('(got "turbo")');
    expect(text).not.toContain("hunter2");
  });

  it("runtimes.dir / profilesDir equal to home are rejected", async () => {
    const cases: object[] = [{ runtimes: { dir: "." } }, { profilesDir: ["./"] }];
    if (process.platform === "win32") {
      // same folder, different letter case (review-3 F2)
      cases.push({ runtimes: { dir: h.paths.home.toUpperCase() } });
    }
    for (const cfg of cases) {
      await writeFile(h.paths.config, JSON.stringify({ schemaVersion: 1, ...cfg }));
      expect((await caught(loadConfig(h.paths))).code).toBe("CONFIG_INVALID");
    }
  });

  it("a scan root that reaches WEBHUB_HOME through a junction is detected", async (ctx) => {
    await mkdir(h.paths.home, { recursive: true });
    const link = join(h.root, "alias");
    try {
      await symlink(h.paths.home, link, "junction");
    } catch {
      ctx.skip();
    }
    const err = await caught(checkConfig({ ...defaultConfig(), scanRoots: [link] }, h.paths));
    expect(err.details[0]).toMatch(/inside WEBHUB_HOME|inside a scan root/);
  });
});

describe("safe-path (R9)", () => {
  it("a child named ..foo is inside", () => {
    expect(isInside(h.root, join(h.root, "..foo"))).toBe(true);
    expect(isInside(h.root, join(h.root, ".."))).toBe(false);
  });
});

describe("secrets minors (S8, R12, S9)", { timeout: 60_000 }, () => {
  it("no .bak copy of secrets.json survives set/delete", async () => {
    const lock = fakeLock(h.paths.home);
    const s = await SecretStore.open(h.paths.secrets, h.paths.home, xor);
    await s.set(lock, "db/a", "first");
    await s.set(lock, "db/a", "second");
    await s.delete(lock, "db/a");
    expect((await readdir(h.paths.data)).filter((n) => n.startsWith("secrets.json."))).toEqual([]);
  });

  it("has() validates the key like get()", async () => {
    const s = await SecretStore.open(h.paths.secrets, h.paths.home, xor);
    expect(() => s.has("bad key")).toThrow(/invalid secret key/);
  });

  it("schema errors in secrets.json never echo values", async () => {
    await writeFile(
      h.paths.secrets,
      JSON.stringify({
        schemaVersion: 1,
        backend: "fake",
        entries: { "db/x": 42, "bad key": CREDENTIAL },
      }),
    );
    const err = await caught(SecretStore.open(h.paths.secrets, h.paths.home, xor));
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain("hunter2");
    expect(err.details.join("\n")).not.toContain("got");
  });

  it("DPAPI failure reports a real reason (not CLIXML)", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    const err = await caught(dpapiBackend.unprotect([Buffer.from("not dpapi")]));
    expect(err.details[0]).toMatch(/Exception/);
    expect(err.details[0]).not.toMatch(/CLIXML/);
  });
});

describe("systemExe (R5 / S6)", () => {
  it("refuses a SystemRoot that is not a full drive path", (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
    try {
      process.env.SystemRoot = "C:Windows";
      process.env.windir = "\\Windows";
      expect(() => systemExe("whoami.exe")).toThrow(/SystemRoot/);
      try {
        systemExe("whoami.exe");
      } catch (err) {
        expect(isWebhubError(err, "SYSTEM_TOOL")).toBe(true); // review-3 F6
      }
    } finally {
      process.env.SystemRoot = saved.SystemRoot;
      process.env.windir = saved.windir;
    }
  });
});

describe("lock guard (N3)", { timeout: 60_000 }, () => {
  it("a crashed takeover guard older than 30 s is broken; the lock is acquired", async () => {
    await writeFile(
      h.paths.lock,
      JSON.stringify({
        pid: 2 ** 22 + 7,
        startedAt: "x",
        hostname: (await import("node:os")).hostname(),
        token: "t",
      }),
    );
    const guard = `${h.paths.lock}.takeover`;
    await writeFile(guard, "123:old");
    const old = new Date(Date.now() - 60_000);
    await utimes(guard, old, old);
    const lock = await acquireLock(h.paths);
    expect(lock.held).toBe(true);
    await lock.release();
    expect((await readdir(h.paths.data)).filter((n) => n.startsWith(".lock"))).toEqual([]);
  });
});

describe("ensureHome tree audit (N1, N2)", { timeout: 120_000 }, () => {
  it("a junction inside the home is refused and the outside target is untouched", async (ctx) => {
    const outside = join(h.root, "outside");
    await mkdir(outside);
    const target = join(outside, "user-file.txt");
    await writeFile(target, "x");
    try {
      await symlink(outside, join(h.paths.data, "link"), "junction");
    } catch {
      ctx.skip();
    }
    const before =
      process.platform === "win32"
        ? (await execFile(systemExe("icacls.exe"), [target])).stdout
        : "";
    const err = await caught(ensureHome(h.paths));
    expect(err.code).toBe("SYMLINK_REFUSED");
    expect(err.details.join("\n")).toContain("link");
    if (process.platform === "win32") {
      expect((await execFile(systemExe("icacls.exe"), [target])).stdout).toBe(before);
    }
    expect(await readFile(target, "utf8")).toBe("x");
  });

  it("Windows: home ACL already exact but child with explicit Everyone → reset (no fast path without marker)", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    await ensureHome(h.paths);
    const f = join(h.paths.data, "secrets.json");
    await writeFile(f, "{}");
    const g = await execFile(systemExe("icacls.exe"), [f, "/grant", "*S-1-1-0:F"]);
    expect(g.code).toBe(0);
    await import("node:fs/promises").then((fs) => fs.rm(join(h.paths.home, ".webhub-secured")));
    await ensureHome(h.paths);
    expect((await execFile(systemExe("icacls.exe"), [f])).stdout).not.toMatch(/Everyone/i);
  });

  it("writes the audit marker; a second run takes the fast path", async () => {
    await ensureHome(h.paths);
    expect(await readFile(join(h.paths.home, ".webhub-secured"), "utf8")).toBe("1\n");
    const t = Date.now();
    await ensureHome(h.paths);
    expect(Date.now() - t).toBeLessThan(20_000);
  });
});

describe("jsonErrorIndex", () => {
  it("agrees with JSON.parse on valid/invalid inputs", async () => {
    const { jsonErrorIndex } = await import("../../src/fs/json-position.js");
    const valid = ['{"a":[1,-2.5e3,true,false,null,"x\\u00e9\\n"]}', "[]", " 0 ", '{"":{}}'];
    for (const t of valid) {
      expect(() => JSON.parse(t)).not.toThrow();
      expect(jsonErrorIndex(t)).toBe(-1);
    }
    const invalid: [string, number][] = [
      ["{,}", 1],
      ['{"a" 1}', 5],
      ["[1,]", 3],
      ["[1] x", 4],
      ['"\\q"', 1],
      ["", 0],
      ["01", 1],
    ];
    for (const [t, at] of invalid) expect(jsonErrorIndex(t)).toBe(at);
  });
});
