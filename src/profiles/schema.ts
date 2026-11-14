/**
 * Runtime profile format, schemaVersion 1 (F-005 §3.1, DESIGN §6.1 / §19.5).
 *
 * Every object is strict (an unknown key is an error, a typo never goes unnoticed). Detection
 * rules have no regular expressions (no ReDoS): file patterns with `*` in the last segment and
 * plain substrings. Commands are split into argv and never reach a shell (command.ts).
 */
import { basename } from "node:path";
import { isAlias, isPair, isScalar, LineCounter, parseDocument, visit } from "yaml";
import { z } from "zod";
import { WebhubError } from "../errors.js";
import {
  BUILTIN_PLACEHOLDERS,
  CommandError,
  isSafeValue,
  namesNonLoopback,
  placeholdersOf,
  splitCommand,
  VAR_NAME,
} from "./command.js";
import { parseRange } from "./range.js";

export const PROFILE_SCHEMA_VERSION = 1;
/** Largest profile file read (bytes). */
export const MAX_PROFILE_BYTES = 256 * 1024;
/** Bytes of one project file a `fileContains` rule reads at most. */
export const MAX_CONTAINS_BYTES = 256 * 1024;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** YAML nodes per profile at most (real profiles have < 200): bounds every pass after parsing. */
export const MAX_PROFILE_NODES = 5000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !CONTROL.test(s), { message: "must not contain control characters" });

/** Problems of one `a|b` file pattern (empty = fine). */
export function patternProblems(pattern: string): string[] {
  const out: string[] = [];
  const alts = pattern.split("|");
  if (alts.length > 8) out.push("at most 8 alternatives");
  for (const alt of alts) {
    if (alt === "") {
      out.push("empty alternative");
      continue;
    }
    if (alt.startsWith("/") || alt.includes("\\") || alt.includes(":")) {
      out.push(`"${alt}" must be a relative path with "/" (no drive, no "\\", no ":")`);
      continue;
    }
    if (!/^[A-Za-z0-9._*+@/-]+$/.test(alt)) {
      out.push(`"${alt}" has characters other than letters, digits and . _ * + @ / -`);
      continue;
    }
    const segs = (alt.endsWith("/") ? alt.slice(0, -1) : alt).split("/");
    if (segs.length > 8) out.push(`"${alt}" is deeper than 8 levels`);
    for (const [i, seg] of segs.entries()) {
      if (seg === "" || seg === "." || seg === "..") {
        out.push(`"${alt}" has an empty, "." or ".." segment`);
        break;
      }
      if (seg.includes("*") && i !== segs.length - 1) {
        out.push(`"${alt}": "*" is allowed in the last segment only`);
        break;
      }
      if ((seg.match(/\*/g)?.length ?? 0) > 4) {
        out.push(`"${alt}": at most 4 "*" in a segment`);
        break;
      }
    }
  }
  return out;
}

const pattern = z
  .string()
  .min(1)
  .max(200)
  .superRefine((s, ctx) => {
    for (const message of patternProblems(s)) ctx.addIssue({ code: "custom", message });
  });

/** `a|b` substrings for `fileContains`. */
const needles = text(400).superRefine((s, ctx) => {
  const alts = s.split("|");
  if (alts.length > 8 || alts.some((a) => a.length === 0 || a.length > 100)) {
    ctx.addIssue({ code: "custom", message: "1–8 alternatives of 1–100 characters each" });
  }
});

const depName = z
  .string()
  .max(214)
  .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i, {
    message: "must be a package name",
  });

const range = z
  .string()
  .max(64)
  .superRefine((s, ctx) => {
    try {
      parseRange(s);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
    }
  });

const Rule = z
  .strictObject({
    file: pattern.optional(),
    fileContains: z.tuple([pattern, needles]).optional(),
    dep: depName.optional(),
    range: range.optional(),
  })
  .superRefine((r, ctx) => {
    const kinds = [r.file, r.fileContains, r.dep].filter((k) => k !== undefined).length;
    if (kinds !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "a rule has exactly one of file, fileContains, dep",
      });
    }
    if (r.range !== undefined && r.dep === undefined) {
      ctx.addIssue({ code: "custom", message: "range is allowed with dep only", path: ["range"] });
    }
  });

