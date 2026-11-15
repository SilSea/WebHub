/**
 * Evaluates a profile's `detect` rules and `variants` against a project (F-005 §3.2). Pure: the
 * caller (the scanner, F-006) gives a `ProjectView` that is confined to the project root, and
 * F-005 never walks or opens project files itself.
 */
import { lowestVersion, parseRange, satisfies } from "./range.js";
import { type DetectRule, deepMerge, MAX_CONTAINS_BYTES, type Profile } from "./schema.js";

export interface ProjectView {
  /** File or folder exists (`rel` uses "/", is relative and validated by the profile schema). */
  exists(rel: string): boolean;
  /** Names in a folder ("" = the project root); [] when missing. */
  list(relDir: string): readonly string[];
  /** File content as UTF-8, at most `maxBytes`; undefined when missing / unreadable. */
  read(rel: string, maxBytes: number): string | undefined;
  /** Declared dependencies: name → version spec (`^6.0.3`, …). */
  deps(): ReadonlyMap<string, string>;
  /** File names compare case-insensitively (Windows). */
  readonly caseInsensitive?: boolean;
}

export interface DetectResult {
  matched: boolean;
  /** `detect.score` when matched, else 0. */
  score: number;
  /** Rules that held, e.g. `file vite.config.*`, `dep next`. */
  reasons: string[];
}

/**
 * `*` matches any run of characters within one name. Iterative with one back-track point:
 * O(name × pattern) at worst, both ≤ a few hundred characters (no regex, no ReDoS).
 */
export function wildcardMatch(pattern: string, name: string, caseInsensitive = false): boolean {
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;
  const s = caseInsensitive ? name.toLowerCase() : name;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] !== "*" && p[pi] === s[si]) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (p[pi] === "*") pi++;
  return pi === p.length;
}

/** Wildcard matches kept per alternative (sorted by name first: the same on every machine). */
export const MAX_WILDCARD_MATCHES = 32;
/**
 * Project files one profile's detect rules read at most (`fileContains`): bounds the work a
 * profile can cause on a big project (security-1 S6): once for `all` / `any`, once for `none`.
 * Further reads count as "not found".
 */
export const MAX_READS_PER_PROFILE = 64;

/** Paths in the project that one alternative names (`*` only in the last segment). */
function resolveAlt(alt: string, view: ProjectView): string[] {
  const dir = alt.endsWith("/");
  const clean = dir ? alt.slice(0, -1) : alt;
  if (!clean.includes("*")) return view.exists(alt) ? [clean] : [];
  const cut = clean.lastIndexOf("/");
  const parent = cut === -1 ? "" : clean.slice(0, cut);
  const last = clean.slice(cut + 1);
  return view
    .list(parent)
    .filter((n) => wildcardMatch(last, n, view.caseInsensitive === true))
    .sort()
    .slice(0, MAX_WILDCARD_MATCHES)
    .map((n) => (parent === "" ? n : `${parent}/${n}`))
    .filter((rel) => view.exists(dir ? `${rel}/` : rel));
}

const resolvePattern = (pattern: string, view: ProjectView) =>
  pattern.split("|").flatMap((alt) => resolveAlt(alt, view));

function depHolds(name: string, range: string | undefined, view: ProjectView): boolean {
  const spec = view.deps().get(name);
  if (spec === undefined) return false;
  if (range === undefined) return true;
  const v = lowestVersion(spec);
  return v !== undefined && satisfies(v, parseRange(range));
}

function ruleHolds(
  rule: DetectRule,
  view: ProjectView,
  budget: { reads: number },
): string | undefined {
  if (rule.file !== undefined) {
    return resolvePattern(rule.file, view).length > 0 ? `file ${rule.file}` : undefined;
  }
  if (rule.fileContains !== undefined) {
    const [files, needles] = rule.fileContains;
    const alts = needles.split("|");
    for (const rel of resolvePattern(files, view)) {
      if (budget.reads >= MAX_READS_PER_PROFILE) return undefined;
      budget.reads++;
      const content = view.read(rel, MAX_CONTAINS_BYTES);
      const hit = content === undefined ? undefined : alts.find((n) => content.includes(n));
      if (hit !== undefined) return `${rel} contains "${hit}"`;
    }
    return undefined;
  }
  if (rule.dep !== undefined) {
    return depHolds(rule.dep, rule.range, view)
      ? `dep ${rule.dep}${rule.range === undefined ? "" : ` ${rule.range}`}`
      : undefined;
  }
  return undefined;
}

export function evaluateDetect(p: Profile, view: ProjectView): DetectResult {
  const reasons: string[] = [];
  const budget = { reads: 0 };
  // `none` has its own budget: reads used up by all / any must not turn an exclusion off
  // (review-2 L3)
  const noneBudget = { reads: 0 };
  const check = (r: DetectRule) => {
    const why = ruleHolds(r, view, budget);
    if (why !== undefined) reasons.push(why);
    return why !== undefined;
  };
  const { all = [], any = [], none = [] } = p.detect;
  const allOk = all.every(check);
  const anyOk = allOk && (any.length === 0 || any.some(check));
  const noneHit = anyOk && none.some((r) => ruleHolds(r, view, noneBudget) !== undefined);
  const matched = allOk && anyOk && !noneHit;
  return { matched, score: matched ? p.detect.score : 0, reasons: matched ? reasons : [] };
}

/**
 * The profile with every variant whose `when` holds applied in file order (DESIGN §19.5);
 * `variants` itself is dropped from the result.
 */
export function effectiveProfile(p: Profile, deps: ReadonlyMap<string, string>): Profile {
  const { variants = [], ...base } = p;
  let out: Profile = base;
  for (const { when, ...over } of variants) {
    const spec = deps.get(when.dep);
    const v = spec === undefined ? undefined : lowestVersion(spec);
    if (v !== undefined && satisfies(v, parseRange(when.range))) out = deepMerge(out, over);
  }
  return out;
}
