import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST_CLI = join(ROOT, "dist", "cli.js");

/** npm's JS entry next to the running node binary — run via node, no shell (checklist: Input). */
function npmCli(): string {
  const bin = dirname(process.execPath);
  const candidates = [
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"), // Windows
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // Linux/macOS
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) throw new Error("npm-cli.js not found next to node");
  return found;
}

/** dist/<name>.js(.map) is allowed only when src/<name>.ts exists. */
function expectedDist(): Set<string> {
  const names = readdirSync(join(ROOT, "src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3));
  return new Set(names.flatMap((n) => [`dist/${n}.js`, `dist/${n}.js.map`]));
}

beforeAll(() => {
  if (!existsSync(DIST_CLI)) throw new Error("dist/cli.js missing — run `pnpm build` first");
});

describe("npm pack contents (security: nothing unintended is published)", () => {
  it("packs exactly the built files plus allowlisted assets", () => {
    const raw = execFileSync(
      process.execPath,
      [npmCli(), "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const [info] = JSON.parse(raw) as [{ files: { path: string }[] }];
    const paths = info.files.map((f) => f.path.replaceAll("\\", "/"));
    const dist = expectedDist();
    expect(paths).toContain("package.json");
    expect(paths).toContain("dist/cli.js");
    const unexpected = paths.filter(
      (p) =>
        !dist.has(p) &&
        !/^(templates|profiles)\//.test(p) &&
        !["package.json", "README.md", "LICENSE"].includes(p),
    );
    expect(unexpected).toEqual([]);
  });
});

describe("built CLI binary", () => {
  const runCli = (args: string[]) =>
    execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" }).trim();

  it("dist/cli.js --version prints the version", () => {
    expect(runCli([DIST_CLI, "--version"])).toBe("0.0.0");
  });

  it("works without the .js extension", () => {
    expect(runCli([join(ROOT, "dist", "cli"), "--version"])).toBe("0.0.0");
  });

  it("has a node shebang", () => {
    expect(readFileSync(DIST_CLI, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});
