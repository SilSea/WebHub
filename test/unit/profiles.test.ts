import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhubError } from "../../src/errors.js";
import {
  CommandError,
  namesNonLoopback,
  renderCommand,
  splitCommand,
} from "../../src/profiles/command.js";
import { loadProfiles, MAX_USER_PROFILES } from "../../src/profiles/loader.js";
import {
  effectiveProfile,
  evaluateDetect,
  MAX_READS_PER_PROFILE,
  MAX_WILDCARD_MATCHES,
  wildcardMatch,
} from "../../src/profiles/match.js";
import { lowestVersion, parseRange, satisfies, type Version } from "../../src/profiles/range.js";
import { MAX_PROFILE_BYTES, type Profile, parseProfile } from "../../src/profiles/schema.js";
import { tempHome } from "../helpers/home.js";
import { memView } from "../helpers/project-view.js";

const MIN = `schemaVersion: 1
id: demo
language: node
detect:
  all: [{ file: "package.json" }]
  score: 60
start: { cmd: "demo --port {PORT}" }
port: { default: 3000, via: arg }
`;

const invalid = (text: string): WebhubError => {
  try {
    parseProfile(text, "data/profiles/demo.yml");
  } catch (err) {
    expect(err).toBeInstanceOf(WebhubError);
    return err as WebhubError;
  }
  throw new Error("expected an invalid profile");
};
const details = (text: string) => invalid(text).details.join("\n");

