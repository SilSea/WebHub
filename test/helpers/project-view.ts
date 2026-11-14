/**
 * Minimal on-disk ProjectView for profile tests (the real one, confined to scan roots, is F-006).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProjectView } from "../../src/profiles/match.js";

export function diskView(root: string, extraDeps: Record<string, string> = {}): ProjectView {
  const abs = (rel: string) => join(root, ...rel.split("/").filter(Boolean));
  const deps = new Map<string, string>(Object.entries(extraDeps));
  try {
    const pkg = JSON.parse(readFileSync(abs("package.json"), "utf8")) as Record<string, unknown>;
    for (const k of ["dependencies", "devDependencies"]) {
      for (const [n, v] of Object.entries((pkg[k] ?? {}) as Record<string, string>)) deps.set(n, v);
    }
  } catch {
    // no package.json
  }
  try {
    for (const line of readFileSync(abs("requirements.txt"), "utf8").split("\n")) {
      const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:==\s*([0-9.]+))?/.exec(line.trim());
      if (m?.[1] !== undefined) deps.set(m[1].toLowerCase(), m[2] ?? "*");
    }
  } catch {
    // no requirements.txt
  }
  return {
    caseInsensitive: process.platform === "win32",
    exists: (rel) => {
      const p = abs(rel);
      if (!existsSync(p)) return false;
      return rel.endsWith("/") ? statSync(p).isDirectory() : true;
    },
    list: (dir) => {
      try {
        return readdirSync(abs(dir));
      } catch {
        return [];
      }
    },
    read: (rel, max) => {
      try {
        return readFileSync(abs(rel)).subarray(0, max).toString("utf8");
      } catch {
        return undefined;
      }
    },
    deps: () => deps,
  };
}

/** In-memory view: `files` maps "a/b.txt" → content (folders are implied). */
export function memView(
  files: Record<string, string>,
  deps: Record<string, string> = {},
): ProjectView {
  const dirs = new Set<string>([""]);
  for (const f of Object.keys(files)) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    exists: (rel) =>
      rel.endsWith("/") ? dirs.has(rel.slice(0, -1)) : Object.hasOwn(files, rel) || dirs.has(rel),
    list: (dir) => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const names = new Set<string>();
      for (const p of [...Object.keys(files), ...dirs]) {
        if (p !== dir && p.startsWith(prefix)) {
          const name = p.slice(prefix.length).split("/")[0];
          if (name) names.add(name);
        }
      }
      return [...names];
    },
    read: (rel, max) => (Object.hasOwn(files, rel) ? (files[rel] ?? "").slice(0, max) : undefined),
    deps: () => new Map(Object.entries(deps)),
  };
}
