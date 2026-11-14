/**
 * Small version ranges for profile `variants` (F-005 §3.1, Q6): space-separated comparators that
 * must all hold — `>=6`, `<13`, `>=13 <15`, `^1.2.3`, `~1.2`, `=5`, `5.x`. No `||`, no
 * pre-release tags. Partial versions follow npm: `6` = `>=6.0.0 <7.0.0`, `>6` = `>=7.0.0`.
 */

export type Version = readonly [number, number, number];

interface Bound {
  /** Inclusive lower bound. */
  min?: Version;
  /** Exclusive upper bound. */
  max?: Version;
}

const MAX_RANGE_LENGTH = 64;
const MAX_COMPARATORS = 4;
const PART = /^(0|[1-9]\d{0,5})$/;

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** "6" → [6], "6.1.x" → [6, 1]; undefined when not a plain partial version. */
function partial(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length === 0 || parts.length > 3) return undefined;
  const out: number[] = [];
  for (const [i, p] of parts.entries()) {
    if (p === "x" || p === "X" || p === "*") {
      // a wildcard ends the version: "6.x.1" is not allowed
      if (parts.slice(i + 1).some((q) => q !== "x" && q !== "X" && q !== "*")) return undefined;
      break;
    }
    if (!PART.test(p)) return undefined;
    out.push(Number(p));
  }
  return out;
}

const full = (p: readonly number[]): Version => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];

/** The first version after every version that starts with `p` ([6] → 7.0.0, [6,1] → 6.2.0). */
function after(p: readonly number[]): Version {
  if (p.length === 0) return [Number.MAX_SAFE_INTEGER, 0, 0];
  const v = [...p];
  v[v.length - 1] = (v[v.length - 1] ?? 0) + 1;
  return full(v);
}

function comparator(text: string): Bound {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(.+)$/.exec(text);
  const p = m?.[2] === undefined ? undefined : partial(m[2]);
  if (m === null || p === undefined || p.length === 0) {
    throw new Error(`invalid version comparator "${text}"`);
  }
  const op = m[1] ?? "=";
  switch (op) {
    case ">=":
      return { min: full(p) };
    case ">":
      return { min: after(p) }; // >6 = >=7.0.0, >6.1.2 = >=6.1.3
    case "<":
      return { max: full(p) };
    case "<=":
      return { max: after(p) };
    case "^": {
      const [major = 0, minor, patch] = p;
      if (major > 0 || p.length === 1) return { min: full(p), max: [major + 1, 0, 0] };
      if ((minor ?? 0) > 0 || p.length === 2)
        return { min: full(p), max: [0, (minor ?? 0) + 1, 0] };
      return { min: full(p), max: [0, 0, (patch ?? 0) + 1] };
    }
    case "~":
      return { min: full(p), max: after(p.length === 1 ? p : p.slice(0, 2)) };
    default:
      // "=" or bare: an exact version, or every version that starts with the partial
      return { min: full(p), max: after(p) };
  }
}

export type Range = readonly Bound[];

/** Parses a range; throws Error with a short message (no input echoed beyond the comparator). */
export function parseRange(text: string): Range {
  if (text.length === 0 || text.length > MAX_RANGE_LENGTH) {
    throw new Error(`range must be 1–${MAX_RANGE_LENGTH} characters`);
  }
  const parts = text.trim().split(/\s+/);
  if (parts.length > MAX_COMPARATORS) {
    throw new Error(`range has more than ${MAX_COMPARATORS} comparators`);
  }
  return parts.map(comparator);
}

export function satisfies(v: Version, range: Range): boolean {
  return range.every(
    (b) =>
      (b.min === undefined || compareVersions(v, b.min) >= 0) &&
      (b.max === undefined || compareVersions(v, b.max) < 0),
  );
}

/**
 * The lowest version a project's dependency spec allows: `^6.0.3` → 6.0.3, `~5.2` → 5.2.0,
 * `>=15` → 15.0.0, `6.x` → 6.0.0. Anything else (`latest`, `workspace:*`, git / file / npm:
 * aliases, `||` ranges, tags) → undefined: no variant applies.
 */
export function lowestVersion(spec: string): Version | undefined {
  const s = spec.trim();
  if (s.length === 0 || s.length > MAX_RANGE_LENGTH || s.includes("||")) return undefined;
  const first = s.split(/\s+/)[0] ?? "";
  const m = /^(?:>=|\^|~|=)?v?(.+)$/.exec(first);
  if (m?.[1] === undefined) return undefined;
  // pre-release / build suffix: the release it belongs to
  const core = m[1].replace(/[-+].*$/, "");
  const p = partial(core);
  return p === undefined || p.length === 0 ? undefined : full(p);
}
