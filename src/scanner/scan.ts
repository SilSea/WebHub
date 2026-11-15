/**
 * One scan of the configured scan roots (F-006 §3.1–§3.4): read-only walk → candidates →
 * profile detection, runner, port / via, publicDir, runtime hints → monorepo merge →
 * duplicates → names. Limits end the scan early with what it found (`truncated`).
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Paths } from "../config/home.js";
import { isInside } from "../fs/safe-path.js";
import { type LoadedProfile, loadProfiles } from "../profiles/loader.js";
import { effectiveProfile, evaluateDetect } from "../profiles/match.js";
import {
  COMPOSE_FILES,
  ComposeError,
  type ComposeService,
  composeRunner,
  parseCompose,
} from "./compose.js";
import {
  Budget,
  badName,
  DEFAULT_LIMITS,
  type DirEntry,
  listDir,
  type ScanLimits,
  samePath,
  Truncated,
} from "./fsread.js";
import { notWebReasons, portHint, publicDir, runtimeHints } from "./hints.js";
import { type Candidate, SCAN_SCHEMA_VERSION, type ScanResult } from "./schema.js";
import { DiskView } from "./view.js";

export const WEB_SCORE = 50;

/** Folders never walked into (build output, dependencies, VCS, caches). */
export const SKIP_DIRS = new Set(
  [
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "vendor",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    "coverage",
    ".cache",
    ".turbo",
    "bin",
    "obj",
    "library",
    "$recycle.bin",
    "system volume information",
  ].map((s) => s.toLowerCase()),
);

/** Files that make a folder a candidate (besides compose files and not-web markers). */
const MARKERS = new Set(
  [
    "package.json",
    "index.html",
    "Dockerfile",
    "go.mod",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "manage.py",
    "composer.json",
    "Gemfile",
    "manifest.json",
    ...COMPOSE_FILES,
  ].map((s) => s.toLowerCase()),
);
const MARKER_PATTERNS = [/\.rbxlx?$/i, /\.uproject$/i, /\.csproj$/i];

/** Manifest files whose content makes the fingerprint (duplicate detection). */
const FINGERPRINT_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "index.html",
  ...COMPOSE_FILES,
];

const FRONTEND = /^(frontend|client|web|ui|.+-frontend|.+-web)$/i;
const BACKEND = /^(backend|server|api|.+-backend|.+-api)$/i;

export interface ScanOptions {
  scanRoots: readonly string[];
  /** Config `maxDepth` (F-001): levels below a scan root that are walked. */
  maxDepth?: number;
  /** Config `ignore` (F-001): folder names never walked into, besides SKIP_DIRS. */
  ignore?: readonly string[];
  /** Id of this scan (default: random). */
  scanId?: string;
  signal?: AbortSignal;
  limits?: Partial<ScanLimits>;
  now?: () => number;
  builtinDir?: string;
  onProgress?(p: { folders: number; candidates: number }): void;
}

interface Found {
  abs: string;
  root: string;
  entries: DirEntry[];
}

const isMarker = (e: DirEntry) =>
  e.type === "file" &&
  (MARKERS.has(e.name.toLowerCase()) || MARKER_PATTERNS.some((re) => re.test(e.name)));
const isUnityDir = (e: DirEntry) => e.type === "dir" && e.name === "ProjectSettings";

/** Slug for a site name: a-z 0-9 -, ≤ 40, never empty. */
export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s === "" ? "site" : s;
}

const keyOf = (abs: string) =>
  createHash("sha256")
    .update(process.platform === "win32" ? abs.toLowerCase() : abs)
    .digest("hex")
    .slice(0, 16);

