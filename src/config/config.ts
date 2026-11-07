import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { WebhubError } from "../errors.js";
import { isInside } from "../fs/safe-path.js";
import { type DocSpec, readDoc, validate, writeDoc } from "../store/json-store.js";
import type { Lock } from "../store/lock.js";
import type { Paths } from "./home.js";
import { CONFIG_VERSION, type Config, ConfigSchema } from "./schema.js";

export const configSpec: DocSpec<Config> = {
  version: CONFIG_VERSION,
  schema: ConfigSchema,
  migrations: [],
};

export interface LoadedConfig {
  config: Config;
  /** Non-fatal problems (e.g. a scan root that does not exist yet). */
  warnings: string[];
  /** True when no config file exists yet (defaults in memory; nothing written). */
  isDefault: boolean;
  migratedFrom?: number;
}

export function defaultConfig(): Config {
  return validate(ConfigSchema, { schemaVersion: CONFIG_VERSION });
}

/**
 * Resolves a config path (relative = relative to home) and requires it to be strictly inside
 * home (never the home itself: a later "clean <dir>" must not be able to wipe the home).
 */
export function resolveInHome(home: string, p: string, key: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(home, p);
  if (!isInside(home, abs) || resolve(home) === abs) {
    throw new WebhubError("CONFIG_INVALID", `${key} must be inside WEBHUB_HOME: ${p}`, {
      details: [`${key}: resolves outside WEBHUB_HOME`],
    });
  }
  return abs;
}

/** Checks that need the home path; throws CONFIG_INVALID listing every problem. */
export async function checkConfig(config: Config, paths: Paths): Promise<string[]> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const pathKeys: [string, string][] = [
    ["runtimes.dir", config.runtimes.dir],
    ...config.profilesDir.map((p, i): [string, string] => [`profilesDir.${i}`, p]),
  ];
  for (const [key, p] of pathKeys) {
    try {
      resolveInHome(paths.home, p, key);
    } catch {
      problems.push(`${key}: must resolve to a folder inside WEBHUB_HOME (got ${p})`);
    }
  }
  // compare real paths too: a junction / 8.3 short name can hide the same folder
  const realHome = await realpath(paths.home).catch(() => resolve(paths.home));
  for (const [i, root] of config.scanRoots.entries()) {
    const realRoot = await realpath(root).catch(() => resolve(root));
    if (isInside(root, paths.home) || isInside(realRoot, realHome)) {
      problems.push(
        `scanRoots.${i}: WEBHUB_HOME (${paths.home}) must not be inside a scan root (${root})`,
      );
    } else if (isInside(paths.home, root) || isInside(realHome, realRoot)) {
      problems.push(`scanRoots.${i}: scan root must not be inside WEBHUB_HOME (${root})`);
    }
    const st = await stat(root).catch((err: NodeJS.ErrnoException) => err);
    if (st instanceof Error) {
      if (st.code === "ENOENT") warnings.push(`scanRoots.${i}: folder does not exist yet: ${root}`);
      else problems.push(`scanRoots.${i}: cannot access ${root} (${st.code ?? st.message})`);
    } else if (!st.isDirectory()) {
      problems.push(`scanRoots.${i}: not a directory: ${root}`);
    }
  }
  if (problems.length > 0) {
    throw new WebhubError(
      "CONFIG_INVALID",
      `invalid webhub.config.json:\n  ${problems.join("\n  ")}`,
      {
        file: paths.config,
        details: problems,
        hint: "Fix the listed keys, then start webhub again (`webhub doctor` shows the same list).",
      },
    );
  }
  return warnings;
}

/** Loads webhub.config.json (defaults if missing). Invalid config → CONFIG_INVALID (no start). */
export async function loadConfig(paths: Paths, lock?: Lock): Promise<LoadedConfig> {
  const res = await readDoc(paths.config, configSpec, {
    home: paths.home,
    ...(lock === undefined ? {} : { lock }),
    backupsDir: paths.backups,
  });
  const config = res?.value ?? defaultConfig();
  const warnings = await checkConfig(config, paths);
  return {
    config,
    warnings,
    isDefault: res === undefined,
    ...(res?.migratedFrom === undefined ? {} : { migratedFrom: res.migratedFrom }),
  };
}

/** Validates and atomically writes the config (daemon only — requires the lock). */
export async function saveConfig(lock: Lock, paths: Paths, config: Config): Promise<void> {
  const valid = validate(ConfigSchema, config, paths.config);
  await checkConfig(valid, paths);
  await writeDoc(lock, paths.config, valid);
}
