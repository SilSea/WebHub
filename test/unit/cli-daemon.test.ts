import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAEMON_LOG,
  daemonEnv,
  ensureDaemon,
  parseStartError,
  spawnPlan,
} from "../../src/cli/daemon-control.js";
import { followLogs, readLastLines, tailLogs } from "../../src/cli/daemon-logs.js";
import { CliError, errorJson, errorLines, exitCodeOf, sanitize } from "../../src/cli/output.js";
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

  it("replaces bidi marks and zero-width characters; keeps ZWJ emoji (security-1 D5)", () => {
    const zwj = ch(0x200d);
    const family = `👨${zwj}👩${zwj}👧`;
    const marks = [0x061c, 0x200b, 0x200e, 0x200f, 0xfeff].map(ch).join("");
    expect(sanitize(`a${marks}b ${family}`)).toBe(`a?????b ${family}`);
  });
});

describe("start errors of the daemon (review C3)", () => {
  it("parses describe() output into message / details / hint", () => {
    const text = [
      "webhub daemon: port 7400 (webhub API) is already in use",
      "  - PID 23288 (node.exe) listens on 127.0.0.1:7400",
      "  - second",
      "  hint: Stop the program",
      "",
    ].join("\r\n");
    expect(parseStartError(text)).toEqual({
      message: "port 7400 (webhub API) is already in use",
      details: ["PID 23288 (node.exe) listens on 127.0.0.1:7400", "second"],
      hint: "Stop the program",
    });
  });

  it("other lines become details; everything sanitised", () => {
    expect(parseStartError(`webhub daemon: a${ch(0x1b)}[2J\nTypeError\n`)).toEqual({
      message: "a?[2J",
      details: ["TypeError"],
      hint: undefined,
    });
    expect(parseStartError("")).toEqual({ message: undefined, details: [], hint: undefined });
  });
});

describe("--json errors (review C12)", () => {
  it("one line with code, message without prefix, details and hint", () => {
    const err = new CliError(2, "X_CODE", "bad", { details: ["d1"], hint: "do this" });
    expect(JSON.parse(errorJson(err))).toEqual({
      error: { code: "X_CODE", message: "bad", details: ["d1"], hint: "do this" },
    });
    expect(JSON.parse(errorJson(new Error("secret")))).toEqual({
      error: { code: "INTERNAL", message: "internal error (Error)" },
    });
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

  it("drops every start-up knob of node / libuv / OpenSSL except NODE_ENV (security-1 D1, D2)", () => {
    const env = daemonEnv({
      NODE_DEBUG: "http,net",
      node_debug_native: "x",
      NODE_PATH: "c:/x",
      NODE_EXTRA_CA_CERTS: "ca.pem",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_V8_COVERAGE: "c:/cov",
      OPENSSL_CONF: "c:/evil.cnf",
      SSL_CERT_FILE: "x",
      UV_THREADPOOL_SIZE: "1",
      ICU_DATA: "x",
      [`N${ch(0x00d3)}DE_DEBUG`]: "net", // non-ASCII name (Windows best-fit)
      NODE_ENV: "production",
      Path: "p",
      NODEJS_HOME: "kept: not a NODE_ prefix",
    });
    expect(env).toEqual({
      NODE_ENV: "production",
      Path: "p",
      NODEJS_HOME: "kept: not a NODE_ prefix",
    });
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

  it("tail reads only the end of a large file; a line cut by the byte limit is dropped", () => {
    // 3000 lines of 100 bytes; chunked reads cross line boundaries
    const body = Array.from({ length: 3000 }, (_, i) => `${String(i).padStart(99, "x")}\n`).join(
      "",
    );
    writeFileSync(file(), body);
    const last = readLastLines(file(), 3);
    expect(last).toEqual([2997, 2998, 2999].map((i) => String(i).padStart(99, "x")));
    expect(readLastLines(file(), 2000)).toHaveLength(2000);
    // byte cap 250: only 2 whole lines fit (the third is cut → dropped)
    expect(readLastLines(file(), 10, 250)).toEqual(
      [2998, 2999].map((i) => String(i).padStart(99, "x")),
    );
    // the file has fewer lines than asked: all of them, first line kept
    writeFileSync(file(), "a\nb");
    expect(readLastLines(file(), 10)).toEqual(["a", "b"]);
  });

  it("tail with lines longer than half a chunk still returns N whole lines (review-2 E4c)", () => {
    const big = (c: string) => c.repeat(40_000);
    writeFileSync(file(), `${big("a")}\n${big("b")}\n${big("c")}\n`);
    expect(readLastLines(file(), 2)).toEqual([big("b"), big("c")]);
  });

  it("tail does not join .1 when the current file was cut by the byte cap (review-2 E6)", () => {
    writeFileSync(`${file()}.1`, "old\n");
    writeFileSync(file(), `${"x".repeat(9 * 1024 * 1024)}\nlast\n`);
    expect(tailLogs(h.paths, 5)).toEqual(["last"]);
  });

  it("tail with only .1 (current file not created yet) → lines of .1 (review-3 G3 M16)", () => {
    writeFileSync(`${file()}.1`, "a\nb\n");
    expect(tailLogs(h.paths, 5)).toEqual(["a", "b"]);
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

  it("follow: the old file's last line without a newline is printed at rotation (review-2 E6)", async () => {
    writeFileSync(file(), "");
    const got: string[] = [];
    const abort = new AbortController();
    const done = followLogs(h.paths, (l) => got.push(l), abort.signal, 20);
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(file(), "cut-off");
    await new Promise((r) => setTimeout(r, 80));
    renameSync(file(), `${file()}.1`);
    writeFileSync(file(), "next\n");
    const end = Date.now() + 5_000;
    while (got.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await done;
    expect(got).toEqual(["cut-off", "next"]);
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
