/**
 * Hints read from a project as text (F-006 §1): the port it used and how (`via`), its runtime
 * version, the folder a static site serves, and §6.3 "not a web project" markers. Config files
 * are never executed or imported — bounded regexes over text only (no nested quantifiers).
 * `.env*` files: only the number of a `PORT` / `*_PORT` key is kept; every other value is
 * dropped at once (Q5).
 */
import type { ComposeService } from "./compose.js";
import { jsonObject, requiresPython } from "./deps.js";
import type { DiskView } from "./view.js";

export interface PortHint {
  value: number;
  via: "arg" | "env" | "fixed";
  env?: string;
  source: string;
}

export interface RuntimeHint {
  lang: string;
  hint: string;
  source: string;
}

const portNum = (s: string | undefined): number | undefined => {
  if (s === undefined || !/^\d{2,5}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : undefined;
};

/** `KEY` that names a port: `PORT`, `BACKEND_PORT` (same rule as profiles, F-005). */
export const PORT_KEY = /^([A-Z][A-Z0-9_]{0,40}_)?PORT$/;

export const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];

/** Port keys of a `.env` text; nothing else leaves this function. */
export function envPorts(text: string): { key: string; value: number }[] {
  const out: { key: string; value: number }[] = [];
  for (const line of text.split(/\r?\n/, 5_000)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{0,63})\s*=\s*["']?(\d{2,5})["']?\s*(?:#.*)?$/.exec(
      line,
    );
    const value = portNum(m?.[2]);
    if (m?.[1] !== undefined && value !== undefined && PORT_KEY.test(m[1])) {
      out.push({ key: m[1], value });
    }
  }
  return out;
}

/** `--port 3001`, `--port=3001`, `-p 3001` in a package.json script. */
export function scriptPort(script: string): number | undefined {
  const m = /(?:^|\s)(?:--port|-p)(?:\s+|=)(\d{2,5})(?=\s|$|&|;)/.exec(script.slice(0, 2000));
  return portNum(m?.[1]);
}

