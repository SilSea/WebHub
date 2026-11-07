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

/** Copies fixtures/<name> into a fresh temp dir and returns the copy's path. */
export async function copyFixture(name: string): Promise<string> {
  if (!NAME_RE.test(name)) throw new Error(`invalid fixture name: ${JSON.stringify(name)}`);
  const src = resolve(FIXTURES_ROOT, name);
  if (!isInside(FIXTURES_ROOT, src)) throw new Error(`fixture outside fixtures/: ${name}`);
  const tmp = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const dest = join(tmp, name);
  await cp(src, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
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

/** Map of posix relative path → "file:<sha256>" | "dir" | "link:<target>". Symlinks are not followed. */
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
        out.set(rel, "dir");
        await walk(abs);
      } else if (st.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(abs))
          .digest("hex");
        out.set(rel, `file:${digest}`);
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
