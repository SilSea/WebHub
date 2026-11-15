/**
 * One scan of the configured scan roots (F-006 §3.1–§3.4): read-only walk → candidates →
 * profile detection, runner, port / via, publicDir, runtime hints → monorepo merge →
 * duplicates → names. Limits end the scan early with what it found (`truncated`).
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Paths } from "../config/home.js";
import { isInside } from "../fs/safe-path.js";
import { type LoadedProfile, loadProfiles } from "../profiles/loader.js";
import { effectiveProfile, evaluateDetect } from "../profiles/match.js";
import { MAX_FILE_BYTES } from "../store/json-store.js";
import {
  COMPOSE_BASE_FILES,
  COMPOSE_FILES,
  COMPOSE_OVERRIDE_FILES,
  ComposeError,
  type ComposeService,
  composeRunner,
  mergeServices,
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
import { clip, notWebReasons, portHint, publicDir, runtimeHints } from "./hints.js";
import { Candidate, SCAN_SCHEMA_VERSION, type ScanResult } from "./schema.js";
import { DiskView } from "./view.js";

export const WEB_SCORE = 50;

/** Saved result size kept below the store limit (F-001 `MAX_FILE_BYTES`) with a margin. */
export const RESULT_MAX_BYTES = MAX_FILE_BYTES - 256 * 1024;

/** Bytes the store writes for `value` (same serialization as `writeDoc`). */
const savedBytes = (value: unknown): number =>
  Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Drops candidates from the end until the result fits the store (review-1 C11): a big result is
 * cut, never lost. Measured as the store writes it, pretty-printed (review-3 Q1).
 */
export function fitToStore(result: ScanResult, max = RESULT_MAX_BYTES): ScanResult {
  while (result.candidates.length > 0 && savedBytes(result) > max) {
    result.candidates.length = Math.floor(result.candidates.length * 0.9);
    result.truncated = { reason: "candidates" };
  }
  return result;
}

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

/**
 * Manifest files whose content makes the fingerprint (duplicate detection). No lockfiles: they
 * are big and would use up the byte limit (review-2 R2); the files here are read by detection
 * anyway (cached).
 */
