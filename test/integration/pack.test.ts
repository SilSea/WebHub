import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
const ALLOWED = [
  /^dist\//,
  /^templates\//,
  /^profiles\//,
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
];

describe("npm pack contents (security: nothing unintended is published)", () => {
  it("only allowlisted files are packed", () => {
    const raw = execFileSync(
      process.execPath,
      [npmCli(), "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const [info] = JSON.parse(raw) as [{ files: { path: string }[] }];
    const paths = info.files.map((f) => f.path.replaceAll("\\", "/"));
    expect(paths).toContain("package.json");
    const unexpected = paths.filter((p) => !ALLOWED.some((re) => re.test(p)));
    expect(unexpected).toEqual([]);
  });
});