const rules = z.array(Rule).max(16);

const Detect = z
  .strictObject({
    all: rules.optional(),
    any: rules.optional(),
    none: rules.optional(),
    score: z.number().int().min(0).max(100),
  })
  .refine((d) => (d.all?.length ?? 0) + (d.any?.length ?? 0) > 0, {
    message: "detect needs at least one rule in all or any",
  });

const command = z
  .string()
  .max(1000)
  .superRefine((s, ctx) => {
    try {
      splitCommand(s);
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      ctx.addIssue({ code: "custom", message: err.message });
    }
  });

const varValue = z.string().refine(isSafeValue, {
  message:
    "1–200 of letters, digits and . _ : @ / + = - (not starting with -, not a non-loopback address)",
});

const port = z.number().int().min(1).max(65535);
/** `PORT` or `<NAME>_PORT` only: never PATH, PATHEXT, NODE_OPTIONS, ComSpec … (security-1 S5). */
const portEnvName = z.string().regex(/^([A-Z][A-Z0-9_]{0,40}_)?PORT$/, {
  message: "PORT or <NAME>_PORT (e.g. SERVER_PORT)",
});

const Runtime = z.strictObject({
  lang: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/, { message: "lowercase language id" }),
  install: command.optional(),
});
const Start = z.strictObject({
  cmd: command,
  vars: z
    .record(z.string().regex(VAR_NAME, { message: "invalid variable name" }), varValue)
    .refine((v) => Object.keys(v).length <= 16, { message: "at most 16 vars" })
    .optional(),
});
const Port = z.strictObject({
  default: port,
  via: z.enum(["env", "arg", "fixed"]),
  env: portEnvName.optional(),
});
const Host = z.strictObject({
  // never outside loopback: no LAN exposure, no firewall prompt (DESIGN §6.1 / §17 10b)
  bind: z.enum(["127.0.0.1", "::1"]),
});
const DevServer = z.strictObject({ hostRewrite: z.boolean() });
const Health = z.strictObject({
  path: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,199}$/, { message: "a path like /docs" }),
  timeout: z.number().int().min(1).max(600),
});
const Container = z.strictObject({
  image: z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,199}$/, { message: "an image reference" }),
  workdir: z.string().regex(/^\/[A-Za-z0-9._/-]{0,199}$/, { message: "an absolute POSIX path" }),
  setup: command.optional(),
});
const Db = z.strictObject({ hints: z.array(text(60)).max(32) });
const Routes = z.strictObject({ detectPrefix: z.array(text(100)).max(32) });
const Static = z.strictObject({ spa: z.boolean() });

/** What a variant may change: the same sections, every key optional (deep merge). */
const Variant = z.strictObject({
  when: z.strictObject({ dep: depName, range }),
  runtime: Runtime.partial().optional(),
  start: Start.partial().optional(),
  // `env: null` removes port.env when a variant switches away from via env (review-1 K9)
  port: Port.partial().extend({ env: portEnvName.nullable().optional() }).optional(),
  devServer: DevServer.partial().optional(),
  health: Health.partial().optional(),
  container: Container.partial().optional(),
});