/** Read-only walk of one root (BFS, depth-limited). */
async function walk(
  root: string,
  budget: Budget,
  skipDirs: ReadonlySet<string>,
  found: Found[],
  skipped: ScanResult["skipped"],
  onFolder: () => void,
): Promise<void> {
  const queue: { abs: string; depth: number }[] = [{ abs: root, depth: 0 }];
  const skip = (path: string, reason: ScanResult["skipped"][number]["reason"]) => {
    if (skipped.length < budget.limits.skipped) skipped.push({ path, reason });
  };
  while (queue.length > 0) {
    const { abs, depth } = queue.shift() as { abs: string; depth: number };
    const r = await listDir(abs, root, budget);
    onFolder();
    if ("skip" in r) {
      skip(abs, r.skip);
      continue;
    }
    const entries = r.entries.filter((e) => {
      if (!badName(e.name)) return true;
      skip(abs, "bad-name");
      return false;
    });
    if (entries.some(isMarker) || entries.some(isUnityDir)) {
      if (found.length >= budget.limits.candidates) throw new Truncated("candidates");
      found.push({ abs, root, entries });
    }
    if (depth >= budget.limits.depth) continue;
    for (const e of entries) {
      if (e.type === "link") skip(join(abs, e.name), "link");
      if (e.type !== "dir") continue;
      if (skipDirs.has(e.name.toLowerCase()) || e.name.startsWith(".")) continue;
      queue.push({ abs: join(abs, e.name), depth: depth + 1 });
    }
  }
}

async function fingerprint(view: DiskView): Promise<string> {
  const h = createHash("sha256");
  let any = false;
  for (const f of FINGERPRINT_FILES) {
    const t = await view.text(f);
    if (t === undefined) continue;
    any = true;
    h.update(`${f}\0${createHash("sha256").update(t).digest("hex")}\0`);
  }
  return any ? h.digest("hex") : "";
}

type Draft = Omit<Candidate, "name"> & { base: string };

async function composeOf(
  view: DiskView,
  rel: string,
  problems: ScanResult["problems"],
): Promise<{ files: string[]; services: ComposeService[] }> {
  const files: string[] = [];
  const services: ComposeService[] = [];
  const names = await view.names(rel);
  for (const f of COMPOSE_FILES) {
    const actual = names.find((n) => n.toLowerCase() === f);
    if (actual === undefined) continue;
    const r = rel === "" ? actual : `${rel}/${actual}`;
    const text = await view.text(r);
    if (text === undefined) continue;
    files.push(r);
    try {
      services.push(...parseCompose(text).services);
    } catch (err) {
      if (problems.length < 500) {
        problems.push({
          file: join(view.root, ...r.split("/")),
          message: err instanceof ComposeError ? err.message : "could not read compose file",
        });
      }
    }
  }
  return { files, services };
}

/** Detection of one candidate folder (one service at its root). */
async function detect(
  f: Found,
  profiles: readonly LoadedProfile[],
  budget: Budget,
  problems: ScanResult["problems"],
): Promise<Draft> {
  const view = new DiskView(f.abs, budget);
  view.seedRoot(f.entries);
  const results = await view.settle(() =>
    profiles
      .map((p) => ({ p, r: evaluateDetect(p.profile, view) }))
      .filter((x) => x.r.matched)
      .sort((a, b) => b.r.score - a.r.score || a.p.profile.id.localeCompare(b.p.profile.id)),
  );
  const deps = await view.settle(() => view.deps());
  const best = results[0];
  const notWeb = await notWebReasons(view);
  const pythonMarker = f.entries.some(
    (e) => e.type === "file" && /^(requirements\.txt|pyproject\.toml|manage\.py)$/i.test(e.name),
  );
  if (pythonMarker && !results.some((x) => x.p.profile.language === "python")) {
    notWeb.push("Python without a web framework");
  }
  const compose = await composeOf(view, "", problems);
  const score = best?.r.score ?? 0;
  const kind: Candidate["kind"] =
    notWeb.length > 0 ? "not-web" : score >= WEB_SCORE ? "site" : "unknown";
  const draft: Draft = {
    key: keyOf(f.abs),
    base: slug(f.abs.slice(f.abs.lastIndexOf(sep) + 1)),
    path: f.abs,
    kind,
    score,
    alternatives: results.slice(1, 6).map((x) => ({ profile: x.p.profile.id, score: x.r.score })),
    reasons: best?.r.reasons.slice(0, 100) ?? [],
    notWeb,
    services: {},
    fingerprint: await fingerprint(view),
  };
  if (best === undefined) return draft;
  draft.profile = best.p.profile.id;
  if (kind !== "site") return draft;
  const eff = effectiveProfile(best.p.profile, deps);
  const isStatic = eff.static !== undefined;
  const runner = composeRunner(compose.services) ?? (isStatic ? "static" : "native");
  draft.runner = runner;
  if (compose.files.length > 0) {
    draft.compose = {
      files: compose.files,
      app: compose.services.filter((s) => !s.infra).map((s) => s.name),
      infra: compose.services.filter((s) => s.infra).map((s) => s.name),
      mountsSource: compose.services.some((s) => !s.infra && s.mountsSource),
    };
  }
  const port = isStatic ? undefined : await portHint(view, "", compose.services);
  const fallback =
    eff.port === undefined || isStatic
      ? undefined
      : {
          value: eff.port.default,
          via: eff.port.via,
          ...(eff.port.env === undefined ? {} : { env: eff.port.env }),
          source: `profile ${eff.id}`,
        };
  const runtime = await runtimeHints(view, "");
  draft.services.app = {
    cwd: "",
    profile: eff.id,
    ...(port !== undefined ? { port } : fallback !== undefined ? { port: fallback } : {}),
    ...(isStatic ? { publicDir: await publicDir(view, "") } : {}),
    ...(runtime.length > 0 ? { runtime } : {}),
  };
  return draft;
}

