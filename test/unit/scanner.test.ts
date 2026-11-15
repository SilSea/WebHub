/**
 * F-006 scanner units: deps, hints, compose, names, limits, links (spec §8 rows 3–6, 9, 10).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComposeError, composeRunner, parseCompose } from "../../src/scanner/compose.js";
import {
  jsonObject,
  packageJsonDeps,
  pyprojectDeps,
  requirementsDeps,
  requiresPython,
} from "../../src/scanner/deps.js";
import { Budget, badName, DEFAULT_LIMITS, listDir, readSmall } from "../../src/scanner/fsread.js";
import { envPorts, exposePort, scriptPort, vitePort } from "../../src/scanner/hints.js";
import { scan, slug } from "../../src/scanner/scan.js";
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
  });

  it("vite regex stays linear on hostile input", () => {
    const t0 = performance.now();
    vitePort(`server: {${"port:".repeat(50_000)}`);
    vitePort("server:{".repeat(30_000));
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe("compose", () => {
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
