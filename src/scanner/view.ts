/**
 * `ProjectView` (F-005) over one candidate folder on disk (F-006 §3.2). F-005's detect rules
 * call the view synchronously, the disk is read asynchronously: the view answers from caches
 * and records what it did not have; `fill()` loads that and the caller evaluates again until
 * nothing is missing (bounded rounds). Never leaves the folder, never follows a link.
 */
import { join } from "node:path";
import type { ProjectView } from "../profiles/match.js";
import { jsonObject, packageJsonDeps, pyprojectDeps, requirementsDeps } from "./deps.js";
import { type Budget, badName, type DirEntry, listDir, readSmall } from "./fsread.js";

/** Evaluate → fill rounds at most (each round resolves one more path level). */
export const MAX_FILL_ROUNDS = 8;

const ci = process.platform === "win32";
const key = (s: string) => (ci ? s.toLowerCase() : s);

export class DiskView implements ProjectView {
  readonly caseInsensitive = ci;
  /** rel dir ("" = root) → entries by key, or null (missing / not walkable). */
  readonly #dirs = new Map<string, Map<string, DirEntry> | null>();
  /** rel file → content (≤ the largest size asked) or undefined. */
  readonly #files = new Map<string, { text: string | undefined; max: number }>();
  readonly #wantDirs = new Set<string>();
  readonly #wantFiles = new Map<string, number>();
  #deps: Map<string, string> | undefined;

  constructor(
    readonly root: string,
    readonly budget: Budget,
  ) {}

  /** Something was asked that is not loaded yet. */
  get missing(): boolean {
    return this.#wantDirs.size > 0 || this.#wantFiles.size > 0;
  }

  /** Entries of a folder, or undefined when not loaded yet (recorded). */
  #dir(rel: string): Map<string, DirEntry> | null | undefined {
    const k = key(rel);
    if (this.#dirs.has(k)) return this.#dirs.get(k);
    this.#wantDirs.add(rel);
    return undefined;
  }

  /** Entry `rel` (any type), following only real folders on the way. */
  #entry(rel: string): DirEntry | undefined {
    const parts = rel.split("/").filter((p) => p !== "");
    if (parts.length === 0) return { name: "", type: "dir" };
    let dir = "";
    for (const [i, name] of parts.entries()) {
      const entries = this.#dir(dir);
      if (entries == null) return undefined;
      const e = entries.get(key(name));
      if (e === undefined) return undefined;
      if (i === parts.length - 1) return e;
      if (e.type !== "dir") return undefined;
      dir = dir === "" ? e.name : `${dir}/${e.name}`;
    }
    return undefined;
  }

  exists(rel: string): boolean {
    const wantDir = rel.endsWith("/");
    const e = this.#entry(wantDir ? rel.slice(0, -1) : rel);
    return e !== undefined && (wantDir ? e.type === "dir" : e.type === "file" || e.type === "dir");
  }

  list(relDir: string): readonly string[] {
    const entries = this.#dir(relDir.replace(/\/$/, ""));
    return entries == null
      ? []
      : [...entries.values()]
          .filter((e) => e.type === "file" || e.type === "dir")
          .map((e) => e.name);
  }

  read(rel: string, maxBytes: number): string | undefined {
    const e = this.#entry(rel);
    if (e === undefined || e.type !== "file") return undefined;
    const k = key(rel);
    const hit = this.#files.get(k);
    if (hit !== undefined && hit.max >= maxBytes) return hit.text?.slice(0, maxBytes);
    this.#wantFiles.set(rel, Math.max(maxBytes, this.#wantFiles.get(rel) ?? 0));
    return undefined;
  }

  deps(): ReadonlyMap<string, string> {
    if (this.#deps !== undefined) return this.#deps;
    const pkg = this.read("package.json", this.budget.limits.fileBytes);
    const req = this.read("requirements.txt", this.budget.limits.fileBytes);
    const py = this.read("pyproject.toml", this.budget.limits.fileBytes);
    const out = new Map<string, string>();
    const max = this.budget.limits.deps;
    packageJsonDeps(jsonObject(pkg), out, max);
    requirementsDeps(req, out, max);
    pyprojectDeps(py, out, max);
    if (!this.missing) this.#deps = out; // complete only once every file was loaded
    return out;
  }

  /** Loads what the last evaluation asked for. */
  async fill(): Promise<void> {
    const dirs = [...this.#wantDirs];
    const files = [...this.#wantFiles];
    this.#wantDirs.clear();
    this.#wantFiles.clear();
    for (const rel of dirs) {
      const k = key(rel);
      if (this.#dirs.has(k)) continue;
      const abs = rel === "" ? this.root : join(this.root, ...rel.split("/"));
      const r = await listDir(abs, this.root, this.budget);
      // odd names never reach rules / reasons, as in the walk (review-1 C9)
      this.#dirs.set(
        k,
        "entries" in r
          ? new Map(r.entries.filter((e) => !badName(e.name)).map((e) => [key(e.name), e]))
          : null,
      );
    }
    for (const [rel, max] of files) {
      const abs = join(this.root, ...rel.split("/"));
      const text = await readSmall(abs, max, this.budget);
      this.#files.set(key(rel), { text, max });
    }
  }

  /** Seeds the root listing (the walk already read it). */
  seedRoot(entries: readonly DirEntry[]): void {
    this.#dirs.set("", new Map(entries.map((e) => [key(e.name), e])));
  }

  /**
   * Runs `fn` until it no longer asks for anything new (≤ MAX_FILL_ROUNDS); returns its last
   * result. What is still missing after that counts as "not there".
   */
  async settle<T>(fn: () => T): Promise<T> {
    let out = fn();
    for (let round = 0; round < MAX_FILL_ROUNDS && this.missing; round++) {
      await this.fill();
      out = fn();
    }
    this.#wantDirs.clear();
    this.#wantFiles.clear();
    return out;
  }

  /** Text of a file through the view's caches (async: loads when needed). */
  async text(rel: string, max = this.budget.limits.fileBytes): Promise<string | undefined> {
    return this.settle(() => this.read(rel, max));
  }

  /**
   * A file read once and NOT kept in the view's cache (`.env*`: the caller keeps only port
   * numbers — Q5). Same checks as every read: real file, no link on the way, ino match.
   */
  async readOnce(rel: string, max = this.budget.limits.fileBytes): Promise<string | undefined> {
    if ((await this.kind(rel)) !== "file") return undefined;
    return readSmall(join(this.root, ...rel.split("/")), max, this.budget);
  }

  /** Names in a folder (async). */
  async names(relDir = ""): Promise<readonly string[]> {
    return this.settle(() => this.list(relDir));
  }

  /** Entry type (async). */
  async kind(rel: string): Promise<DirEntry["type"] | undefined> {
    return this.settle(() => this.#entry(rel)?.type);
  }
}
