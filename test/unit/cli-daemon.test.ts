import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_LOG, daemonEnv, ensureDaemon, spawnPlan } from "../../src/cli/daemon-control.js";
import { followLogs, tailLogs } from "../../src/cli/daemon-logs.js";
import { CliError, errorLines, exitCodeOf, sanitize } from "../../src/cli/output.js";
import { WebhubError } from "../../src/errors.js";
import { ServerError } from "../../src/server/errors.js";
import { tempHome } from "../helpers/home.js";

const ch = (cp: number) => String.fromCodePoint(cp);

describe("sanitize (F-004 §6)", () => {
  it("replaces C0 / C1 / DEL, separators and bidi controls; keeps tab and text", () => {
    const evil = [
      "a",
      ch(0x1b),
      "]0;title",
      ch(0x07),
      "b",
      ch(0x9b),
      "31m",
      ch(0x0d),
      ch(0x0a),
      ch(0x7f),
      ch(0x00),
      ch(0x2028),
      ch(0x2029),
      ch(0x202e),
      ch(0x2066),
      ch(0x2069),
      "\t",
      "ไทย 😀",
    ].join("");
    const out = sanitize(evil);
    expect(out).toBe("a?]0;title?b?31m?????????\tไทย 😀");
  });
});

describe("exit codes / error lines", () => {
  it.each([
    [new ServerError("DAEMON_NOT_RUNNING", "x"), 3],
    [new ServerError("DAEMON_PORT_BUSY", "x"), 4],
    [new ServerError("DAEMON_IMPOSTOR", "x"), 1],
    [new WebhubError("CONFIG_INVALID", "x"), 2],
    [new WebhubError("HOME_INVALID", "x"), 2],
    [new WebhubError("LOCKED", "x"), 1],
    [new CliError(4, "X", "x"), 4],
    [new Error("boom"), 1],
  ])("%s → %i", (err, code) => {
    expect(exitCodeOf(err)).toBe(code);
  });

  it("unknown errors print the class name only (never the message)", () => {
    expect(errorLines(new TypeError("secret-looking text"))).toEqual([
      "webhub: internal error (TypeError)",
    ]);
  });

  it("known errors are sanitised", () => {
    const lines = errorLines(new CliError(1, "X", `bad${ch(0x1b)}[2J`, { hint: `h${ch(0x07)}` }));
    expect(lines.join("")).not.toContain(ch(0x1b));
    expect(lines.join("")).not.toContain(ch(0x07));
  });
});

let h: Awaited<ReturnType<typeof tempHome>>;
beforeEach(async () => {
  h = await tempHome();
  mkdirSync(h.paths.logs, { recursive: true });
});
afterEach(() => h.cleanup());

describe("spawn plan (F-004 §3.3, §6)", () => {
  it("drops NODE_OPTIONS in any case, keeps the rest", () => {
    const env = daemonEnv({
      NODE_OPTIONS: "--inspect",
      Node_Options: "--require x",
      PATH: "p",
      A: "1",
    });
    expect(env).toEqual({ PATH: "p", A: "1" });
  });

  it("detached, hidden, cwd = home, no pipe, no secret in args, log file in logs/", () => {
    const plan = spawnPlan(h.paths, { NODE_OPTIONS: "--inspect", X: "1" }, "/x/daemon.js", 7);
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toEqual(["/x/daemon.js", "--log-file", join(h.paths.logs, DAEMON_LOG)]);
    expect(plan.options).toMatchObject({ detached: true, windowsHide: true, cwd: h.paths.home });
    expect(plan.options?.stdio).toEqual(["ignore", "ignore", 7]);
    expect(JSON.stringify(plan.options?.stdio)).not.toContain("pipe");
    expect(plan.options?.env).toEqual({ X: "1" });
    expect(plan.options?.shell).toBeUndefined();
  });
});

describe("ensureDaemon (F-004 Q3)", () => {
  it("--no-start: not running → exit 3, nothing started", async () => {
    let started = false;
    await expect(
      ensureDaemon(h.paths, {
        noStart: true,
        onStart: () => {
          started = true;
        },
      }),
    ).rejects.toSatisfy((e) => e instanceof CliError && e.exitCode === 3);
    expect(started).toBe(false);
  });
});

describe("daemon logs (F-004 §3.6)", () => {
  const file = () => join(h.paths.logs, DAEMON_LOG);
  const line = (i: number) => JSON.stringify({ i });

  it("tail spans .1 and the current file; no log → nothing", () => {
    expect(tailLogs(h.paths, 5)).toEqual([]);
    writeFileSync(`${file()}.1`, `${[1, 2, 3].map(line).join("\n")}\n`);
    writeFileSync(file(), `${[4, 5].map(line).join("\r\n")}\r\n`);
    expect(tailLogs(h.paths, 4)).toEqual([2, 3, 4, 5].map(line));
    expect(tailLogs(h.paths, 50)).toHaveLength(5);
  });

  it("tail sanitises (paths from requests can hold escapes)", () => {
    writeFileSync(file(), `{"path":"/a${ch(0x1b)}[2J${ch(0x202e)}"}\n`);
    expect(tailLogs(h.paths, 1)[0]).toBe('{"path":"/a?[2J?"}');
  });

  it("follow: new lines, a line split across polls, rotation (rest of .1 first), truncation", {
    timeout: 30_000,
  }, async () => {
    writeFileSync(file(), `${line(0)}\n`);
    const got: string[] = [];
    const abort = new AbortController();
    const done = followLogs(h.paths, (l) => got.push(l), abort.signal, 20);
    const wait = async (n: number) => {
      const end = Date.now() + 5_000;
      while (got.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    };
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(file(), `${line(1)}\n{"i":`);
    await wait(1);
    appendFileSync(file(), `2}\n${line(3)}\n`);
    await wait(3);
    // rotation: a line lands in the old file just before the rename
    appendFileSync(file(), `${line(4)}\n`);
    renameSync(file(), `${file()}.1`);
    writeFileSync(file(), `${line(5)}\n`);
    await wait(5);
    // truncation (rename failed → truncate): the file is shorter than the read position
    writeFileSync(file(), "6\n");
    await wait(6);
    abort.abort();
    await done;
    expect(got).toEqual([...[1, 2, 3, 4, 5].map(line), "6"]);
  });

  it("follow: a multi-byte character split between two writes stays whole", async () => {
    writeFileSync(file(), "");
    const got: string[] = [];
    const abort = new AbortController();
    const done = followLogs(h.paths, (l) => got.push(l), abort.signal, 20);
    await new Promise((r) => setTimeout(r, 60));
    const bytes = Buffer.from("ไทย\n");
    appendFileSync(file(), bytes.subarray(0, 2));
    await new Promise((r) => setTimeout(r, 80));
    appendFileSync(file(), bytes.subarray(2));
    const end = Date.now() + 5_000;
    while (got.length < 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await done;
    expect(got).toEqual(["ไทย"]);
  });
});