const RUNNER_RANK = { static: 0, native: 1, hybrid: 2, compose: 3 } as const;

/**
 * Frontend + backend folders under one parent that is not a site itself → one candidate at
 * the parent, one service per folder (DESIGN §9).
 */
function mergeMonorepos(drafts: Draft[]): Draft[] {
  const byParent = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (d.kind !== "site") continue;
    const parent = d.path.slice(0, d.path.lastIndexOf(sep));
    byParent.set(parent, [...(byParent.get(parent) ?? []), d]);
  }
  const removed = new Set<Draft>();
  const added: Draft[] = [];
  for (const [parent, kids] of byParent) {
    const name = (d: Draft) => d.path.slice(d.path.lastIndexOf(sep) + 1);
    const fronts = kids.filter((d) => FRONTEND.test(name(d)));
    const backs = kids.filter((d) => BACKEND.test(name(d)));
    if (fronts.length === 0 || backs.length === 0) continue;
    const own = drafts.find((d) => samePath(d.path, parent));
    if (own?.kind === "site") continue;
    const parts = [...fronts, ...backs];
    const services: Draft["services"] = {};
    for (const d of parts) {
      const svcName =
        fronts.length === 1 && d === fronts[0]
          ? "frontend"
          : backs.length === 1 && d === backs[0]
            ? "backend"
            : slug(name(d));
      const s = d.services.app;
      if (s !== undefined) services[svcName] = { ...s, cwd: name(d) };
      removed.add(d);
    }
    const runner = parts
      .map((d) => d.runner ?? "native")
      .reduce((a, b) => (RUNNER_RANK[b] > RUNNER_RANK[a] ? b : a));
    const compose = parts.filter((d) => d.compose !== undefined);
    if (own !== undefined) removed.add(own);
    added.push({
      key: keyOf(parent),
      base: slug(parent.slice(parent.lastIndexOf(sep) + 1)),
      path: parent,
      kind: "site",
      score: Math.max(...parts.map((d) => d.score)),
      profile: parts[0]?.profile,
      alternatives: [],
      reasons: parts.flatMap((d) => d.reasons.map((r) => `${name(d)}: ${r}`)).slice(0, 100),
      notWeb: [],
      runner,
      ...(compose.length === 0
        ? {}
        : {
            compose: {
              files: compose.flatMap((d) => (d.compose?.files ?? []).map((f) => `${name(d)}/${f}`)),
              app: compose.flatMap((d) => d.compose?.app ?? []),
              infra: compose.flatMap((d) => d.compose?.infra ?? []),
              mountsSource: compose.some((d) => d.compose?.mountsSource === true),
            },
          }),
      services,
      fingerprint: "",
    });
  }
  return [...drafts.filter((d) => !removed.has(d)), ...added];
}

/**
 * Nested candidates: a copy of another project (same fingerprint) → `duplicate`; a folder with
 * no web profile inside a project (packages, tools) → dropped; an `index.html`-only folder
 * inside a project → part of it, dropped.
 */
