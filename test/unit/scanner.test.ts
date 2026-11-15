/**
 * F-006 scanner units: deps, hints, compose, names, limits, links (spec §8 rows 3–6, 9, 10).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ComposeError,
  composeRunner,
  mergeServices,
  parseCompose,
} from "../../src/scanner/compose.js";
import {
  jsonObject,
  packageJsonDeps,
  pyprojectDeps,
  requirementsDeps,
  requiresPython,
} from "../../src/scanner/deps.js";
import { Budget, badName, DEFAULT_LIMITS, listDir, readSmall } from "../../src/scanner/fsread.js";
import { envPorts, exposePort, fromImage, scriptPort, vitePort } from "../../src/scanner/hints.js";
import { type Draft, fitToStore, nested, scan, slug } from "../../src/scanner/scan.js";
import { ScanResult } from "../../src/scanner/schema.js";
import { tempHome } from "../helpers/home.js";

const budget = (over: Partial<typeof DEFAULT_LIMITS> = {}, now?: () => number) =>
  new Budget({ ...DEFAULT_LIMITS, ...over }, undefined, now);

describe("deps", () => {
  it("package.json: three tables, string specs only, odd shapes ignored", () => {
    const out = new Map<string, string>();
    packageJsonDeps(
      jsonObject(
        JSON.stringify({
          dependencies: { next: "^15.0.0", bad: 1, "@scope/x": "1.0.0" },
          devDependencies: { vite: "^7.0.0" },
          peerDependencies: ["not", "an", "object"],
        }),
      ),
      out,
      100,
    );
    expect([...out]).toEqual([
      ["next", "^15.0.0"],
      ["@scope/x", "1.0.0"],
      ["vite", "^7.0.0"],
    ]);
    expect(jsonObject("[1]")).toBeUndefined();
    expect(jsonObject("{")).toBeUndefined();
    expect(jsonObject(undefined)).toBeUndefined();
  });

  it("requirements.txt: comments, -r / -e / URLs skipped, extras + markers", () => {
    const out = new Map<string, string>();
    requirementsDeps(
      "# c\nFastAPI==0.110.0\nuvicorn[standard]>=0.29 ; python_version<'3.13'\n-r other.txt\n-e .\nhttps://x/y.whl\npydantic\n",
      out,
      100,
    );
    expect([...out]).toEqual([
      ["fastapi", "==0.110.0"],
      ["uvicorn", ">=0.29"],
      ["pydantic", ""],
    ]);
  });

  it("pyproject: PEP 621 (multi-line) + poetry; requires-python", () => {
    const text = `[project]
name = "x"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.110",
  'django',
]
[tool.poetry.dependencies]
python = "^3.11"
flask = "^3.0"
gunicorn = { version = "^22", optional = true }
[[tool.other]]
fake = "1"
`;
    const out = new Map<string, string>();
    pyprojectDeps(text, out, 100);
    expect([...out]).toEqual([
      ["fastapi", ">=0.110"],
      ["django", ""],
      ["flask", "^3.0"],
      ["gunicorn", "^22"],
    ]);
    expect(requiresPython(text)).toBe(">=3.11");
  });

  it("caps the number of deps and refuses odd names / specs", () => {
    const out = new Map<string, string>();
    requirementsDeps(Array.from({ length: 50 }, (_, i) => `p${i}`).join("\n"), out, 10);
    expect(out.size).toBe(10);
    const odd = new Map<string, string>();
    packageJsonDeps({ dependencies: { "a b": "1", ok: "1\u001b[31m" } }, odd, 10);
    expect([...odd]).toEqual([["ok", ""]]);
  });
});

describe("hints", () => {
  it(".env: only port keys with a number leave the parser", () => {
    expect(
      envPorts(
        "SECRET=hunter2\nPORT=4321\nexport BACKEND_PORT='5000'\nDB_URL=postgres://u:p@h:5432/d\nAPI_PORT=abc\nport=1\n",
      ),
    ).toEqual([
      { key: "PORT", value: 4321 },
      { key: "BACKEND_PORT", value: 5000 },
    ]);
  });

  it("script / vite / Dockerfile ports", () => {
    expect(scriptPort("next dev --port 3001")).toBe(3001);
    expect(scriptPort("next dev -p 3002 --turbo")).toBe(3002);
    expect(scriptPort("vite --port=5174")).toBe(5174);
    expect(scriptPort("vite --portal 1")).toBeUndefined();
    expect(scriptPort("x --port 99999")).toBeUndefined();
    expect(vitePort("export default { server: { host: true, port: 5180 } }")).toBe(5180);
    expect(vitePort("export default { server: { port: env.PORT } }")).toBeUndefined();
    expect(vitePort("export default { preview: { port: 1 } }")).toBeUndefined();
    expect(exposePort("FROM node\nEXPOSE 8080/tcp\n")).toBe(8080);
    expect(exposePort("FROM node\r\n  EXPOSE 3000\r\n")).toBe(3000);
    expect(fromImage("# c\nFROM --platform=linux/amd64 node:22-alpine AS b\n")).toBe(
      "node:22-alpine",
    );
  });

  it("Dockerfile regexes stay linear on a file of newlines (security-1 S1)", () => {
    for (const text of ["\n".repeat(262_144), " \n".repeat(131_072), "\t".repeat(262_144)]) {
      const t0 = performance.now();
      exposePort(text);
      fromImage(text);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });

  it("vite regex stays linear on hostile input", () => {
    const t0 = performance.now();
    vitePort(`server: {${"port:".repeat(50_000)}`);
    vitePort("server:{".repeat(30_000));
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe("compose", () => {
  it("port text is rebuilt from numbers: no env defaults / control characters (security-1 S5)", () => {
    const s = parseCompose(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: compose syntax, not JS
      'services:\n  api:\n    build: .\n    ports: ["\u001b[2J\u202e${DB_PASSWORD:-hunter2}:3000"]\n',
    );
    expect(s.services[0]?.ports).toEqual([{ target: 3000, text: "3000" }]);
  });

  it("anchors / merge keys, ports in every form, infra vs app, source mounts", () => {
    const s = parseCompose(`x: &c
  restart: always
services:
  web:
    <<: *c
    image: node:20
    volumes: [".:/app"]
    ports: ["\${WEB:-5173}:5173", 3000, "127.0.0.1:8080:80/tcp", { target: 9000, published: 9001 }]
  db:
    image: postgres:15
    environment: { POSTGRES_PASSWORD: s3cret }
  api:
    build: { context: . }
`);
    expect(s.services.map((x) => [x.name, x.infra, x.build, x.mountsSource])).toEqual([
      ["web", false, false, true],
      ["db", true, false, false],
      ["api", false, true, false],
    ]);
    expect(s.services[0]?.ports.map((p) => [p.published, p.target])).toEqual([
      [5173, 5173],
      [undefined, 3000],
      [8080, 80],
      [9001, 9000],
    ]);
    expect(JSON.stringify(s)).not.toContain("s3cret");
    expect(composeRunner(s.services)).toBe("hybrid");
    expect(composeRunner(parseCompose("services: { api: { build: . } }").services)).toBe("compose");
    expect(composeRunner(parseCompose("services: { db: { image: redis:7 } }").services)).toBe(
      "hybrid",
    );
    expect(composeRunner([])).toBeUndefined();
  });

  it("alias bomb, too many aliases, forbidden keys, broken YAML → ComposeError", () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x]",
      ...Array.from({ length: 9 }, (_, i) => {
        const p = String.fromCharCode(97 + i);
        const n = String.fromCharCode(98 + i);
        return `${n}: &${n} [*${p}, *${p}, *${p}, *${p}, *${p}, *${p}, *${p}, *${p}, *${p}]`;
      }),
    ].join("\n");
    expect(() => parseCompose(bomb)).toThrow(ComposeError);
    expect(() => parseCompose("services:\n  __proto__: { image: x }\n")).toThrow(ComposeError);
    expect(() => parseCompose("services: [")).toThrow(ComposeError);
    try {
      parseCompose("services:\n  a: { image: x }\n  secretvalue: [");
    } catch (err) {
      expect((err as Error).message).not.toContain("secretvalue");
    }
  });
});

describe("names", () => {
  it("slug", () => {
    expect(slug("Pos_on_website")).toBe("pos-on-website");
    expect(slug("Ünïcode Name!!")).toBe("unicode-name");
    expect(slug("---")).toBe("site");
    expect(slug("a".repeat(60))).toHaveLength(40);
  });

  it("bad names: control / C1 / bidi / lone surrogate / reserved", () => {
    for (const n of ["a\u001bb", "a\u009bb", "a‮b", "a\ud800", "", "x".repeat(256)]) {
      expect(badName(n), JSON.stringify(n)).toBe(true);
    }
    if (process.platform === "win32") {
      for (const n of ["CON", "nul.txt", "COM1", "a.", "a "]) expect(badName(n), n).toBe(true);
    }
    for (const n of ["vite-basic", "Projekt ü", "日本語"]) expect(badName(n), n).toBe(false);
  });
});

describe("read-only access, links, limits", { timeout: 30_000 }, () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(mkdtempSync(join(tmpdir(), "webhub-scan-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("readSmall: cap, BOM, links refused, budget counted", async () => {
    writeFileSync(join(dir, "a.txt"), "﻿hello world");
    const b = budget();
    // the cap counts bytes on disk, BOM included (3 bytes)
    expect(await readSmall(join(dir, "a.txt"), 5, b)).toBe("he");
    expect(b.bytes).toBe(5);
    expect(await readSmall(join(dir, "missing"), 5, b)).toBeUndefined();
    expect(await readSmall(dir, 5, b)).toBeUndefined();
    const out = mkdtempSync(join(tmpdir(), "webhub-out-"));
    try {
      writeFileSync(join(out, "secret.txt"), "outside");
      try {
        symlinkSync(join(out, "secret.txt"), join(dir, "link.txt"));
        expect(await readSmall(join(dir, "link.txt"), 100, b)).toBeUndefined();
      } catch {
        // symlinks not permitted: junction case below covers folders
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("listDir: junction → link; outside root → changed; entry cap", async () => {
    const out = mkdtempSync(join(tmpdir(), "webhub-out-"));
    try {
      mkdirSync(join(dir, "real"));
      symlinkSync(out, join(dir, "j"), "junction");
      const b = budget({ entriesPerFolder: 2 });
      const r = await listDir(dir, dir, b);
      expect("entries" in r && r.entries.find((e) => e.name === "j")?.type).toBe("link");
      expect(await listDir(join(dir, "j"), dir, b)).toEqual({ skip: "link" });
      expect(await listDir(out, dir, b)).toEqual({ skip: "changed" });
      for (const n of ["x", "y", "z"]) writeFileSync(join(dir, "real", n), "");
      expect(await listDir(join(dir, "real"), dir, b)).toEqual({ skip: "too-many-entries" });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("budget: folders / bytes / time → Truncated", () => {
    const f = budget({ folders: 1 });
    f.folder();
    expect(() => f.folder()).toThrow(/folders/);
    const by = budget({ bytes: 10 });
    by.bytes = 10;
    expect(() => by.allowance(5)).toThrow(/bytes/);
    let t = 0;
    const ti = budget({ timeMs: 100 }, () => t);
    t = 101;
    expect(() => ti.check()).toThrow(/time/);
  });

  it("scan: links outside the root are skipped, never read; depth limit; truncation", async () => {
    const h = await tempHome();
    const out = mkdtempSync(join(tmpdir(), "webhub-out-"));
    try {
      writeFileSync(join(out, "package.json"), '{"dependencies":{"vite":"^7.0.0"}}');
      writeFileSync(join(out, "vite.config.js"), "export default { server: { port: 4444 } }");
      symlinkSync(out, join(dir, "evil"), "junction");
      mkdirSync(join(dir, "a", "b", "c", "d", "e"), { recursive: true });
      writeFileSync(join(dir, "a", "b", "c", "d", "e", "index.html"), "<p>deep</p>");
      writeFileSync(join(dir, "a", "b", "index.html"), "<p>shallow</p>");
      mkdirSync(join(dir, "x", "y", "z", "w"), { recursive: true });
      writeFileSync(join(dir, "x", "y", "z", "w", "index.html"), "<p>depth 4</p>");
      const r = await scan(h.paths, { scanRoots: [dir] });
      expect(ScanResult.safeParse(r).success).toBe(true);
      expect(r.skipped).toContainEqual({ path: join(dir, "evil"), reason: "link" });
      expect(JSON.stringify(r)).not.toContain("4444");
      expect(r.candidates.map((c) => c.path)).toEqual([join(dir, "a", "b")]);

      // config maxDepth / ignore (F-001 keys)
      const deep = await scan(h.paths, { scanRoots: [dir], maxDepth: 5 });
      expect(deep.candidates.map((c) => c.path)).toEqual([
        join(dir, "a", "b"),
        join(dir, "x", "y", "z", "w"),
      ]);
      const ign = await scan(h.paths, { scanRoots: [dir], maxDepth: 5, ignore: ["Z"] });
      expect(ign.candidates.map((c) => c.path)).toEqual([join(dir, "a", "b")]);

      const tr = await scan(h.paths, { scanRoots: [dir], limits: { folders: 2 } });
      expect(tr.truncated).toEqual({ reason: "folders" });
      expect(ScanResult.safeParse(tr).success).toBe(true);
      // what was found before the limit is still detected (review-1 C1)
      const part = await scan(h.paths, { scanRoots: [dir], limits: { folders: 4 } });
      expect(part.truncated).toEqual({ reason: "folders" });
      expect(part.candidates.map((c) => [c.path, c.kind])).toEqual([[join(dir, "a", "b"), "site"]]);
      // out of time while walking: found folders are still detected with the reserve
      let t = 0;
      const timed = await scan(h.paths, {
        scanRoots: [dir],
        limits: { timeMs: 600 },
        now: () => (t += 100),
      });
      expect(timed.truncated).toMatchObject({ reason: "time" });
      expect(ScanResult.safeParse(timed).success).toBe(true);

      const ac = new AbortController();
      ac.abort();
      await expect(scan(h.paths, { scanRoots: [dir], signal: ac.signal })).rejects.toThrow();
    } finally {
      rmSync(out, { recursive: true, force: true });
      await h.cleanup();
    }
  });

  it("scan roots: missing / file / link / inside home are reported, not walked", async () => {
    const h = await tempHome();
    try {
      writeFileSync(join(dir, "file"), "");
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "lnk"), "junction");
      mkdirSync(h.paths.home, { recursive: true });
      const r = await scan(h.paths, {
        scanRoots: [join(dir, "nope"), join(dir, "file"), join(dir, "lnk"), h.root],
      });
      expect(r.roots.map((x) => x.status)).toEqual([
        "missing",
        "not-a-folder",
        "link",
        "inside-home",
      ]);
      expect(r.candidates).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it("one wide root does not starve the others (security-1 S3)", async () => {
    const h = await tempHome();
    try {
      const wide = join(dir, "wide");
      for (let i = 0; i < 40; i++) mkdirSync(join(wide, `d${i}`), { recursive: true });
      const good = join(dir, "good");
      mkdirSync(good);
      writeFileSync(join(good, "index.html"), "<p>hi</p>");
      const r = await scan(h.paths, { scanRoots: [wide, good], limits: { folders: 20 } });
      expect(r.truncated).toEqual({ reason: "folders" });
      expect(r.candidates.map((c) => c.path)).toEqual([good]);
    } finally {
      await h.cleanup();
    }
  });

  it("missing roots next to a big root do not cut it (review-2 R1)", async () => {
    const h = await tempHome();
    try {
      const big = join(dir, "big");
      for (let i = 0; i < 70; i++) mkdirSync(join(big, `d${i}`), { recursive: true });
      mkdirSync(join(big, "zz", "site"), { recursive: true });
      writeFileSync(join(big, "zz", "site", "index.html"), "<p>hi</p>");
      const missing = Array.from({ length: 9 }, (_, i) => join(dir, `nope${i}`));
      const r = await scan(h.paths, { scanRoots: [big, ...missing], limits: { folders: 100 } });
      expect(r.truncated).toBe(false);
      expect(r.candidates.map((c) => c.path)).toEqual([join(big, "zz", "site")]);
    } finally {
      await h.cleanup();
    }
  });

  it("a hostile first root cannot use up candidates / bytes of the next (review-2 R2)", async () => {
    const h = await tempHome();
    try {
      const evil = join(dir, "evil");
      for (let i = 0; i < 60; i++) {
        mkdirSync(join(evil, `p${i}`), { recursive: true });
        writeFileSync(join(evil, `p${i}`, "package.json"), `{"x":"${"y".repeat(2000)}"}`);
      }
      const good = join(dir, "good");
      mkdirSync(good);
      writeFileSync(join(good, "package.json"), '{"devDependencies":{"vite":"^7.0.0"}}');
      writeFileSync(join(good, "index.html"), "<p>hi</p>");
      const cand = await scan(h.paths, { scanRoots: [evil, good], limits: { candidates: 20 } });
      expect(cand.truncated).toEqual({ reason: "candidates" });
      expect(cand.candidates.find((c) => c.path === good)?.kind).toBe("site");
      const bytes = await scan(h.paths, { scanRoots: [evil, good], limits: { bytes: 20_000 } });
      expect(bytes.truncated).toEqual({ reason: "bytes" });
      expect(bytes.candidates.find((c) => c.path === good)?.kind).toBe("site");
    } finally {
      await h.cleanup();
    }
  });

  it("runtime hints refuse shell characters; packageManager is name@x.y.z (security-1 S6)", async () => {
    const h = await tempHome();
    try {
      const p = join(dir, "p");
      mkdirSync(p);
      writeFileSync(
        join(p, "package.json"),
        JSON.stringify({
          dependencies: { express: "4" },
          engines: { node: "22; curl x|sh" },
          packageManager: "pnpm@9.0.0; curl x|sh",
        }),
      );
      writeFileSync(join(p, ".nvmrc"), "$(rm -rf ~)\n");
      const q = join(dir, "q");
      mkdirSync(q);
      writeFileSync(
        join(q, "package.json"),
        JSON.stringify({
          dependencies: { express: "4" },
          engines: { node: ">=20 <23" },
          packageManager: "pnpm@9.15.0+sha512.abc",
        }),
      );
      const r = await scan(h.paths, { scanRoots: [dir] });
      const by = Object.fromEntries(r.candidates.map((c) => [c.name, c.services.app?.runtime]));
      expect(by.p).toBeUndefined();
      expect(by.q).toEqual([
        { lang: "node", hint: ">=20 <23", source: "package.json engines.node" },
        { lang: "pnpm", hint: "pnpm@9.15.0", source: "package.json packageManager" },
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("a non-web folder above does not hide projects (C6); merges stay inside roots (S4)", async () => {
    const h = await tempHome();
    try {
      writeFileSync(join(dir, "requirements.txt"), "requests\n");
      mkdirSync(join(dir, "site"));
      writeFileSync(join(dir, "site", "index.html"), "<p>hi</p>");
      const r = await scan(h.paths, { scanRoots: [dir] });
      expect(r.candidates.map((c) => [c.name, c.kind])).toContainEqual(["site", "site"]);

      const w = join(dir, "w");
      for (const n of ["frontend", "backend"]) {
        mkdirSync(join(w, n), { recursive: true });
        writeFileSync(
          join(w, n, "package.json"),
          JSON.stringify({ dependencies: n === "frontend" ? { vite: "7" } : { express: "4" } }),
        );
      }
      const two = await scan(h.paths, { scanRoots: [join(w, "frontend"), join(w, "backend")] });
      expect(two.candidates.map((c) => c.path).sort()).toEqual(
        [join(w, "backend"), join(w, "frontend")].sort(),
      );
    } finally {
      await h.cleanup();
    }
  });

  it("same / nested scan roots are walked once (review-2 R4)", async () => {
    const h = await tempHome();
    try {
      mkdirSync(join(dir, "a"));
      writeFileSync(join(dir, "a", "index.html"), "<p>hi</p>");
      const r = await scan(h.paths, { scanRoots: [dir, dir, join(dir, "a")] });
      expect(r.roots.map((x) => x.status)).toEqual(["ok", "inside-root", "inside-root"]);
      expect(r.candidates.map((c) => c.name)).toEqual(["a"]);
      // an inner root listed first is still covered by the outer one
      const rev = await scan(h.paths, { scanRoots: [join(dir, "a"), dir] });
      expect(rev.roots.map((x) => x.status)).toEqual(["inside-root", "ok"]);
      expect(rev.candidates).toHaveLength(1);
      // a root the outer walk does not reach (depth / ignore / dot folder) is still walked
      // (review-4 V1)
      for (const inner of [join(dir, "z", "b", "c", "d", "deep"), join(dir, "vendor", "x")]) {
        mkdirSync(inner, { recursive: true });
        writeFileSync(join(inner, "index.html"), "<p>hi</p>");
      }
      const deep = await scan(h.paths, {
        scanRoots: [dir, join(dir, "z", "b", "c", "d", "deep"), join(dir, "vendor", "x")],
      });
      expect(deep.roots.map((x) => x.status)).toEqual(["ok", "inside-root", "inside-root"]);
      expect(deep.candidates.map((c) => c.path).sort()).toEqual(
        [join(dir, "a"), join(dir, "z", "b", "c", "d", "deep"), join(dir, "vendor", "x")].sort(),
      );
    } finally {
      await h.cleanup();
    }
  });

  it("compose base + override: services merged by name (review-4 V2)", () => {
    const merged = mergeServices([
      parseCompose("services:\n  web:\n    build: .\n  db:\n    image: postgres:16\n").services,
      parseCompose("services:\n  web:\n    ports: ['3000:3000']\n  db:\n    ports: ['5432:5432']\n")
        .services,
    ]);
    expect(merged.map((x) => [x.name, x.build, x.infra])).toEqual([
      ["web", true, false],
      ["db", false, true],
    ]);
    expect(merged[0]?.ports.map((p) => p.target)).toEqual([3000]);
    const onlyDb = mergeServices([
      parseCompose("services:\n  db:\n    image: postgres:16\n").services,
      parseCompose("services:\n  db:\n    ports: ['5432:5432']\n").services,
    ]);
    expect(composeRunner(onlyDb)).toBe("hybrid");
  });

  it("compose files as docker reads them: first base + first override (review-5 W1)", async () => {
    const h = await tempHome();
    try {
      const p = join(dir, "p");
      mkdirSync(p);
      writeFileSync(join(p, "package.json"), '{"dependencies":{"express":"4"}}');
      writeFileSync(
        join(p, "compose.yaml"),
        "services:\n  web:\n    image: node:22\n    volumes: ['.:/app']\n",
      );
      writeFileSync(
        join(p, "docker-compose.yml"),
        "services:\n  api:\n    build: .\n    ports: ['8080:8080']\n",
      );
      writeFileSync(
        join(p, "compose.override.yaml"),
        "services:\n  web:\n    ports: ['3000:3000']\n",
      );
      const r = await scan(h.paths, { scanRoots: [dir] });
      const c = r.candidates[0];
      expect(c?.compose).toEqual({
        files: ["compose.yaml", "compose.override.yaml"],
        app: ["web"],
        infra: [],
        mountsSource: true,
      });
      expect(c?.services.app?.port?.value).toBe(3000);
      expect(r.problems.map((x) => x.file)).toContain(join(p, "docker-compose.yml"));

      // an override alone is not a compose project
      const q = join(dir, "q");
      mkdirSync(q);
      writeFileSync(join(q, "package.json"), '{"dependencies":{"express":"4"}}');
      writeFileSync(join(q, "compose.override.yml"), "services:\n  api:\n    build: .\n");
      const r2 = await scan(h.paths, { scanRoots: [q] });
      expect(r2.candidates[0]?.compose).toBeUndefined();
      expect(r2.candidates[0]?.runner).toBe("native");
    } finally {
      await h.cleanup();
    }
  });

  it("more than 200 merged services keep the candidate (review-5 W2)", () => {
    const yaml = (from: number) =>
      `services:\n${Array.from({ length: 150 }, (_, i) => `  s${from + i}:\n    build: .\n`).join("")}`;
    const merged = mergeServices([
      parseCompose(yaml(0)).services,
      parseCompose(yaml(150)).services,
    ]);
    expect(merged).toHaveLength(200);
  });

  it("parent + child compose: one service once; unreadable compose not listed (review-2 R3)", async () => {
    const h = await tempHome();
    try {
      const m = join(dir, "m");
      mkdirSync(join(m, "frontend"), { recursive: true });
      mkdirSync(join(m, "backend"), { recursive: true });
      writeFileSync(join(m, "frontend", "package.json"), '{"devDependencies":{"vite":"7"}}');
      writeFileSync(join(m, "backend", "package.json"), '{"dependencies":{"express":"4"}}');
      writeFileSync(join(m, "docker-compose.yml"), "services:\n  api:\n    build: ./backend\n");
      writeFileSync(join(m, "backend", "compose.yaml"), "services:\n  api:\n    build: .\n");
      const r = await scan(h.paths, { scanRoots: [dir] });
      expect(r.candidates[0]?.compose?.app).toEqual(["api"]);

      writeFileSync(join(m, "docker-compose.yml"), "services: [: broken");
      rmSync(join(m, "backend", "compose.yaml"));
      const bad = await scan(h.paths, { scanRoots: [dir] });
      expect(bad.candidates[0]?.compose).toBeUndefined();
      expect(bad.candidates[0]?.runner).toBe("native");
      expect(bad.problems.map((p) => p.file)).toContain(join(m, "docker-compose.yml"));
    } finally {
      await h.cleanup();
    }
  });

  it("fitToStore measures what the store writes (pretty JSON) (review-3 Q1)", async () => {
    const h = await tempHome();
    try {
      const r = await scan(h.paths, { scanRoots: [] });
      const c = {
        key: "0123456789abcdef",
        name: "x",
        path: "p",
        kind: "site" as const,
        score: 50,
        alternatives: [],
        reasons: [],
        notWeb: [],
        compose: {
          files: ["c.yml"],
          app: Array.from({ length: 200 }, (_, i) => `s${i}`),
          infra: [],
          mountsSource: false,
        },
        services: {},
        fingerprint: "",
      };
      r.candidates = Array.from({ length: 100 }, () => structuredClone(c));
      const compact = Buffer.byteLength(JSON.stringify(r));
      const pretty = Buffer.byteLength(`${JSON.stringify(r, null, 2)}\n`);
      const max = Math.floor((compact + pretty) / 2); // compact fits, pretty does not
      fitToStore(r, max);
      expect(r.truncated).toEqual({ reason: "candidates" });
      expect(Buffer.byteLength(`${JSON.stringify(r, null, 2)}\n`)).toBeLessThanOrEqual(max);
      expect(r.candidates.length).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });

  it("non-web projects hide the non-web folders inside them (review-3 Q3)", async () => {
    const h = await tempHome();
    try {
      const game = join(dir, "game");
      mkdirSync(join(game, "ProjectSettings"), { recursive: true });
      mkdirSync(join(game, "Packages", "com.me.tool"), { recursive: true });
      writeFileSync(join(game, "Packages", "manifest.json"), '{"dependencies":{}}');
      writeFileSync(join(game, "Packages", "com.me.tool", "package.json"), '{"name":"t"}');
      const r = await scan(h.paths, { scanRoots: [dir] });
      expect(r.candidates.map((c) => [c.name, c.kind])).toEqual([["game", "not-web"]]);
    } finally {
      await h.cleanup();
    }
  });

  it("folders not looked at stay listed, also under a non-web project (review-4 V3)", () => {
    const d = (path: string, kind: Draft["kind"], unread?: true): Draft => ({
      key: "0123456789abcdef",
      base: "x",
      root: "/r",
      path,
      kind,
      score: 0,
      alternatives: [],
      reasons: [],
      notWeb: [],
      services: {},
      fingerprint: "",
      ...(unread ? { unread } : {}),
    });
    const sepd = (...p: string[]) => join("/r", ...p);
    const out = nested([
      d(sepd("p"), "not-web"),
      d(sepd("p", "x"), "unknown", true),
      d(sepd("p", "y"), "unknown"),
      d(sepd("s"), "site"),
      d(sepd("s", "u"), "unknown", true),
    ]).map((x) => x.path);
    expect(out.sort()).toEqual([sepd("p"), sepd("p", "x"), sepd("s"), sepd("s", "u")].sort());
  });

  it("hostile content: long names, newline Dockerfile — result stays valid and fast", async () => {
    const h = await tempHome();
    try {
      const p = join(dir, "p");
      mkdirSync(p);
      writeFileSync(join(p, `${"a".repeat(200)}.csproj`), "<Project/>");
      const q = join(dir, "q");
      mkdirSync(q);
      writeFileSync(join(q, "package.json"), '{"dependencies":{"express":"4"}}');
      writeFileSync(join(q, "Dockerfile"), "\n".repeat(262_144));
      const t0 = performance.now();
      const r = await scan(h.paths, { scanRoots: [dir] });
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect(ScanResult.safeParse(r).success).toBe(true);
      expect(r.candidates.map((c) => c.kind)).toEqual(["not-web", "site"]);
      expect(r.candidates[0]?.notWeb[0]?.length).toBeLessThanOrEqual(200);
    } finally {
      await h.cleanup();
    }
  });

  it("public/ folders with the same boilerplate are not duplicates (review-1 C3)", async () => {
    const h = await tempHome();
    try {
      for (const n of ["shop", "blog"]) {
        mkdirSync(join(dir, n, "public"), { recursive: true });
        writeFileSync(join(dir, n, "package.json"), `{"name":"${n}","dependencies":{"vite":"7"}}`);
        writeFileSync(join(dir, n, "public", "index.html"), "<div id=root></div>");
        writeFileSync(join(dir, n, "public", "manifest.json"), '{"name":"app"}');
      }
      const r = await scan(h.paths, { scanRoots: [dir] });
      expect(r.candidates.map((c) => [c.name, c.kind])).toEqual([
        ["blog", "site"],
        ["shop", "site"],
      ]);
    } finally {
      await h.cleanup();
    }
  });

  it("odd folder names are skipped and never reach the result", async () => {
    const h = await tempHome();
    try {
      const odd = process.platform === "win32" ? "con" : "a\u001b[31m";
      try {
        mkdirSync(join(dir, odd));
      } catch {
        return; // the OS refuses the name: nothing to test
      }
      writeFileSync(join(dir, "index.html"), "<p/>");
      const r = await scan(h.paths, { scanRoots: [dir] });
      expect(r.skipped).toContainEqual({ path: dir, reason: "bad-name" });
      expect(JSON.stringify(r)).not.toContain("\u001b");
    } finally {
      await h.cleanup();
    }
  });
});
