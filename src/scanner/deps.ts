/**
 * Declared dependencies of a project (F-006 §3.2): `package.json`, `requirements.txt`,
 * `pyproject.toml` (PEP 621 `[project].dependencies` and `[tool.poetry.dependencies]` only —
 * a small TOML reader for these two tables, no new dependency: Q6). Never runs anything.
 */

const NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,213}$/;
const SPEC_MAX = 200;

type Deps = Map<string, string>;

function put(out: Deps, name: string, spec: string, max: number): void {
  if (out.size >= max || !NAME.test(name) || out.has(name)) return;
  // printable ASCII only: a spec is shown to users and parsed by the range reader
  out.set(name, /^[\x20-\x7e]*$/.test(spec) ? spec.slice(0, SPEC_MAX).trim() : "");
}

/** JSON object or undefined (never throws). */
export function jsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function packageJsonDeps(pkg: Record<string, unknown> | undefined, out: Deps, max: number) {
  if (pkg === undefined) return;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const table = pkg[field];
    if (typeof table !== "object" || table === null || Array.isArray(table)) continue;
    for (const [name, spec] of Object.entries(table)) {
      if (typeof spec === "string") put(out, name, spec, max);
    }
  }
}

/** `name`, `name==1.2`, `name[extra]>=1; python_version<"3.12"`; skips `-r`, `-e`, URLs. */
const REQ = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\s*(\[[A-Za-z0-9,._ -]{0,100}\])?\s*([^;#]*)/;

function requirement(line: string, out: Deps, max: number): void {
  const t = line.trim();
  if (t === "" || t.startsWith("#") || t.startsWith("-") || t.includes("://")) return;
  const m = REQ.exec(t);
  if (m?.[1] === undefined) return;
  put(out, m[1].toLowerCase(), (m[3] ?? "").trim(), max);
}

export function requirementsDeps(text: string | undefined, out: Deps, max: number) {
  if (text === undefined) return;
  for (const line of text.split(/\r?\n/, 10_000)) requirement(line, out, max);
}

/** Value of a TOML basic / literal string (no escapes beyond `\"` / `\\` needed here). */
function tomlString(s: string): string | undefined {
  const t = s.trim();
  const q = t[0];
  if ((q !== '"' && q !== "'") || t.length < 2) return undefined;
  const end = t.indexOf(q, 1);
  return end === -1 ? undefined : t.slice(1, end);
}

/**
 * `[project].dependencies = [ "a>=1", "b" ]` (may span lines) and
 * `[tool.poetry.dependencies]` keys (`fastapi = "^0.110"` / `{ version = "…" }`).
 */
export function pyprojectDeps(text: string | undefined, out: Deps, max: number) {
  if (text === undefined) return;
  const lines = text.split(/\r?\n/, 20_000);
  let table = "";
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    const header = /^\[\s*([A-Za-z0-9_.-]{1,100})\s*\]$/.exec(line);
    if (header?.[1] !== undefined) {
      table = header[1];
      continue;
    }
    if (line.startsWith("[")) {
      table = ""; // array of tables / other headers: not ours
      continue;
    }
    if (table === "project" && /^dependencies\s*=\s*\[/.test(line)) {
      // collect until the closing bracket (at most 2000 lines)
      let body = line.slice(line.indexOf("[") + 1);
      while (!body.includes("]") && i + 1 < lines.length && body.length < 64 * 1024) {
        i++;
        body += `\n${lines[i] ?? ""}`;
      }
      body = body.slice(0, body.indexOf("]") === -1 ? body.length : body.indexOf("]"));
      for (const m of body.matchAll(/"([^"\n]{1,300})"|'([^'\n]{1,300})'/g)) {
        requirement(m[1] ?? m[2] ?? "", out, max);
      }
      continue;
    }
    if (table === "tool.poetry.dependencies") {
      const kv = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\s*=\s*(.+)$/.exec(line);
      if (kv?.[1] === undefined || kv[1].toLowerCase() === "python") continue;
      const value = kv[2] ?? "";
      const spec =
        tomlString(value) ?? /version\s*=\s*("[^"]*"|'[^']*')/.exec(value)?.[1]?.slice(1, -1) ?? "";
      put(out, kv[1].toLowerCase(), spec, max);
    }
  }
}

/** `requires-python = ">=3.11"` of `[project]`. */
export function requiresPython(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let table = "";
  for (const raw of text.split(/\r?\n/, 20_000)) {
    const line = raw.trim();
    const header = /^\[\s*([A-Za-z0-9_.-]{1,100})\s*\]$/.exec(line);
    if (header?.[1] !== undefined) table = header[1];
    else if (table === "project") {
      const m = /^requires-python\s*=\s*(.+)$/.exec(line);
      if (m?.[1] !== undefined) return tomlString(m[1]);
    }
  }
  return undefined;
}