function nested(drafts: Draft[]): Draft[] {
  const sorted = [...drafts].sort((a, b) => a.path.length - b.path.length);
  const out: Draft[] = [];
  for (const d of sorted) {
    const parent = out.find((p) => p.path !== d.path && isInside(p.path, d.path));
    if (parent === undefined) {
      out.push(d);
      continue;
    }
    const original =
      d.fingerprint === ""
        ? undefined
        : sorted.find(
            (o) => o !== d && o.fingerprint === d.fingerprint && !isInside(d.path, o.path),
          );
    if (original !== undefined) {
      out.push({ ...d, kind: "duplicate", duplicateOf: original.key });
      continue;
    }
    if (d.kind !== "site") continue;
    if (d.profile === "static" || d.profile === "static-spa") continue;
    out.push(d);
  }
  return out;
}

/** Unique names in path order: `name`, `name-2`, … */
function name(drafts: Draft[]): Candidate[] {
  const used = new Set<string>();
  // sites get the plain names first; copies / other folders get `-2`, `-3`, …
  const rank = (d: Draft) => (d.kind === "site" ? 0 : 1);
  return drafts
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    .map(({ base, ...d }) => {
      let n = base;
      for (let i = 2; used.has(n); i++) n = `${base.slice(0, 36).replace(/-+$/, "")}-${i}`;
      used.add(n);
      return { ...d, name: n };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Status of a configured root, and its real path when usable. */
async function rootStatus(
  root: string,
  home: string,
): Promise<{ status: ScanResult["roots"][number]["status"]; real?: string }> {
  try {
    const st = await lstat(root);
    if (st.isSymbolicLink()) return { status: "link" };
    if (!st.isDirectory()) return { status: "not-a-folder" };
    const real = await realpath(root);
    if (isInside(real, home) || isInside(home, real)) return { status: "inside-home" };
    return { status: "ok", real };
  } catch (err) {
    return { status: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "no-access" };
  }
}

/** Runs one scan. Throws only on abort (`signal`); limits give a partial result. */
export async function scan(paths: Paths, opts: ScanOptions): Promise<ScanResult> {
  const limits = {
    ...DEFAULT_LIMITS,
    ...(opts.maxDepth === undefined ? {} : { depth: opts.maxDepth }),
    ...opts.limits,
  };
  const skipDirs = new Set([...SKIP_DIRS, ...(opts.ignore ?? []).map((n) => n.toLowerCase())]);
  const now = opts.now ?? Date.now;
  const budget = new Budget(limits, opts.signal, now);
  const startedAt = new Date().toISOString();
  const result: ScanResult = {
    schemaVersion: SCAN_SCHEMA_VERSION,
    scanId: opts.scanId ?? randomBytes(8).toString("hex"),
    startedAt,
    finishedAt: startedAt,
    truncated: false,
    roots: [],
    candidates: [],
    skipped: [],
    problems: [],
  };
  const loaded = await loadProfiles(
    paths,
    opts.builtinDir === undefined ? {} : { builtinDir: opts.builtinDir },
  );
  for (const p of loaded.problems.slice(0, 50)) {
    result.problems.push({ file: p.file, message: p.message.slice(0, 400) });
  }
  const found: Found[] = [];
  const drafts: Draft[] = [];
  const progress = () => opts.onProgress?.({ folders: budget.folders, candidates: found.length });
  try {
    for (const root of opts.scanRoots.slice(0, 100)) {
      const r = await rootStatus(root, paths.home);
      result.roots.push({ path: root, status: r.status });
      if (r.real !== undefined) {
        await walk(r.real, budget, skipDirs, found, result.skipped, progress);
      }
    }
    for (const f of found) {
      drafts.push(await detect(f, loaded.profiles, budget, result.problems));
      progress();
    }
  } catch (err) {
    if (!(err instanceof Truncated)) throw err;
    result.truncated = { reason: err.reason };
  }
  result.candidates = name(nested(mergeMonorepos(drafts)));
  result.finishedAt = new Date().toISOString();
  return result;
}

/** Path shown relative to its scan root (CLI tables). */
export const shownPath = (root: string, abs: string): string => relative(root, abs) || ".";
