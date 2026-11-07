import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Paths } from "../../src/config/home.js";
import { isWebhubError } from "../../src/errors.js";
import {
  dpapiBackend,
  generateSecret,
  type SecretBackend,
  SecretStore,
} from "../../src/store/secrets.js";
import { fakeLock, tempHome } from "../helpers/home.js";

/** Reversible test backend: byte-wise XOR (never used outside tests). */
const fake = (name = "fake"): SecretBackend => {
  const x = (items: readonly Buffer[]) =>
    Promise.resolve(items.map((b) => Buffer.from(b.map((v) => v ^ 0x5a))));
  return { name, protect: x, unprotect: x };
};

let h: { paths: Paths; cleanup(): Promise<void> };
beforeEach(async () => {
  h = await tempHome();
  await mkdir(h.paths.data, { recursive: true });
});
afterEach(() => h.cleanup());

const open = (backend: SecretBackend = fake()) =>
  SecretStore.open(h.paths.secrets, h.paths.home, backend);
const SECRET = "s3cr3t-pa55word-🔑";

describe("SecretStore", () => {
  it("set/get/delete persist across reopen; file has no plaintext", async () => {
    const lock = fakeLock(h.paths.home);
    const s = await open();
    await s.set(lock, "db/postgres", SECRET);
    await s.set(lock, "app/API_KEY", "k2");
    expect(s.get("db/postgres")).toBe(SECRET);
    const raw = await readFile(h.paths.secrets, "utf8");
    expect(raw).not.toContain(SECRET);
    expect(JSON.parse(raw).backend).toBe("fake");
    expect(Object.keys(JSON.parse(raw).entries)).toEqual(["app/API_KEY", "db/postgres"]);

    const s2 = await open();
    expect(s2.size).toBe(2);
    expect(s2.get("db/postgres")).toBe(SECRET);
    await s2.delete(lock, "db/postgres");
    expect((await open()).has("db/postgres")).toBe(false);
  });

  it("never prints values", async () => {
    const s = await open();
    await s.set(fakeLock(h.paths.home), "db/x", SECRET);
    expect(inspect(s)).toBe("[SecretStore: 1 secrets]");
    expect(JSON.stringify({ s })).not.toContain(SECRET);
    expect(String(inspect(s, { showHidden: true, depth: 5 }))).not.toContain(SECRET);
  });

  it("writes require the lock; state unchanged on failure", async () => {
    const s = await open();
    await expect(s.set(fakeLock(h.paths.home, false), "db/x", "v")).rejects.toSatisfy((e) =>
      isWebhubError(e, "NOT_LOCKED"),
    );
    expect(s.has("db/x")).toBe(false);
  });

  it("validates keys", async () => {
    const s = await open();
    for (const key of ["", "nokey", "../x/y", "a/b/c", "A/b", "a/ b"]) {
      await expect(s.set(fakeLock(h.paths.home), key, "v")).rejects.toThrow(/invalid secret key/);
    }
  });

  it("backend mismatch is refused", async () => {
    await (await open(fake("one"))).set(fakeLock(h.paths.home), "db/x", "v");
    await expect(open(fake("two"))).rejects.toSatisfy((e) => isWebhubError(e, "SECRET_BACKEND"));
  });

  it("tampered file is rejected by schema", async () => {
    await writeFile(
      h.paths.secrets,
      JSON.stringify({ schemaVersion: 1, backend: "fake", entries: { "bad key": "x" } }),
    );
    await expect(open()).rejects.toSatisfy((e) => isWebhubError(e, "CONFIG_INVALID"));
  });

  it("generateSecret: random, url-safe, min size", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(a);
    expect(() => generateSecret(8)).toThrow(RangeError);
  });
});

describe("DPAPI backend", { timeout: 60_000 }, () => {
  it("round-trips on Windows; output differs from input", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    const items = [Buffer.from(SECRET), Buffer.from("second"), Buffer.alloc(0)];
    const enc = await dpapiBackend.protect(items);
    expect(enc).toHaveLength(3);
    expect(enc[0]?.includes(Buffer.from(SECRET))).toBe(false);
    const dec = await dpapiBackend.unprotect(enc);
    expect(dec.map((b) => b.toString())).toEqual([SECRET, "second", ""]);
  });

  it("garbage ciphertext → SECRET_BACKEND", async (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    await expect(dpapiBackend.unprotect([Buffer.from("not dpapi")])).rejects.toSatisfy((e) =>
      isWebhubError(e, "SECRET_BACKEND"),
    );
  });

  it("non-Windows → SECRET_BACKEND", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    await expect(dpapiBackend.protect([Buffer.from("x")])).rejects.toSatisfy((e) =>
      isWebhubError(e, "SECRET_BACKEND"),
    );
  });
});