describe("profile schema (F-005 §3.1)", () => {
  it("parses a minimal profile", () => {
    const p = parseProfile(MIN, "demo.yml");
    expect(p).toMatchObject({ id: "demo", port: { via: "arg" }, detect: { score: 60 } });
  });

  it("unknown key, wrong type, out of range → line + field path", () => {
    expect(details(`${MIN}colour: red\n`)).toMatch(/line 1: \(profile\): .*colour/);
    expect(details(MIN.replace("score: 60", "score: 160"))).toMatch(/line 6: detect\.score:/);
    expect(details(MIN.replace("default: 3000", 'default: "x"'))).toMatch(/line 8: port\.default:/);
    expect(details(MIN.replace("{ file: ", "{ fiel: "))).toMatch(/line 5: detect\.all\.0/);
  });

  it("cross checks: start xor static, placeholders, via arg / env, port needed", () => {
    expect(details(`${MIN}static: { spa: false }\n`)).toMatch(/exactly one of start/);
    expect(details(MIN.replace("{PORT}", "{PORT} {module}"))).toMatch(
      /unknown placeholder \{module\}/,
    );
    expect(details(MIN.replace("demo --port {PORT}", "demo"))).toMatch(/needs \{PORT\}/);
    expect(details(MIN.replace("via: arg", "via: env"))).toMatch(/needs port\.env/);
    expect(details(MIN.replace("port: { default: 3000, via: arg }\n", ""))).toMatch(/needs port/);
    expect(
      details(
        MIN.replace('cmd: "demo --port {PORT}"', 'cmd: "demo --port {PORT}", vars: { PORT: "1" }'),
      ),
    ).toMatch(/set by webhub/);
  });

  it("host.bind is loopback only (§6 threat model)", () => {
    expect(details(`${MIN}host: { bind: "0.0.0.0" }\n`)).toMatch(/host\.bind/);
    expect(parseProfile(`${MIN}host: { bind: "::1" }\n`, "x").host?.bind).toBe("::1");
  });

  it("rule patterns: no .., absolute, drive, backslash; * only in the last segment", () => {
    for (const bad of [
      "../x",
      "/etc/passwd",
      "C:/x",
      "a\\b",
      "a/../b",
      "*/x.json",
      "a//b",
      "x y",
    ]) {
      expect(details(MIN.replace('"package.json"', JSON.stringify(bad)))).toMatch(
        /detect\.all\.0\.file/,
      );
    }
    expect(() =>
      parseProfile(MIN.replace('"package.json"', '"src/*.config.*|ProjectSettings/"'), "x"),
    ).not.toThrow();
  });

  it("a rule has exactly one kind; range only with dep; ranges are checked", () => {
    expect(details(MIN.replace('{ file: "package.json" }', '{ file: "a", dep: "b" }'))).toMatch(
      /exactly one of/,
    );
    expect(details(MIN.replace('{ file: "package.json" }', '{ file: "a", range: ">=1" }'))).toMatch(
      /range is allowed/,
    );
    expect(
      details(MIN.replace('{ file: "package.json" }', '{ dep: "vite", range: ">=x" }')),
    ).toMatch(/invalid version/);
    expect(details(MIN.replace('all: [{ file: "package.json" }]', "all: []"))).toMatch(
      /at least one rule/,
    );
  });

  it("variants: each one must give a valid profile", () => {
    const v = `${MIN}variants:\n  - when: { dep: demo, range: "<2" }\n    port: { via: env }\n`;
    expect(details(v)).toMatch(/variants\.0: with this variant: port\.via env needs port\.env/);
  });

  it("commands refuse shell characters, quotes stay one argument", () => {
    for (const c of [
      "a & b",
      "a | b",
      "a; b",
      "a > f",
      "a `x`",
      "a $(x)",
      "a %PATH%",
      "a ^b",
      "a !x",
      "a\nb",
      "a (b)",
      "-x a",
    ]) {
      expect(() => splitCommand(c), c).toThrow(CommandError);
    }
    expect(splitCommand(`node "my app.js" --x 'a b'`)).toEqual(["node", "my app.js", "--x", "a b"]);
    expect(() => splitCommand('node "open')).toThrow(/unclosed quote/);
    expect(() => splitCommand("node {x")).toThrow(/stray/);
    expect(details(MIN.replace("demo --port {PORT}", "demo --port {PORT} && evil"))).toMatch(
      /shell character/,
    );
  });

  it("renderCommand: values replace inside one argument; unsafe / missing values refused", () => {
    expect(
      renderCommand("uvicorn {module}:app --port {PORT}", { module: "app.main", PORT: "8000" }),
    ).toEqual(["uvicorn", "app.main:app", "--port", "8000"]);
    expect(() => renderCommand("x {PORT}", {})).toThrow(/no value/);
    for (const v of ["a b", "-x", "a&b", 'a"', "", "a%b", "a\\b"]) {
      expect(() => renderCommand("x {v}", { v }), v).toThrow(/unsafe value/);
    }
    expect(() => renderCommand("x {toString}", {})).toThrow(/no value/);
  });

  it("vars values are checked at load", () => {
    expect(
      details(MIN.replace('"demo --port {PORT}"', '"demo {m} --port {PORT}", vars: { m: "a b" }')),
    ).toMatch(/start\.vars\.m/);
  });

  it("schemaVersion newer → CONFIG_FROM_NEWER_VERSION; missing → invalid", () => {
    expect(invalid(MIN.replace("schemaVersion: 1", "schemaVersion: 2")).code).toBe(
      "CONFIG_FROM_NEWER_VERSION",
    );
    expect(details(MIN.replace("schemaVersion: 1\n", ""))).toMatch(/schemaVersion/);
  });

  describe("YAML safety (§6)", () => {
    it("aliases (alias bomb) refused without expanding", () => {
      const bomb = [
        "a: &a [x, x, x, x, x, x, x, x, x]",
        ...Array.from(
          { length: 9 },
          (_, i) =>
            `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}]`,
        ),
      ].join("\n");
      const t0 = Date.now();
      expect(details(bomb)).toMatch(/aliases/);
      expect(Date.now() - t0).toBeLessThan(2_000);
    });

    it("__proto__ / constructor keys refused; Object.prototype untouched", () => {
      expect(details(`${MIN}__proto__: { polluted: true }\n`)).toMatch(
        /"__proto__" is not allowed/,
      );
      expect(
        details(
          MIN.replace("vars", "x").replace(
            'cmd: "demo --port {PORT}"',
            'cmd: "demo --port {PORT}", vars: { constructor: "a" }',
          ),
        ),
      ).toMatch(/"constructor" is not allowed/);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("custom tags, duplicate keys, several documents, non-mapping → problem", () => {
      expect(details(`${MIN}db: !!js/function "x"\n`)).toMatch(/YAML|tags/);
      expect(details(`${MIN}db: !custom x\n`)).toMatch(/custom tags|YAML/);
      expect(details(`${MIN}id: other\n`)).toMatch(/line 9: duplicate key/);
      expect(details(`${MIN}---\nid: x\n`)).toMatch(/YAML/);
      expect(details("- a\n- b\n")).toMatch(/mapping/);
    });

    it("deep nesting does not crash or hang", () => {
      const deep = `${"[".repeat(50_000)}${"]".repeat(50_000)}`;
      const t0 = Date.now();
      expect(invalid(deep).code).toBe("CONFIG_INVALID");
      expect(Date.now() - t0).toBeLessThan(5_000);
    });

    it("256 KB of keys (flow or block) is refused fast — no quadratic duplicate check (security-1 S1)", () => {
      const block = Array.from({ length: 28_000 }, (_, i) => `${i}: 1`).join("\n");
      const flow = `{${Array.from({ length: 22_000 }, (_, i) => `a${i}: 1`).join(", ")}}`;
      for (const text of [block, flow]) {
        expect(text.length).toBeLessThan(MAX_PROFILE_BYTES);
        const t0 = Date.now();
        expect(details(text)).toMatch(/more than 5000 YAML nodes/);
        expect(Date.now() - t0).toBeLessThan(2_000);
      }
      // duplicates are still found, also 1 vs "1"
      expect(details(`${MIN}id: other\n`)).toMatch(/line 9: duplicate key/);
      expect(details('a: 1\n"a": 2\n')).toMatch(/duplicate key/);
      expect(details('1: 1\n"1": 2\n')).toMatch(/duplicate key/);
    });

    it("YAML error messages do not echo file content", () => {
      const e = invalid(`${MIN}secret: "SUPERSECRETVALUE\n`);
      expect(JSON.stringify(e.details) + e.message).not.toContain("SUPERSECRETVALUE");
    });
  });
});

describe("version ranges (Q6)", () => {
  const v = (s: string): Version => {
    const r = lowestVersion(s);
    if (r === undefined) throw new Error(s);
    return r;
  };
  const sat = (ver: string, range: string) => satisfies(v(ver), parseRange(range));

  it("comparators and partial versions", () => {
    expect(sat("6.0.0", ">=6")).toBe(true);
    expect(sat("5.9.9", ">=6")).toBe(false);
    expect(sat("12.9.0", "<13")).toBe(true);
    expect(sat("13.0.0", "<13")).toBe(false);
    expect(sat("14.2.1", ">=13 <15")).toBe(true);
    expect(sat("15.0.0", ">=13 <15")).toBe(false);
    expect(sat("6.9.0", ">6")).toBe(false);
    expect(sat("7.0.0", ">6")).toBe(true);
    expect(sat("6.9.9", "<=6")).toBe(true);
    expect(sat("7.0.0", "<=6")).toBe(false);
    expect(sat("6.5.0", "6")).toBe(true);
    expect(sat("6.5.0", "6.x")).toBe(true);
    expect(sat("7.0.0", "=6")).toBe(false);
  });

  it("^ and ~", () => {
    expect(sat("1.9.0", "^1.2.3")).toBe(true);
    expect(sat("2.0.0", "^1.2.3")).toBe(false);
    expect(sat("0.2.9", "^0.2.3")).toBe(true);
    expect(sat("0.3.0", "^0.2.3")).toBe(false);
    expect(sat("0.0.4", "^0.0.3")).toBe(false);
    expect(sat("1.2.9", "~1.2")).toBe(true);
    expect(sat("1.3.0", "~1.2")).toBe(false);
    expect(sat("1.9.0", "~1")).toBe(true);
  });

  it("bad ranges throw", () => {
    for (const r of [
      "",
      ">=x",
      "1.2.3.4",
      "6.x.1",
      ">= 6",
      "a b c d e",
      "1 || 2",
      "x".repeat(65),
      "01",
    ]) {
      expect(() => parseRange(r), r).toThrow();
    }
  });

  it("lowestVersion of a dependency spec", () => {
    expect(lowestVersion("^6.0.3")).toEqual([6, 0, 3]);
    expect(lowestVersion("~5.2")).toEqual([5, 2, 0]);
    expect(lowestVersion(">=15")).toEqual([15, 0, 0]);
    expect(lowestVersion("15.0.0-canary.3")).toEqual([15, 0, 0]);
    expect(lowestVersion("v1.2.3")).toEqual([1, 2, 3]);
    for (const s of ["latest", "workspace:*", "npm:vite@6", "github:x/y", "1 || 2", "", "*"]) {
      expect(lowestVersion(s), s).toBeUndefined();
    }
  });
});

describe("detect + variants (F-005 §3.2)", () => {
  const prof = (detect: string, extra = ""): Profile =>
    parseProfile(
      MIN.replace(
        /detect:\n {2}all: \[\{ file: "package\.json" \}\]\n {2}score: 60\n/,
        `detect:\n${detect}\n`,
      ) + extra,
      "x",
    );

  it("all / any / none and score", () => {
    const p = prof(
      '  all: [{ file: "package.json" }]\n  any: [{ dep: vite }, { file: "vite.config.*" }]\n  none: [{ dep: next }]\n  score: 80',
    );
    expect(evaluateDetect(p, memView({ "package.json": "{}" }, { vite: "^7.0.0" }))).toEqual({
      matched: true,
      score: 80,
      reasons: ["file package.json", "dep vite"],
    });
    expect(evaluateDetect(p, memView({ "package.json": "{}", "vite.config.ts": "" })).matched).toBe(
      true,
    );
    expect(evaluateDetect(p, memView({ "package.json": "{}" })).matched).toBe(false);
    expect(evaluateDetect(p, memView({ "package.json": "{}" }, { vite: "7", next: "15" }))).toEqual(
      {
        matched: false,
        score: 0,
        reasons: [],
      },
    );
  });

  it("folders, fileContains with a byte limit, dep with range", () => {
    const p = prof(
      '  all: [{ file: "ProjectSettings/" }, { fileContains: ["a.txt|b.txt", "needle|other"] }, { dep: x, range: ">=2" }]\n  score: 10',
    );
    const files = { "ProjectSettings/p.asset": "", "b.txt": "has needle" };
    expect(evaluateDetect(p, memView(files, { x: "^2.1.0" })).matched).toBe(true);
    expect(evaluateDetect(p, memView(files, { x: "^1.9.0" })).matched).toBe(false);
    expect(
      evaluateDetect(
        p,
        memView({ ...files, "b.txt": `${"x".repeat(300 * 1024)}needle` }, { x: "2" }),
      ).matched,
    ).toBe(false);
    // a file named like the folder is not the folder
    expect(
      evaluateDetect(p, memView({ ProjectSettings: "", "b.txt": "needle" }, { x: "2" })).matched,
    ).toBe(false);
  });

  it("wildcards stay within one name, case-insensitive when the view says so; bounded time", () => {
    expect(wildcardMatch("*.uproject", "Game.uproject")).toBe(true);
    expect(wildcardMatch("next.config.*", "next.config.mjs")).toBe(true);
    expect(wildcardMatch("*.json", "a.jsonx")).toBe(false);
    expect(wildcardMatch("A*.TXT", "abc.txt", true)).toBe(true);
    expect(wildcardMatch("A*.TXT", "abc.txt")).toBe(false);
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) wildcardMatch("*a*a*a*b", "a".repeat(255));
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("variants apply in file order with deep merge; variants dropped from the result", () => {
    const p = parseProfile(
      `${MIN}devServer: { hostRewrite: false }\nhealth: { path: /, timeout: 30 }\nvariants:\n  - when: { dep: demo, range: ">=6" }\n    devServer: { hostRewrite: true }\n    health: { timeout: 90 }\n  - when: { dep: demo, range: ">=7" }\n    start: { cmd: "demo7 --port {PORT}" }\n`,
      "x",
    );
    const e6 = effectiveProfile(p, new Map([["demo", "^6.1.0"]]));
    expect(e6).toMatchObject({
      devServer: { hostRewrite: true },
      health: { path: "/", timeout: 90 },
    });
    expect(e6.start?.cmd).toBe("demo --port {PORT}");
    expect(e6.variants).toBeUndefined();
    expect(effectiveProfile(p, new Map([["demo", "7.0.0"]])).start?.cmd).toBe(
      "demo7 --port {PORT}",
    );
    expect(effectiveProfile(p, new Map([["demo", "latest"]])).devServer?.hostRewrite).toBe(false);
    expect(effectiveProfile(p, new Map()).devServer?.hostRewrite).toBe(false);
    expect(p.devServer?.hostRewrite).toBe(false); // the input is not changed
  });
});

describe("loader (F-005 §3.3)", () => {
  let h: Awaited<ReturnType<typeof tempHome>>;
  beforeEach(async () => {
    h = await tempHome();
    mkdirSync(h.paths.profiles, { recursive: true });
  });
  afterEach(() => h.cleanup());
  const user = (name: string, text: string) => writeFileSync(join(h.paths.profiles, name), text);

  it("built-in profiles all load, ids unique and equal to file names", async () => {
    const r = await loadProfiles(h.paths);
    expect(r.problems).toEqual([]);
    expect(r.profiles.map((p) => p.profile.id)).toEqual([
      "bun-elysia",
      "express",
      "fastapi",
      "next",
      "static",
      "static-spa",
      "vite",
    ]);
    expect(
      r.profiles.every((p) => p.source === "builtin" && p.file === `profiles/${p.profile.id}.yml`),
    ).toBe(true);
  });

  it("user profile adds or replaces a built-in one whole (Q3)", async () => {
    user("demo.yml", MIN);
    user("vite.yml", MIN.replace("id: demo", "id: vite").replace("score: 60", "score: 99"));
    const r = await loadProfiles(h.paths);
    expect(r.problems).toEqual([]);
    const vite = r.profiles.find((p) => p.profile.id === "vite");
    expect(vite).toMatchObject({
      source: "user",
      file: "data/profiles/vite.yml",
      overrides: "profiles/vite.yml",
    });
    expect(vite?.profile.detect.score).toBe(99);
    expect(vite?.profile.variants).toBeUndefined(); // no merge with the built-in one
    expect(r.profiles.find((p) => p.profile.id === "demo")?.source).toBe("user");
  });

  it("a broken file is reported; the others still load; no full paths", async () => {
    user("demo.yml", MIN);
    user("broken.yml", "id: [");
    user("wrongid.yml", MIN);
    user("other.yaml", MIN);
    user("notes.txt", "ignored");
    const r = await loadProfiles(h.paths);
    expect(r.profiles.some((p) => p.profile.id === "demo")).toBe(true);
    expect(r.problems.map((p) => p.file).sort()).toEqual([
      "data/profiles/broken.yml",
      "data/profiles/other.yaml",
      "data/profiles/wrongid.yml",
    ]);
    expect(r.problems.find((p) => p.file.endsWith("wrongid.yml"))?.details.join()).toMatch(
      /must equal the file name/,
    );
    expect(JSON.stringify(r)).not.toContain(h.paths.home.replaceAll("\\", "\\\\"));
  });

  it("file too large, a link, a hard link → problem", async () => {
    user("big.yml", `${MIN}# ${"x".repeat(MAX_PROFILE_BYTES)}\n`);
    const outside = join(h.root, "outside.yml");
    writeFileSync(outside, MIN.replace("id: demo", "id: hard"));
    linkSync(outside, join(h.paths.profiles, "hard.yml"));
    let linked = true;
    try {
      symlinkSync(outside, join(h.paths.profiles, "soft.yml"), "file");
    } catch {
      linked = false; // no symlink privilege on this Windows account
    }
    const r = await loadProfiles(h.paths);
    const msg = (f: string) => r.problems.find((p) => p.file === `data/profiles/${f}`)?.message;
    expect(msg("big.yml")).toMatch(/exceeds/);
    expect(msg("hard.yml")).toMatch(/hard link/);
    if (linked) expect(msg("soft.yml")).toMatch(/link/);
    expect(r.profiles.some((p) => ["big", "hard", "soft"].includes(p.profile.id))).toBe(false);
  });

  it(`more than ${MAX_USER_PROFILES} files → first ${MAX_USER_PROFILES} by name + a problem`, async () => {
    for (let i = 0; i < MAX_USER_PROFILES + 3; i++) {
      const id = `p${String(i).padStart(3, "0")}`;
      user(`${id}.yml`, MIN.replace("id: demo", `id: ${id}`));
    }
    const r = await loadProfiles(h.paths);
    expect(r.profiles.filter((p) => p.source === "user")).toHaveLength(MAX_USER_PROFILES);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.message).toMatch(/more than 200/);
  });

  it("data/profiles missing → built-in only; data/profiles a link → problem", async () => {
    const { rmSync } = await import("node:fs");
    rmSync(h.paths.profiles, { recursive: true });
    expect((await loadProfiles(h.paths)).problems).toEqual([]);
    const target = join(h.root, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "demo.yml"), MIN);
    symlinkSync(target, h.paths.profiles, "junction");
    const r = await loadProfiles(h.paths);
    expect(r.problems[0]?.file).toBe("data/profiles");
    expect(r.profiles.some((p) => p.profile.id === "demo")).toBe(false);
  });

  it("a broken built-in file is a problem too (custom builtin dir)", async () => {
    const dir = join(h.root, "builtin");
    mkdirSync(dir);
    writeFileSync(join(dir, "demo.yml"), MIN.replace("score: 60", "score: x"));
    const r = await loadProfiles(h.paths, { builtinDir: dir });
    expect(r.profiles).toEqual([]);
    expect(r.problems[0]).toMatchObject({ file: "profiles/demo.yml" });
  });

  it("built-in files installed as hard links (pnpm / bun store) still load (review-1 K1)", async () => {
    const store = join(h.root, "store");
    const dir = join(h.root, "builtin");
    mkdirSync(store);
    mkdirSync(dir);
    writeFileSync(join(store, "demo.yml"), MIN);
    linkSync(join(store, "demo.yml"), join(dir, "demo.yml"));
    const r = await loadProfiles(h.paths, { builtinDir: dir });
    expect(r.problems).toEqual([]);
    expect(r.profiles.map((p) => p.profile.id)).toEqual(["demo"]);
  });
});

describe("review-1 / security-1 fixes", () => {
  it("commands: printable ASCII only, quotes around whole arguments only (K7, S3)", () => {
    for (const c of [
      "npm run dev ‮ --port 1",
      "npm \u0085 x",
      "npm \u009b x",
      "npm x",
      "npm ＂ ＆ calc",
      "npm ​ x",
      "npm\tx",
    ]) {
      expect(() => splitCommand(c), JSON.stringify(c)).toThrow(/printable ASCII/);
    }
    for (const c of [`node '"' x`, `node a"b c"`, `node "a"b`, `node "a'b"`]) {
      expect(() => splitCommand(c), c).toThrow(/whole argument/);
    }
    expect(splitCommand(`node "a b" 'c d' e`)).toEqual(["node", "a b", "c d", "e"]);
  });

  it("non-loopback bind addresses refused in commands and values (S4)", () => {
    for (const t of [
      "0.0.0.0",
      "--host=0.0.0.0",
      "192.168.1.5",
      "[::]",
      "::",
      "--host=::",
      "10.0.0.1:80",
    ]) {
      expect(namesNonLoopback(t), t).toBe(true);
    }
    for (const t of ["127.0.0.1", "::1", "[::1]", "localhost", "1.2.3", "{HOST}"]) {
      expect(namesNonLoopback(t), t).toBe(false);
    }
    expect(details(MIN.replace("demo --port {PORT}", "vite --host 0.0.0.0 --port {PORT}"))).toMatch(
      /binds outside loopback/,
    );
    expect(
      details(
        MIN.replace(
          '"demo --port {PORT}"',
          '"demo --host {h} --port {PORT}", vars: { h: "0.0.0.0" }',
        ),
      ),
    ).toMatch(/start\.vars\.h/);
    expect(() => renderCommand("x --host {HOST}", { HOST: "0.0.0.0" })).toThrow(/unsafe value/);
  });

  it("port.env is PORT or <NAME>_PORT only (S5)", () => {
    const env = (name: string) =>
      MIN.replace("demo --port {PORT}", "demo").replace("via: arg }", `via: env, env: ${name} }`);
    for (const bad of ["PATHEXT", "PATH", "NODE_OPTIONS", "ComSpec", "LD_PRELOAD", "port"]) {
      expect(details(env(bad)), bad).toMatch(/port\.env/);
    }
    for (const ok of ["PORT", "SERVER_PORT", "BACKEND_PORT"]) {
      expect(parseProfile(env(ok), "x").port?.env).toBe(ok);
    }
  });

  it("variants: checked together in order; null removes a key (K9)", () => {
    const base = `${MIN.replace("demo --port {PORT}", "demo --port {PORT}").replace("via: arg }", "via: env, env: PORT }")}`;
    // alone each is fine; together the second keeps via arg but the first removed {PORT}
    const together = `${MIN}variants:\n  - when: { dep: demo, range: ">=2" }\n    start: { cmd: "demo2" }\n    port: { via: fixed }\n  - when: { dep: demo, range: ">=3" }\n    port: { via: arg }\n`;
    expect(details(together)).toMatch(
      /variants\.1: with variants 0–1 together: port\.via arg needs \{PORT\}/,
    );
    const switchVia = `${base}variants:\n  - when: { dep: demo, range: ">=2" }\n    port: { via: fixed, env: null }\n`;
    const p = parseProfile(switchVia, "x");
    const e = effectiveProfile(p, new Map([["demo", "2.0.0"]]));
    expect(e.port).toEqual({ default: 3000, via: "fixed" });
    expect(
      details(
        `${base}variants:\n  - when: { dep: demo, range: ">=2" }\n    port: { via: fixed }\n`,
      ),
    ).toMatch(/port\.env is used with via env only/);
  });

  it("wildcard matches are sorted before the limit; reads are budgeted (K8, S6)", () => {
    const files: Record<string, string> = { "main.py": "fastapi" };
    for (let i = 0; i < 40; i++) files[`a${String(i).padStart(2, "0")}.py`] = "";
    const p = (pattern: string) =>
      parseProfile(
        MIN.replace('{ file: "package.json" }', `{ fileContains: ["${pattern}", "fastapi"] }`),
        "x",
      );
    // main.py sorts after a00–a39: outside the first MAX_WILDCARD_MATCHES, every time
    expect(MAX_WILDCARD_MATCHES).toBe(32);
    const view = memView(files);
    const shuffled = { ...view, list: (d: string) => [...view.list(d)].reverse() };
    expect(evaluateDetect(p("*.py"), view).matched).toBe(false);
    expect(evaluateDetect(p("*.py"), shuffled).matched).toBe(false);
    expect(evaluateDetect(p("m*.py"), shuffled).matched).toBe(true);
    // budget: 16 rules × 8 alternatives × wildcard → at most MAX_READS_PER_PROFILE reads
    let reads = 0;
    const counting = {
      ...view,
      read: (rel: string, max: number) => {
        reads++;
        return view.read(rel, max);
      },
    };
    const rule = '{ fileContains: ["*.py|a*.py|b*.py|c*.py|d*.py|e*.py|f*.py|g*.py", "nothere"] }';
    const many = parseProfile(
      MIN.replace('all: [{ file: "package.json" }]', `any: [${Array(16).fill(rule).join(", ")}]`),
      "x",
    );
    expect(evaluateDetect(many, counting).matched).toBe(false);
    expect(reads).toBe(MAX_READS_PER_PROFILE);
  });

  it("a junction data/profiles: the problem has no absolute path (K3, S2)", async () => {
    const h = await tempHome();
    try {
      const target = join(h.root, "elsewhere");
      mkdirSync(join(h.paths.home, "data"), { recursive: true });
      mkdirSync(target);
      symlinkSync(target, h.paths.profiles, "junction");
      const r = await loadProfiles(h.paths);
      expect(r.problems).toEqual([
        {
          file: "data/profiles",
          message: "data/profiles must be a real folder / file inside WEBHUB_HOME, not a link",
          details: [],
        },
      ]);
      expect(JSON.stringify(r)).not.toContain(h.root.replaceAll("\\", "\\\\"));
    } finally {
      await h.cleanup();
    }
  });
});