const FINGERPRINT_FILES = [
  "package.json",
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
  /** Index of its root's walk. */
  walk: number;
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

/** BFS state of one scan root. */
interface Walk {
  index: number;
  /** Where this walk starts (folders listed must stay inside it). */
  root: string;
  /** Outermost scan root that holds it: the root of what it finds (monorepo merge, S4). */
  owner: string;
  queue: { abs: string; depth: number }[];
}

/** Folder key as the file system compares paths (case-insensitive on Windows). */
const folderKey = (abs: string) => (process.platform === "win32" ? abs.toLowerCase() : abs);

/**
 * Lists the next folder of one root (read-only, depth-limited). Roots are walked round robin,
 * one folder each in turn: a wide or hostile root cannot use up the folder / candidate limits
 * before the others are looked at (security-1 S3, review-2 R1 / R2).
 */
async function step(
  w: Walk,
  budget: Budget,
  skipDirs: ReadonlySet<string>,
  found: Found[],
  skipped: ScanResult["skipped"],
  visited: Set<string>,
): Promise<void> {
  const skip = (path: string, reason: ScanResult["skipped"][number]["reason"]) => {
    if (skipped.length < budget.limits.skipped) skipped.push({ path, reason });
  };
  const next = w.queue.shift();
  if (next === undefined) return;
  const { abs, depth } = next;
  // a folder another walk already listed (nested scan roots, review-4 V1) is listed once
  if (visited.has(folderKey(abs))) return;
  visited.add(folderKey(abs));
  const r = await listDir(abs, w.root, budget);
  if ("skip" in r) {
    skip(abs, r.skip);
    return;
  }
  const entries = r.entries.filter((e) => {
    if (!badName(e.name)) return true;
    skip(abs, "bad-name");
    return false;
  });
  if (entries.some(isMarker) || entries.some(isUnityDir)) {
    if (found.length >= budget.limits.candidates) throw new Truncated("candidates");
    found.push({ abs, root: w.owner, walk: w.index, entries });
  }
  if (depth >= budget.limits.depth) return;
  for (const e of entries) {
    if (e.type === "link") skip(join(abs, e.name), "link");
    if (e.type !== "dir") continue;
    if (skipDirs.has(e.name.toLowerCase()) || e.name.startsWith(".")) continue;
    w.queue.push({ abs: join(abs, e.name), depth: depth + 1 });
  }
}

/** `found` in round-robin order of their roots (detection shares time / bytes fairly). */
function interleave(found: readonly Found[], roots: number): Found[] {
  const lists: Found[][] = Array.from({ length: roots }, () => []);
  for (const f of found) lists[f.walk]?.push(f);
  const out: Found[] = [];
  for (let i = 0; out.length < found.length; i++) {
    for (const l of lists) {
      const f = l[i];
      if (f !== undefined) out.push(f);
    }
  }
  return out;
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

export type Draft = Omit<Candidate, "name"> & {
  base: string;
  /** Real path of its scan root. */
  root: string;
  /** Found but not looked at (out of time / bytes): may be a site, never hidden as a non-site. */
  unread?: true;
  /** Compose files of the folder itself, whatever its kind (a compose-only monorepo parent). */
  ownCompose?: { files: string[]; services: ComposeService[] };
};

async function composeOf(
  view: DiskView,
  rel: string,
  problems: ScanResult["problems"],
): Promise<{ files: string[]; services: ComposeService[] }> {
  const files: string[] = [];
  const parsed: ComposeService[][] = [];
  const names = await view.names(rel);
  const problem = (r: string, message: string) => {
    if (problems.length < 500) problems.push({ file: join(view.root, ...r.split("/")), message });
  };
  const present = (list: readonly string[]) =>
    list.flatMap((f) => {
      const actual = names.find((n) => n.toLowerCase() === f);
      return actual === undefined ? [] : [rel === "" ? actual : `${rel}/${actual}`];
    });
  // as `docker compose`: the first base file found + the first override file found
  // (review-5 W1); no base file → no compose
  const bases = present(COMPOSE_BASE_FILES);
  const overrides = present(COMPOSE_OVERRIDE_FILES);
  for (const r of [...bases.slice(1), ...overrides.slice(1)]) {
    problem(r, "ignored: docker compose reads only the first compose file of a folder");
  }
  if (bases[0] === undefined) {
    for (const r of overrides.slice(0, 1)) problem(r, "ignored: override without a compose file");
    return { files, services: [] };
  }
  for (const r of [bases[0], ...overrides.slice(0, 1)]) {
    const text = await view.text(r);
    if (text === undefined) break;
    try {
      parsed.push(parseCompose(text).services);
      // only files that could be read are listed (review-2 R3)
      files.push(r);
    } catch (err) {
      problem(r, err instanceof ComposeError ? err.message : "could not read compose file");
      break; // a broken base: no compose; a broken override: base only
    }
  }
  // base + override files describe the same services (review-4 V2)
  return { files, services: mergeServices(parsed) };
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
    root: f.root,
    path: f.abs,
    kind,
    score,
    alternatives: results.slice(1, 6).map((x) => ({ profile: x.p.profile.id, score: x.r.score })),
    reasons: (best?.r.reasons.slice(0, 100) ?? []).map((r) => clip(r, 400)),
    notWeb: notWeb.slice(0, 20).map((r) => clip(r, 200)),
    services: {},
    fingerprint: await fingerprint(view),
    ...(compose.files.length > 0 ? { ownCompose: compose } : {}),
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

/** A found folder that was not looked at (the scan ran out of time / bytes first). */
const unread = (f: Found): Draft => ({
  key: keyOf(f.abs),
  base: slug(f.abs.slice(f.abs.lastIndexOf(sep) + 1)),
  root: f.root,
  path: f.abs,
  kind: "unknown",
  score: 0,
  alternatives: [],
  reasons: [],
  notWeb: [],
  services: {},
  fingerprint: "",
  unread: true,
});

const RUNNER_RANK = { static: 0, native: 1, hybrid: 2, compose: 3 } as const;

/**
 * Frontend + backend folders under one parent that is not a site itself → one candidate at
 * the parent, one service per folder (DESIGN §9).
 */
function mergeMonorepos(drafts: Draft[]): Draft[] {
  const byParent = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (d.kind !== "site") continue;
    // the merged site must stay inside the scan root (security-1 S4)
    const parent = dirname(d.path);
    if (parent === d.path || !isInside(d.root, parent)) continue;
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
    // compose at the parent (`build: ./frontend`, …) runs the whole thing (review-1 C4)
    const parentCompose = own?.ownCompose;
    const parentRunner =
      parentCompose === undefined ? undefined : composeRunner(parentCompose.services);
    const runner = [
      ...parts.map((d) => d.runner ?? "native"),
      ...(parentRunner ? [parentRunner] : []),
    ].reduce((a, b) => (RUNNER_RANK[b] > RUNNER_RANK[a] ? b : a));
    const compose = parts.filter((d) => d.compose !== undefined);
    const composeParts = [
      ...(parentCompose === undefined
        ? []
        : [
            {
              files: parentCompose.files,
              app: parentCompose.services.filter((s) => !s.infra).map((s) => s.name),
              infra: parentCompose.services.filter((s) => s.infra).map((s) => s.name),
              mountsSource: parentCompose.services.some((s) => !s.infra && s.mountsSource),
            },
          ]),
      ...compose.map((d) => ({
        files: (d.compose?.files ?? []).map((f) => `${name(d)}/${f}`),
        app: d.compose?.app ?? [],
        infra: d.compose?.infra ?? [],
        mountsSource: d.compose?.mountsSource === true,
      })),
    ];
    if (own !== undefined) removed.add(own);
    added.push({
      key: keyOf(parent),
      base: slug(basename(parent)),
      root: parts[0]?.root ?? parent,
      path: parent,
      kind: "site",
      score: Math.max(...parts.map((d) => d.score)),
      profile: parts[0]?.profile,
      alternatives: [],
      reasons: parts
        .flatMap((d) => d.reasons.map((r) => clip(`${clip(name(d), 60)}: ${r}`, 400)))
        .slice(0, 100),
      notWeb: [],
      runner,
      ...(composeParts.length === 0
        ? {}
        : {
            compose: {
              files: composeParts
                .flatMap((c) => c.files)
                .slice(0, 32)
                .map((f) => clip(f, 400)),
              // a service in the parent and a child compose is one service (review-2 R3)
              app: [...new Set(composeParts.flatMap((c) => c.app))].slice(0, 200),
              infra: [...new Set(composeParts.flatMap((c) => c.infra))].slice(0, 200),
              mountsSource: composeParts.some((c) => c.mountsSource),
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
export function nested(drafts: Draft[]): Draft[] {
  const sorted = [...drafts].sort((a, b) => a.path.length - b.path.length);
  const out: Draft[] = [];
  const inner: Draft[] = [];
  for (const d of sorted) {
    // any project hides the non-web folders inside it (Unity Packages/, Python sub-packages —
    // review-3 Q3); only a web project hides the sites below it: a stray requirements.txt /
    // tooling package.json higher up does not hide them (review-1 C6)
    const parent = out.find(
      (p) =>
        (!(d.kind === "site" || d.unread === true) || p.kind === "site") &&
        p.path !== d.path &&
        isInside(p.path, d.path),
    );
    (parent === undefined ? out : inner).push(d);
  }
  for (const d of inner) {
    // only a nested folder that would be shown on its own can be a copy: a `public/` with the
    // same boilerplate index.html in two projects is part of each, not a duplicate (review-1 C3)
    // a folder not looked at may be a site: kept, never hidden (review-4 V3)
    if (d.unread === true) {
      out.push(d);
      continue;
    }
    if (d.kind !== "site") continue;
    if (d.profile === "static" || d.profile === "static-spa") continue;
    // the original is a shown, non-duplicate candidate outside this folder (review-1 C5)
    const original =
      d.fingerprint === ""
        ? undefined
        : out.find(
            (o) =>
              o.kind !== "duplicate" &&
              o.fingerprint === d.fingerprint &&
              !isInside(d.path, o.path) &&
              !isInside(o.path, d.path),
          );
    out.push(original === undefined ? d : { ...d, kind: "duplicate", duplicateOf: original.key });
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
    .map(({ base, root: _r, ownCompose: _c, unread: _u, ...d }) => {
      let n = base;
      for (let i = 2; used.has(n); i++) {
        // ≤ 40 with any suffix length (security-1 S2: `-1000` made 41)
        const suffix = `-${i}`;
        n = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "") || "site"}${suffix}`;
      }
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
  const cut = (err: unknown) => {
    if (!(err instanceof Truncated)) throw err;
    if (result.truncated === false) result.truncated = { reason: err.reason };
  };
  const walks: Walk[] = [];
  const statuses: ({ path: string } & Awaited<ReturnType<typeof rootStatus>>)[] = [];
  for (const root of opts.scanRoots.slice(0, 100)) {
    statuses.push({ path: root, ...(await rootStatus(root, paths.home)) });
  }
  // the same root twice → walked once; a root inside another → `inside-root`, still walked
  // (the outer walk may not reach it: depth, ignore, dot folders — review-4 V1), every folder
  // listed once (review-2 R4)
  for (const [i, x] of statuses.entries()) {
    const real = x.real;
    if (real === undefined) {
      result.roots.push({ path: x.path, status: x.status });
      continue;
    }
    const same = statuses.some((o, j) => j < i && o.real !== undefined && samePath(o.real, real));
    const outers = statuses.flatMap((o) =>
      o.real !== undefined && !samePath(o.real, real) && isInside(o.real, real) ? [o.real] : [],
    );
    result.roots.push({ path: x.path, status: same || outers.length > 0 ? "inside-root" : "ok" });
    if (same) continue;
    const owner = outers.reduce((a, b) => (b.length < a.length ? b : a), real);
    walks.push({ index: walks.length, root: real, owner, queue: [{ abs: real, depth: 0 }] });
  }
  const visited = new Set<string>();
  // walk round robin; a limit ends the walk, what was found is kept
  try {
    for (let busy = true; busy; ) {
      busy = false;
      for (const w of walks) {
        if (w.queue.length === 0) continue;
        busy = true;
        await step(w, budget, skipDirs, found, result.skipped, visited);
        progress();
      }
    }
  } catch (err) {
    cut(err);
  }
  // detect what was found (round robin over roots), with a reserve when the walk was cut
  // short (review-1 C1)
  if (result.truncated !== false) budget.reserve();
  let detecting = true;
  for (const f of interleave(found, walks.length)) {
    if (detecting) {
      try {
        drafts.push(await detect(f, loaded.profiles, budget, result.problems));
        progress();
        continue;
      } catch (err) {
        cut(err);
        detecting = false;
      }
    }
    // out of time / bytes: still listed, as not looked at
    drafts.push(unread(f));
  }
  // one candidate with data out of bounds never fails the whole scan (security-1 S2)
  result.candidates = name(nested(mergeMonorepos(drafts))).filter((c) => {
    if (Candidate.safeParse(c).success) return true;
    if (result.problems.length < 500) {
      result.problems.push({ file: clip(c.path, 4096), message: "left out: unexpected data" });
    }
    return false;
  });
  result.finishedAt = new Date().toISOString();
  return fitToStore(result);
}

/** Path shown relative to its scan root (CLI tables). */
export const shownPath = (root: string, abs: string): string => relative(root, abs) || ".";