/** `server: { … port: 5173 … }` in a vite config (a literal number only). */
export function vitePort(text: string): number | undefined {
  const m = /\bserver\s*:\s*\{[^{}]{0,2000}?\bport\s*:\s*(\d{2,5})\b/.exec(
    text.slice(0, 256 * 1024),
  );
  return portNum(m?.[1]);
}

/** First `EXPOSE n` of a Dockerfile. */
export function exposePort(text: string): number | undefined {
  return portNum(/^\s*EXPOSE\s+(\d{2,5})\b/im.exec(text.slice(0, 256 * 1024))?.[1]);
}

const VITE_CONFIGS = ["ts", "js", "mjs", "mts", "cjs", "cts"].map((e) => `vite.config.${e}`);

/**
 * The port the project used, first found of: script flag (→ arg, webhub calls the binary with
 * its own flag), vite config (→ arg), `.env*` (→ env), compose `ports` (→ fixed, the container
 * port), Dockerfile `EXPOSE` (→ fixed).
 */
export async function portHint(
  view: DiskView,
  cwd: string,
  compose: readonly ComposeService[],
): Promise<PortHint | undefined> {
  const at = (f: string) => (cwd === "" ? f : `${cwd}/${f}`);
  const pkg = jsonObject(await view.text(at("package.json")));
  const scripts = pkg?.scripts;
  if (typeof scripts === "object" && scripts !== null) {
    for (const name of ["dev", "start", "serve"]) {
      const s = (scripts as Record<string, unknown>)[name];
      const p = typeof s === "string" ? scriptPort(s) : undefined;
      if (p !== undefined) return { value: p, via: "arg", source: `package.json scripts.${name}` };
    }
  }
  for (const f of VITE_CONFIGS) {
    const t = await view.text(at(f));
    const p = t === undefined ? undefined : vitePort(t);
    if (p !== undefined) return { value: p, via: "arg", source: f };
  }
  for (const f of ENV_FILES) {
    // read once, not cached; only port numbers leave envPorts (Q5)
    const t = await view.readOnce(at(f), 64 * 1024);
    if (t === undefined) continue;
    const ports = envPorts(t);
    const hit = ports.find((p) => p.key === "PORT") ?? ports[0];
    if (hit !== undefined) {
      return { value: hit.value, via: "env", env: hit.key, source: `${f} ${hit.key}` };
    }
  }
  for (const s of compose) {
    if (s.infra) continue;
    const p = s.ports[0];
    if (p !== undefined) {
      return { value: p.target, via: "fixed", source: `compose ${s.name} ${p.text}` };
    }
  }
  const docker = await view.text(at("Dockerfile"));
  const e = docker === undefined ? undefined : exposePort(docker);
  return e === undefined ? undefined : { value: e, via: "fixed", source: "Dockerfile EXPOSE" };
}

/** A version-ish string that is safe to show: printable ASCII, short. */
const versionText = (s: string | undefined, max = 60): string | undefined => {
  const t = s?.trim();
  return t !== undefined && t !== "" && t.length <= max && /^[\x20-\x7e]+$/.test(t) ? t : undefined;
};

/** `.nvmrc`, `.node-version`, `engines.node`, `packageManager`, Python, Bun, Dockerfile FROM. */
export async function runtimeHints(view: DiskView, cwd: string): Promise<RuntimeHint[]> {
  const at = (f: string) => (cwd === "" ? f : `${cwd}/${f}`);
  const out: RuntimeHint[] = [];
  const firstLine = async (f: string) =>
    versionText((await view.text(at(f), 1024))?.split(/\r?\n/)[0]);
  for (const [file, lang] of [
    [".nvmrc", "node"],
    [".node-version", "node"],
    [".python-version", "python"],
    [".bun-version", "bun"],
  ] as const) {
    const v = await firstLine(file);
    if (v !== undefined) out.push({ lang, hint: v, source: file });
  }
  const pkg = jsonObject(await view.text(at("package.json")));
  const engines = pkg?.engines;
  if (typeof engines === "object" && engines !== null) {
    for (const lang of ["node", "bun"]) {
      const v = versionText(String((engines as Record<string, unknown>)[lang] ?? ""));
      if (v !== undefined) out.push({ lang, hint: v, source: `package.json engines.${lang}` });
    }
  }
  const pm =
    typeof pkg?.packageManager === "string" ? versionText(pkg.packageManager, 120) : undefined;
  const pmName = pm === undefined ? undefined : /^(npm|pnpm|yarn|bun)@/.exec(pm)?.[1];
  if (pm !== undefined && pmName !== undefined) {
    out.push({ lang: pmName, hint: pm.split("+")[0] ?? pm, source: "package.json packageManager" });
  }
  const rp = versionText(requiresPython(await view.text(at("pyproject.toml"))));
  if (rp !== undefined)
    out.push({ lang: "python", hint: rp, source: "pyproject.toml requires-python" });
  const docker = await view.text(at("Dockerfile"));
  const from =
    docker === undefined
      ? undefined
      : /^\s*FROM\s+(?:--platform=\S{1,60}\s+)?(\S{1,120})/im.exec(docker)?.[1];
  const image = versionText(from, 120);
  if (image !== undefined && /^[a-z0-9][a-z0-9._/:@-]*$/.test(image)) {
    out.push({ lang: "docker", hint: `${image} (hint)`, source: "Dockerfile FROM" });
  }
  return out;
}

/** `public/` / `dist/` / `docs/` holding an `index.html` (first found), else the root. */
export async function publicDir(view: DiskView, cwd: string): Promise<string> {
  for (const d of ["public", "dist", "docs"]) {
    const rel = cwd === "" ? `${d}/index.html` : `${cwd}/${d}/index.html`;
    if ((await view.kind(rel)) === "file") return d;
  }
  return "";
}

const ELECTRON_DEPS = ["electron", "@tauri-apps/api", "@tauri-apps/cli", "tauri"];

/** §6.3 markers that say "not a web project" (reasons). */
export async function notWebReasons(view: DiskView): Promise<string[]> {
  const out: string[] = [];
  const names = await view.names("");
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (names.some((n) => n.toLowerCase() === "manifest.json")) {
    const t = await view.text("manifest.json", 64 * 1024);
    if (t !== undefined && /"manifest_version"\s*:/.test(t))
      out.push("browser extension (manifest.json)");
  }
  if (has(/\.rbxlx?$/i)) out.push("Roblox place (*.rbxl)");
  if (has(/\.uproject$/i)) out.push("Unreal project (*.uproject)");
  if ((await view.kind("ProjectSettings")) === "dir") out.push("Unity project (ProjectSettings/)");
  for (const n of names.filter((x) => /\.csproj$/i.test(x)).slice(0, 4)) {
    const t = await view.text(n, 64 * 1024);
    if (t !== undefined && !/Microsoft\.AspNetCore|Microsoft\.NET\.Sdk\.Web/.test(t)) {
      out.push(`.NET project without ASP.NET Core (${n})`);
      break;
    }
  }
  const deps = await view.settle(() => view.deps());
  const desktop = ELECTRON_DEPS.find((d) => deps.has(d));
  if (desktop !== undefined) out.push(`desktop app (dep ${desktop})`);
  return out;
}