const Base = z.strictObject({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, {
    message: "2–40 of a-z, 0-9, - (starting with a letter)",
  }),
  language: z.string().regex(/^[a-z][a-z0-9+#.-]{0,19}$/, { message: "lowercase language name" }),
  detect: Detect,
  static: Static.optional(),
  runtime: Runtime.optional(),
  start: Start.optional(),
  port: Port.optional(),
  host: Host.optional(),
  devServer: DevServer.optional(),
  health: Health.optional(),
  container: Container.optional(),
  db: Db.optional(),
  routes: Routes.optional(),
  variants: z.array(Variant).max(16).optional(),
});

export type Profile = z.infer<typeof Base>;
export type DetectRule = z.infer<typeof Rule>;

/** Checks that need the whole profile (also run on every variant applied to it). */
const splitSafe = (cmd: string): string[] => {
  try {
    return splitCommand(cmd);
  } catch {
    return []; // reported by the field's own check
  }
};

function crossProblems(p: Omit<Profile, "variants">): { path: PropertyKey[]; message: string }[] {
  const out: { path: PropertyKey[]; message: string }[] = [];
  if ((p.start === undefined) === (p.static === undefined)) {
    out.push({ path: [], message: "a profile has exactly one of start (a process) or static" });
  }
  const known = new Set<string>([...BUILTIN_PLACEHOLDERS, ...Object.keys(p.start?.vars ?? {})]);
  const cmds: [PropertyKey[], string | undefined][] = [
    [["start", "cmd"], p.start?.cmd],
    [["runtime", "install"], p.runtime?.install],
    [["container", "setup"], p.container?.setup],
  ];
  for (const [path, cmd] of cmds) {
    if (cmd !== undefined && splitSafe(cmd).some(namesNonLoopback)) {
      out.push({
        path,
        message: "binds outside loopback (0.0.0.0, ::, a LAN address); use {HOST}",
      });
    }
    for (const name of cmd === undefined ? [] : placeholdersOf(cmd)) {
      if (!known.has(name)) {
        out.push({ path, message: `unknown placeholder {${name}} (declare it in start.vars)` });
      }
    }
  }
  for (const name of Object.keys(p.start?.vars ?? {})) {
    if ((BUILTIN_PLACEHOLDERS as readonly string[]).includes(name)) {
      out.push({ path: ["start", "vars", name], message: `{${name}} is set by webhub` });
    }
  }
  if (p.start !== undefined && p.port === undefined) {
    out.push({ path: ["port"], message: "a profile with start needs port" });
  }
  if (p.port?.via === "arg" && !placeholdersOf(p.start?.cmd ?? "").includes("PORT")) {
    out.push({ path: ["start", "cmd"], message: "port.via arg needs {PORT} in start.cmd" });
  }
  if (p.port?.via === "env" && p.port.env === undefined) {
    out.push({ path: ["port", "env"], message: "port.via env needs port.env (e.g. PORT)" });
  }
  if (p.port?.via !== "env" && p.port?.env !== undefined) {
    out.push({ path: ["port", "env"], message: "port.env is used with via env only" });
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars replace; `null` removes the key. Inputs are not changed. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (FORBIDDEN_KEYS.has(k) || v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = deepMerge(out[k], v);
  }
  return out as T;
}

export const ProfileSchema = Base.superRefine((p, ctx) => {
  for (const issue of crossProblems(p)) ctx.addIssue({ code: "custom", ...issue });
  // every variant must give a valid profile alone, and so must all of them applied in order
  // (several can hold at once) — caught at load, not at start (review-1 K9)
  const base = { ...p, variants: undefined };
  let all: typeof base = base;
  for (const [i, v] of (p.variants ?? []).entries()) {
    const { when: _when, ...over } = v;
    all = deepMerge(all, over);
    const alone = crossProblems(deepMerge(base, over)).map(
      (x) => `with this variant: ${x.message}`,
    );
    const together = crossProblems(all).map((x) => `with variants 0–${i} together: ${x.message}`);
    for (const message of new Set([...alone, ...(alone.length > 0 ? [] : together)])) {
      ctx.addIssue({ code: "custom", path: ["variants", i], message });
    }
  }
});

function profileError(file: string, details: string[]): WebhubError {
  return new WebhubError("CONFIG_INVALID", `invalid profile ${basename(file)}`, {
    file,
    details,
    hint: "Fix the file (DESIGN §6.1 / `webhub profiles --check`).",
  });
}

const pathText = (path: readonly PropertyKey[]) =>
  path.length === 0 ? "(profile)" : path.map(String).join(".");

/**
 * Parses + validates one profile file. YAML is read with the core schema only: no custom tags,
 * no aliases (no alias bombs), no duplicate keys, a single document; `__proto__` /
 * `constructor` / `prototype` keys are refused anywhere. Throws WebhubError CONFIG_INVALID with
 * `line N: path: message` details.
 */
export function parseProfile(source: string, file: string): Profile {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lc = new LineCounter();
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text, {
      lineCounter: lc,
      schema: "core",
      customTags: [],
      merge: false,
      // the yaml package's duplicate-key check is quadratic (a 256 KB file of short keys blocked
      // the daemon ~16 s — security-1 S1): duplicates are found below with a Set per map
      uniqueKeys: false,
      strict: true,
      prettyErrors: false,
      version: "1.2",
    });
  } catch (err) {
    // deep nesting can overflow the parser's stack: a problem, not a crash
    throw profileError(file, [`could not parse YAML (${(err as Error).name})`]);
  }
  const lineOf = (offset: number | undefined) =>
    offset === undefined ? undefined : lc.linePos(offset).line;
  // warnings too: an unknown tag (`!!js/function`) is only a warning in the yaml package
  const issues = [...doc.errors, ...doc.warnings];
  if (issues.length > 0) {
    throw profileError(
      file,
      issues.slice(0, 5).map((e) => {
        const line = e.linePos?.[0]?.line;
        // the code only: YAML messages may quote long stretches of the file
        return `${line === undefined ? "" : `line ${line}: `}YAML ${e.code}`;
      }),
    );
  }
  const bad: string[] = [];
  let nodes = 0;
  visit(doc, {
    Map(_k, map) {
      const seen = new Set<string>();
      for (const pair of map.items) {
        if (!isPair(pair) || !isScalar(pair.key)) continue;
        // 1 and "1" become the same object key: one duplicate
        const name = String(pair.key.value);
        if (seen.has(name)) {
          bad.push(`line ${lineOf(pair.key.range?.[0])}: duplicate key`);
          return visit.BREAK;
        }
        seen.add(name);
      }
    },
    Alias(_k, node) {
      bad.push(`line ${lineOf(node.range?.[0])}: aliases (*name) are not allowed`);
      return visit.BREAK;
    },
    Pair(_k, pair) {
      const key = isScalar(pair.key) ? pair.key.value : pair.key;
      if (typeof key === "string" && FORBIDDEN_KEYS.has(key)) {
        const at = isScalar(pair.key) ? lineOf(pair.key.range?.[0]) : undefined;
        bad.push(`line ${at}: key "${key}" is not allowed`);
      } else if (key !== null && typeof key === "object") {
        bad.push("complex keys are not allowed");
      }
    },
    Node(_k, node) {
      if (++nodes > MAX_PROFILE_NODES) {
        bad.push(`more than ${MAX_PROFILE_NODES} YAML nodes`);
        return visit.BREAK;
      }
      if (
        !isAlias(node) &&
        typeof node.tag === "string" &&
        node.tag.startsWith("!") &&
        !node.tag.startsWith("!!")
      ) {
        bad.push(`line ${lineOf(node.range?.[0])}: custom tags are not allowed`);
      }
    },
  });
  if (bad.length > 0) throw profileError(file, bad.slice(0, 5));
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 0 });
  } catch (err) {
    throw profileError(file, [`could not read YAML (${(err as Error).name})`]);
  }
  if (!isObject(raw)) throw profileError(file, ["a profile is a YAML mapping (key: value)"]);
  const version = raw.schemaVersion;
  if (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version > PROFILE_SCHEMA_VERSION
  ) {
    throw new WebhubError(
      "CONFIG_FROM_NEWER_VERSION",
      `profile ${basename(file)} needs a newer webhub (schemaVersion ${version} > ${PROFILE_SCHEMA_VERSION})`,
      { file, hint: "Update webhub, or use a profile written for this version." },
    );
  }
  const res = ProfileSchema.safeParse(raw);
  if (res.success) return res.data;
  const details = res.error.issues.slice(0, 20).map((issue) => {
    // the line of the deepest node that exists on the issue's path
    let line: number | undefined;
    for (let n = issue.path.length; n >= 0 && line === undefined; n--) {
      const node = doc.getIn(issue.path.slice(0, n) as unknown[], true) as
        | { range?: [number, number, number] }
        | undefined;
      line = lineOf(node?.range?.[0]);
    }
    return `${line === undefined ? "" : `line ${line}: `}${pathText(issue.path)}: ${issue.message}`;
  });
  throw profileError(file, details);
}
