import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Io, run } from "../../src/cli.js";

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

const pkgVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("cli", () => {
  it.each(["--version", "-v"])("%s prints the package.json version", (flag) => {
    const io = capture();
    expect(run([flag], io)).toBe(0);
    expect(io.stdout).toEqual([pkgVersion]);
    expect(io.stderr).toEqual([]);
  });

  it.each([[[]], [["--help"]], [["-h"]]])("help for %j", (argv) => {
    const io = capture();
    expect(run(argv, io)).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage:");
  });

  it("unknown command exits 1 on stderr", () => {
    const io = capture();
    expect(run(["frobnicate"], io)).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain("unknown command or option: frobnicate");
  });
});
