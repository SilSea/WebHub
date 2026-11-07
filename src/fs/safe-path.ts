import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { WebhubError } from "../errors.js";

/** True when `child` resolves to `root` itself or somewhere below it. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  // "..foo" is a child named "..foo", not a parent: compare whole segments
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Ensures `target` is inside `home` and that no existing path component between them
 * (including `target`) is a symlink/junction. Missing components are fine (they will be created).
 */
export async function assertSafePath(home: string, target: string): Promise<void> {
  const abs = resolve(target);
  if (!isInside(home, abs)) {
    throw new WebhubError("PATH_OUTSIDE_HOME", `path is outside WEBHUB_HOME: ${abs}`, {
      file: abs,
    });
  }
  const parts = relative(resolve(home), abs).split(sep).filter(Boolean);
  let cur = resolve(home);
  for (const part of parts) {
    cur = join(cur, part);
    const st = await lstat(cur).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (st === null) return;
    if (st.isSymbolicLink()) {
      throw new WebhubError("SYMLINK_REFUSED", `refusing symlink/junction: ${cur}`, {
        file: cur,
      });
    }
  }
}
