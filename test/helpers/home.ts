import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Paths, pathsFor } from "../../src/config/home.js";
import type { Lock } from "../../src/store/lock.js";

/** A fresh WEBHUB_HOME under the OS temp dir (tests never touch the real home). */
export async function tempHome(): Promise<{
  root: string;
  paths: Paths;
  cleanup(): Promise<void>;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "webhub-home-")));
  const paths = pathsFor(join(root, "home"));
  return { root, paths, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** In-memory lock for unit tests of code that only checks `held` + `home`. */
export function fakeLock(home: string, held = true): Lock {
  return { file: join(home, "data", ".lock"), home, held, release: async () => {} };
}
