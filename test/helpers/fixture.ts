/**
 * Fixture harness — Zero-touch check (WORKFLOW R0, DESIGN §21.5).
 * Works only on copies under a private temp dir; never on fixtures/ itself.
 */
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_ROOT = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const TEMP_PREFIX = "webhub-fx-";
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** True when `child` resolves to `root` itself or somewhere below it. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Throws if `dir` contains any symlink/junction. Fixtures must be plain files so a copy can never
 * point back outside its temp dir.
 */
export async function assertNoSymlinks(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) throw new Error(`fixtures must not contain symlinks: ${abs}`);
    if (st.isDirectory()) await assertNoSymlinks(abs);
  }
}

/**
 * Copies <root>/<name> (default fixtures/<name>) into a fresh temp dir and returns the copy's path.
 * The fixture dir itself and everything below it must be real files/dirs (no links), otherwise the
 * "copy" could be a link back to the original and the Zero-touch check would pass falsely.
 */
export async function copyFixture(name: string, root: string = FIXTURES_ROOT): Promise<string> {
  if (!NAME_RE.test(name)) throw new Error(`invalid fixture name: ${JSON.stringify(name)}`);
  const src = resolve(root, name);
  if (!isInside(root, src)) throw new Error(`fixture outside root ${root}: ${name}`);
  const st = await lstat(src).catch(() => null);
  if (st?.isSymbolicLink()) throw new Error(`fixtures must not contain symlinks: ${src}`);
  if (!st?.isDirectory()) throw new Error(`fixture not found: ${name}`);
  if (!isInside(await realpath(root), await realpath(src))) {
    throw new Error(`fixture resolves outside root ${root}: ${name}`);
  }
  await assertNoSymlinks(src);
  const tmp = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const dest = join(tmp, name);
  try {
    await cp(src, dest, { recursive: true, errorOnExist: true });
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return dest;
}

/** Deletes a copy made by copyFixture; refuses anything else. */
export async function removeFixtureCopy(dir: string): Promise<void> {
  const tmpRoot = await realpath(tmpdir());
  const parent = resolve(dir, "..");
  const parentReal = await realpath(parent);
  const parentName = parentReal.slice(parentReal.lastIndexOf(sep) + 1);
  if (
    !isInside(tmpRoot, parentReal) ||
    parentReal === tmpRoot ||
    !parentName.startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`refusing to remove path outside fixture temp dirs: ${dir}`);
  }
  await rm(parentReal, { recursive: true, force: true });
}

export interface HashOptions {
  /** Top-level relative paths (posix, e.g. "node_modules") the project may create/change itself. */
  ignore?: readonly string[];
}

/**
 * Map of posix relative path → "file:<mode>:<sha256>" | "dir:<mode>" | "link:<target>".
 * Mode = permission bits (on Windows: read-only attribute). Symlinks are not followed.
 */
export async function hashTree(root: string, opts: HashOptions = {}): Promise<Map<string, string>> {
  const ignore = new Set(opts.ignore ?? []);
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (ignore.has(rel.split("/")[0] ?? "")) continue;
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        out.set(rel, `link:${await readlink(abs)}`);
      } else if (st.isDirectory()) {
        out.set(rel, `dir:${(st.mode & 0o777).toString(8)}`);
        await walk(abs);
      } else if (st.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(abs))
          .digest("hex");
        out.set(rel, `file:${(st.mode & 0o777).toString(8)}:${digest}`);
      } else {
        out.set(rel, "other");
      }
    }
  };
  await walk(root);
  return out;
}

export interface TreeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffTrees(before: Map<string, string>, after: Map<string, string>): TreeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [p, h] of before) {
    const now = after.get(p);
    if (now === undefined) removed.push(p);
    else if (now !== h) changed.push(p);
  }
  for (const p of after.keys()) if (!before.has(p)) added.push(p);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** Throws with the list of differences when the project tree was touched. */
export function assertUntouched(before: Map<string, string>, after: Map<string, string>): void {
  const d = diffTrees(before, after);
  if (d.added.length + d.removed.length + d.changed.length === 0) return;
  const lines = [
    "Zero-touch violation: project files changed",
    ...d.added.map((p) => `  + ${p}`),
    ...d.removed.map((p) => `  - ${p}`),
    ...d.changed.map((p) => `  ~ ${p}`),
  ];
  throw new Error(lines.join("\n"));
}
