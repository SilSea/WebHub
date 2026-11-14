/**
 * Loads built-in profiles (`profiles/*.yml` in the package) and the user's
 * (`$WEBHUB_HOME/data/profiles/*.yml`) — F-005 §3.3. A broken file never stops the others: it
 * is skipped and reported in `problems`. A user profile with the id of a built-in one replaces
 * it entirely (Q3).
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "../config/home.js";
import { WebhubError } from "../errors.js";
import { assertSafePath } from "../fs/safe-path.js";
import { MAX_PROFILE_BYTES, type Profile, parseProfile } from "./schema.js";

/** User profile files read at most (sorted by name). */
export const MAX_USER_PROFILES = 200;
export const PROFILE_EXT = ".yml";

export const BUILTIN_DIR = fileURLToPath(new URL("../../profiles/", import.meta.url));

export interface LoadedProfile {
  profile: Profile;
  source: "builtin" | "user";
  /** Shown to users: `profiles/vite.yml` or `data/profiles/vite.yml` — never a full path. */
  file: string;
  /** Set when a user profile replaces a built-in one: the built-in file it replaces. */
  overrides?: string;
}

export interface ProfileProblem {
  file: string;
  message: string;
  details: string[];
}

export interface LoadResult {
  profiles: LoadedProfile[];
  problems: ProfileProblem[];
}

const problemOf = (file: string, err: unknown): ProfileProblem => {
  // these messages hold the absolute path: never to the API / browser (review-1 K3, security-1 S2)
  if (
    err instanceof WebhubError &&
    (err.code === "SYMLINK_REFUSED" || err.code === "PATH_OUTSIDE_HOME")
  ) {
    return {
      file,
      message: `${file} must be a real folder / file inside WEBHUB_HOME, not a link`,
      details: [],
    };
  }
  if (err instanceof WebhubError) {
    return { file, message: err.message.split("\n")[0] ?? "", details: [...err.details] };
  }
  // never an unexpected message (paths, content): class / code only
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return {
    file,
    message: `could not read the file (${typeof code === "string" ? code : err instanceof Error ? err.name : "error"})`,
    details: [],
  };
};

/**
 * Reads one profile file: a regular file, not a link, ≤ MAX_PROFILE_BYTES; a user file also has
 * one hard link only. Built-in files may have several: pnpm / bun install packages as hard
 * links into their store (review-1 K1).
 */
async function readProfileFile(abs: string, source: LoadedProfile["source"]): Promise<string> {
  // bigint: 64-bit Windows file ids lose precision as numbers (lstat vs fstat differ on Node 22)
  const st = await lstat(abs, { bigint: true });
  if (st.isSymbolicLink())
    throw new WebhubError("SYMLINK_REFUSED", "profile files must not be links");
  if (!st.isFile()) throw new WebhubError("CONFIG_INVALID", "not a regular file");
  if (source === "user" && st.nlink > 1n)
    throw new WebhubError("CONFIG_INVALID", "profile files must not be hard links");
  if (st.size > BigInt(MAX_PROFILE_BYTES)) {
    throw new WebhubError("FILE_TOO_LARGE", `profile file exceeds ${MAX_PROFILE_BYTES} bytes`);
  }
  const fh = await open(abs, constants.O_RDONLY);
  try {
    // the file opened is the one checked (not swapped for a link in between)
    const fst = await fh.stat({ bigint: true });
    // ino only: Node 22 on Windows reports dev 0 from lstat (the path is the same volume)
    if (fst.ino !== st.ino || !fst.isFile()) {
      throw new WebhubError("CONFIG_INVALID", "file changed while reading");
    }
    const buf = Buffer.alloc(MAX_PROFILE_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_PROFILE_BYTES) {
      throw new WebhubError("FILE_TOO_LARGE", `profile file exceeds ${MAX_PROFILE_BYTES} bytes`);
    }
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

async function loadDir(
  dir: string,
  shown: string,
  source: LoadedProfile["source"],
  problems: ProfileProblem[],
): Promise<LoadedProfile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    problems.push(problemOf(shown, err));
    return [];
  }
  const files = names.filter(
    (n) => n.toLowerCase().endsWith(PROFILE_EXT) || n.toLowerCase().endsWith(".yaml"),
  );
  if (source === "user" && files.length > MAX_USER_PROFILES) {
    problems.push({
      file: shown,
      message: `more than ${MAX_USER_PROFILES} profile files; only the first ${MAX_USER_PROFILES} (by name) were read`,
      details: [],
    });
  }
  const out: LoadedProfile[] = [];
  for (const name of files.slice(0, MAX_USER_PROFILES)) {
    const rel = `${shown}/${name}`;
    if (!name.endsWith(PROFILE_EXT)) {
      problems.push({ file: rel, message: `profile files end in ${PROFILE_EXT}`, details: [] });
      continue;
    }
    try {
      const profile = parseProfile(await readProfileFile(join(dir, name), source), rel);
      if (profile.id !== name.slice(0, -PROFILE_EXT.length)) {
        throw new WebhubError("CONFIG_INVALID", `invalid profile ${name}`, {
          details: [`id "${profile.id}" must equal the file name (${profile.id}${PROFILE_EXT})`],
        });
      }
      out.push({ profile, source, file: rel });
    } catch (err) {
      problems.push(problemOf(rel, err));
    }
  }
  return out;
}

/**
 * Built-in + user profiles, sorted by id. `data/profiles` must be inside home and not a link
 * (F-001 safe path).
 */
export async function loadProfiles(
  paths: Paths,
  opts: { builtinDir?: string } = {},
): Promise<LoadResult> {
  const problems: ProfileProblem[] = [];
  const builtin = await loadDir(opts.builtinDir ?? BUILTIN_DIR, "profiles", "builtin", problems);
  let user: LoadedProfile[] = [];
  try {
    await assertSafePath(paths.home, paths.profiles);
    user = await loadDir(paths.profiles, "data/profiles", "user", problems);
  } catch (err) {
    problems.push(problemOf("data/profiles", err));
  }
  const byId = new Map<string, LoadedProfile>();
  for (const p of builtin) byId.set(p.profile.id, p);
  for (const p of user) {
    const prev = byId.get(p.profile.id);
    byId.set(p.profile.id, prev?.source === "builtin" ? { ...p, overrides: prev.file } : p);
  }
  return {
    profiles: [...byId.values()].sort((a, b) => a.profile.id.localeCompare(b.profile.id)),
    problems,
  };
}
