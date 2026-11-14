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
  it.each(["--version", "-v"])("%s prints the package.json version", async (flag) => {
    const io = capture();
    expect(await run([flag], io)).toBe(0);
    expect(io.stdout).toEqual([pkgVersion]);
    expect(io.stderr).toEqual([]);
  });

  it.each([[[]], [["--help"]], [["-h"]]])("help for %j", async (argv) => {
    const io = capture();
    expect(await run(argv, io)).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage:");
    expect(io.stdout.join("\n")).toContain("daemon");
  });

  it("unknown command exits 1 on stderr", async () => {
    const io = capture();
    expect(await run(["frobnicate"], io)).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain("unknown command or option: frobnicate");
  });

  it("unknown global option exits 1", async () => {
    const io = capture();
    expect(await run(["--frob", "daemon"], io)).toBe(1);
    expect(io.stderr[0]).toContain("unknown command or option");
  });
});

describe("cli daemon — usage (F-004)", () => {
  it.each([
    [["daemon", "--help"], 0],
    [["daemon", "-h"], 0],
    [["daemon", "status", "--help"], 0],
    [["daemon"], 2],
  ])("%j → exit %i with the daemon usage", async (argv, code) => {
    const io = capture();
    expect(await run(argv, io)).toBe(code);
    expect(io.stdout.join("\n")).toContain("webhub daemon start");
  });

  it.each([
    [["daemon", "bogus"]],
    [["daemon", "status", "--bogus"]],
    [["daemon", "status", "extra"]],
    [["daemon", "start", "--force"]],
    [["daemon", "logs", "-n", "0"]],
    [["daemon", "logs", "-n", "abc"]],
    [["daemon", "logs", "-n", "10001"]],
    [["daemon", "logs", "-n", "-5"]],
    [["daemon", "logs", "-n", "1e3"]],
  ])("%j → exit 2", async (argv) => {
    const io = capture();
    expect(
      await run(argv, io, { env: { ...process.env, WEBHUB_HOME: "C:\\nonexistent-webhub" } }),
    ).toBe(2);
    expect(io.stderr.join("\n")).toMatch(/^webhub: /);
  });

  it("an unknown sub-command is printed sanitised (no terminal escapes)", async () => {
    const io = capture();
    expect(await run(["daemon", "x\u001b[31mred"], io)).toBe(2);
    expect(io.stderr.join("")).not.toContain("\u001b");
  });

  it("--json: errors are one JSON line on stderr", async () => {
    const io = capture();
    expect(await run(["--json", "daemon", "bogus"], io)).toBe(2);
    expect(io.stderr).toHaveLength(1);
    const e = JSON.parse(io.stderr[0] ?? "") as { error: { code: string; message: string } };
    expect(e.error.code).toBe("USAGE");
  });

  it("a relative WEBHUB_HOME → exit 2 with the hint", async () => {
    const io = capture();
    expect(
      await run(["daemon", "status"], io, { env: { ...process.env, WEBHUB_HOME: "rel" } }),
    ).toBe(2);
    expect(io.stderr.join("\n")).toContain("absolute path");
    expect(io.stderr.join("\n")).toContain("hint:");
  });
});
