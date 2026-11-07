import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Paths } from "../../src/config/home.js";
import { isWebhubError } from "../../src/errors.js";
import { type DocSpec, MAX_FILE_BYTES, readDoc, writeDoc } from "../../src/store/json-store.js";
import { fakeLock, tempHome } from "../helpers/home.js";

const V2 = z.strictObject({ schemaVersion: z.literal(2), name: z.string(), port: z.number() });
type Doc = z.infer<typeof V2>;
const spec: DocSpec<Doc> = {
  version: 2,
  schema: V2,
  migrations: [
    { from: 0, migrate: (d) => ({ ...d, name: String(d.title ?? ""), title: undefined }) },
    { from: 1, migrate: (d) => ({ ...d, port: 80 }) },
  ],
};
const clean = (d: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
spec.migrations = spec.migrations.map((m) => ({
  from: m.from,
  migrate: (d) => clean(m.migrate(d)),
}));

let h: { paths: Paths; cleanup(): Promise<void> };
let file: string;
beforeEach(async () => {
  h = await tempHome();
  await mkdir(h.paths.data, { recursive: true });
  file = join(h.paths.data, "doc.json");
});
afterEach(() => h.cleanup());

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return isWebhubError(err) ? err.code : `other:${(err as Error).message}`;
  }
}

describe("writeDoc", () => {
  it("requires a held lock whose home contains the file", async () => {
    expect(await code(writeDoc(fakeLock(h.paths.home, false), file, {}))).toBe("NOT_LOCKED");
    // a lock of another home cannot write into this one
    expect(await code(writeDoc(fakeLock(join(tmpdir(), "other")), file, {}))).toBe(
      "PATH_OUTSIDE_HOME",
    );
  });

  it("writes atomically, keeps .bak, leaves no tmp files", async () => {
    const lock = fakeLock(h.paths.home);
    await writeDoc(lock, file, { schemaVersion: 2, name: "a", port: 1 });
    await writeDoc(lock, file, { schemaVersion: 2, name: "b", port: 2 });
    expect(JSON.parse(await readFile(file, "utf8")).name).toBe("b");
    expect(JSON.parse(await readFile(`${file}.bak`, "utf8")).name).toBe("a");
    expect((await readdir(h.paths.data)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("POSIX: written files are 0600", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    await writeDoc(fakeLock(h.paths.home), file, { a: 1 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses paths outside home", async () => {
    expect(await code(writeDoc(fakeLock(h.paths.home), join(tmpdir(), "x.json"), {}))).toBe(
      "PATH_OUTSIDE_HOME",
    );
  });

  it("refuses to write through a symlinked directory", async (ctx) => {
    const outside = join(h.paths.home, "..", "outside");
    await mkdir(outside);
    try {
      await symlink(outside, join(h.paths.data, "linked"), "junction");
    } catch {
      ctx.skip();
    }
    const target = join(h.paths.data, "linked", "x.json");
    expect(await code(writeDoc(fakeLock(h.paths.home), target, {}))).toBe("SYMLINK_REFUSED");
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses documents larger than the limit", async () => {
    const big = { s: "x".repeat(MAX_FILE_BYTES) };
    expect(await code(writeDoc(fakeLock(h.paths.home), file, big))).toBe("FILE_TOO_LARGE");
  });
});

describe("readDoc", () => {
  const opts = () => ({ home: h.paths.home, backupsDir: h.paths.backups });

  it("returns undefined for a missing file", async () => {
    expect(await readDoc(file, spec, opts())).toBeUndefined();
  });

  it("validates the current version", async () => {
    await writeFile(file, JSON.stringify({ schemaVersion: 2, name: "a", port: 1 }));
    expect((await readDoc(file, spec, opts()))?.value).toEqual({
      schemaVersion: 2,
      name: "a",
      port: 1,
    });
  });

  it("migrates step by step; without a lock the file is not changed", async () => {
    const original = JSON.stringify({ schemaVersion: 0, title: "old" });
    await writeFile(file, original);
    const res = await readDoc(file, spec, opts());
    expect(res).toEqual({ value: { schemaVersion: 2, name: "old", port: 80 }, migratedFrom: 0 });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("with a lock: backs up first, then writes the migrated document", async () => {
    const original = JSON.stringify({ schemaVersion: 1, name: "x" });
    await writeFile(file, original);
    await readDoc(file, spec, { ...opts(), lock: fakeLock(h.paths.home) });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schemaVersion: 2,
      name: "x",
      port: 80,
    });
    const [stamp] = await readdir(join(h.paths.backups, "migrate"));
    expect(await readFile(join(h.paths.backups, "migrate", stamp ?? "", "doc.json"), "utf8")).toBe(
      original,
    );
  });

  it("a migration that produces an invalid document leaves the file untouched", async () => {
    const bad: DocSpec<Doc> = {
      ...spec,
      migrations: [{ from: 1, migrate: (d) => ({ ...d, port: "no" }) }],
    };
    const original = JSON.stringify({ schemaVersion: 1, name: "x" });
    await writeFile(file, original);
    expect(await code(readDoc(file, bad, { ...opts(), lock: fakeLock(h.paths.home) }))).toBe(
      "CONFIG_INVALID",
    );
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("newer schemaVersion → CONFIG_FROM_NEWER_VERSION and file unchanged", async () => {
    const original = JSON.stringify({ schemaVersion: 3, name: "future", port: 1, extra: true });
    await writeFile(file, original);
    expect(await code(readDoc(file, spec, { ...opts(), lock: fakeLock(h.paths.home) }))).toBe(
      "CONFIG_FROM_NEWER_VERSION",
    );
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it.each([
    ["not json", "JSON_PARSE"],
    ["[1,2]", "CONFIG_INVALID"],
    ['{"name":"no version"}', "CONFIG_INVALID"],
    ['{"schemaVersion":2,"name":"a","port":1,"unknown":1}', "CONFIG_INVALID"],
  ])("rejects %s", async (text, expected) => {
    await writeFile(file, text);
    expect(await code(readDoc(file, spec, opts()))).toBe(expected);
  });

  it("rejects files over the size limit", async () => {
    await writeFile(file, " ".repeat(MAX_FILE_BYTES + 1));
    expect(await code(readDoc(file, spec, opts()))).toBe("FILE_TOO_LARGE");
  });

  it("refuses a symlinked file", async (ctx) => {
    const outside = join(h.paths.home, "..", "real.json");
    await writeFile(outside, JSON.stringify({ schemaVersion: 2, name: "a", port: 1 }));
    try {
      await symlink(outside, file, "file");
    } catch {
      ctx.skip();
    }
    expect(await code(readDoc(file, spec, opts()))).toBe("SYMLINK_REFUSED");
  });
});
