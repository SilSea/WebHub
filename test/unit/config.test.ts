import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkConfig,
  defaultConfig,
  loadConfig,
  resolveInHome,
  saveConfig,
} from "../../src/config/config.js";
import type { Paths } from "../../src/config/home.js";
import { type Config, configJsonSchema } from "../../src/config/schema.js";
import { isWebhubError, type WebhubError } from "../../src/errors.js";
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

const writeConfig = (obj: unknown) => writeFile(h.paths.config, JSON.stringify(obj));

describe("defaults", () => {
  it("cover every key with design values", () => {
    const c = defaultConfig();
    expect(c.mode).toBe("auto");
    expect(c.ports).toEqual({
      web: [4100, 4999],
      isolatedInfra: [14100, 14999],
      pinnedInfra: [15000, 15999],
    });
    expect(c.infra.postgres).toMatchObject({ default: "17", policy: "latest" });
    expect(c.infra.redis).toMatchObject({ default: "7", flavor: "redis" });
    expect(c.runtimes.verifyChecksum).toBe(true);
    expect(c.reservedNames).toContain("hub");
  });

  it("missing file → defaults in memory, nothing written", async () => {
    const res = await loadConfig(h.paths);
    expect(res.isDefault).toBe(true);
    expect(res.config).toEqual(defaultConfig());
    await expect(readFile(h.paths.config)).rejects.toThrow();
  });

  it("JSON schema export is generated", () => {
    const js = configJsonSchema() as { properties?: Record<string, unknown> };
    expect(Object.keys(js.properties ?? {})).toContain("scanRoots");
  });
});

describe("validation (no start + list every error)", () => {
  it("lists all problems with key paths", async () => {
    await writeConfig({
      schemaVersion: 1,
      mode: "turbo",
      maxDepth: 99,
      ports: { web: [5000, 4000] },
      scanRoots: ["relative/path"],
      typo: true,
    });
    const err = await caught(loadConfig(h.paths));
    expect(err.code).toBe("CONFIG_INVALID");
    const text = err.details.join("\n");
    for (const key of ["mode", "maxDepth", "ports.web", "scanRoots.0", "typo"]) {
      expect(text).toContain(key);
    }
  });

  it("rejects bad domain labels and env names", async () => {
    await writeConfig({ schemaVersion: 1, domainSuffix: "Bad_Host", defaultEnv: { "1X": "a" } });
    const err = await caught(loadConfig(h.paths));
    expect(err.details.join("\n")).toMatch(/domainSuffix/);
    expect(err.details.join("\n")).toMatch(/defaultEnv/);
  });

  it("paths must stay inside home", async () => {
    await writeConfig({ schemaVersion: 1, runtimes: { dir: "../../escape" } });
    const err = await caught(loadConfig(h.paths));
    expect(err.details.join("\n")).toMatch(/runtimes\.dir/);
    expect(() => resolveInHome(h.paths.home, "./runtimes", "k")).not.toThrow();
  });

  it("home inside a scan root, or scan root inside home, is rejected", async () => {
    const c1: Config = { ...defaultConfig(), scanRoots: [h.root] };
    expect((await caught(checkConfig(c1, h.paths))).details[0]).toMatch(
      /must not be inside a scan root/,
    );
    const c2: Config = { ...defaultConfig(), scanRoots: [h.paths.data] };
    expect((await caught(checkConfig(c2, h.paths))).details[0]).toMatch(/inside WEBHUB_HOME/);
  });

  it("missing scan root is a warning; a file is an error", async () => {
    const elsewhere = join(h.root, "..", `wh-missing-${Date.now()}`);
    expect(await checkConfig({ ...defaultConfig(), scanRoots: [elsewhere] }, h.paths)).toHaveLength(
      1,
    );
    const file = join(h.root, "..", `wh-file-${Date.now()}`);
    await writeFile(file, "x");
    const err = await caught(checkConfig({ ...defaultConfig(), scanRoots: [file] }, h.paths));
    expect(err.details[0]).toMatch(/not a directory/);
  });

  it("newer config version is refused and untouched", async () => {
    const text = JSON.stringify({ schemaVersion: 2, future: 1 });
    await writeFile(h.paths.config, text);
    expect((await caught(loadConfig(h.paths, fakeLock(h.paths.home)))).code).toBe(
      "CONFIG_FROM_NEWER_VERSION",
    );
    expect(await readFile(h.paths.config, "utf8")).toBe(text);
  });
});

describe("save", () => {
  it("round-trips and requires the lock", async () => {
    const scan = join(h.root, "projects");
    await mkdir(scan);
    const c: Config = { ...defaultConfig(), scanRoots: [scan], locale: "en" };
    expect((await caught(saveConfig(fakeLock(h.paths.home, false), h.paths, c))).code).toBe(
      "NOT_LOCKED",
    );
    await saveConfig(fakeLock(h.paths.home), h.paths, c);
    const res = await loadConfig(h.paths);
    expect(res.isDefault).toBe(false);
    expect(res.config).toEqual(c);
    expect(res.warnings).toEqual([]);
  });

  it("refuses to save an invalid config", async () => {
    const bad = { ...defaultConfig(), maxDepth: 0 } as Config;
    expect((await caught(saveConfig(fakeLock(h.paths.home), h.paths, bad))).code).toBe(
      "CONFIG_INVALID",
    );
    await expect(readFile(h.paths.config)).rejects.toThrow();
  });
});
