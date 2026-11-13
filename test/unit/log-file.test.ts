import { existsSync, linkSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDaemonArgs } from "../../src/daemon.js";
import { isWebhubError } from "../../src/errors.js";
import {
  LOG_FILE_MAX_BYTES,
  openLogFile,
  REOPEN_AFTER_MS,
  resolveLogFile,
} from "../../src/server/log-file.js";
import { tempHome } from "../helpers/home.js";

let h: Awaited<ReturnType<typeof tempHome>>;
beforeEach(async () => {
  h = await tempHome();
  await mkdir(h.paths.logs, { recursive: true });
});
afterEach(() => h.cleanup());

const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "");
const msgs = (file: string) => lines(file).map((l) => JSON.parse(l).msg);

describe("parseDaemonArgs (CR-003)", () => {
  it("accepts nothing or one --log-file", () => {
    expect(parseDaemonArgs([])).toEqual({ logFile: undefined });
    expect(parseDaemonArgs(["--"])).toEqual({ logFile: undefined });
    expect(parseDaemonArgs(["--log-file", "a.log"])).toEqual({ logFile: "a.log" });
    expect(parseDaemonArgs(["--log-file=a.log"])).toEqual({ logFile: "a.log" });
  });

  it.each([
    [["--log-file"]],
    [["--log-file="]],
    [["--log-file", "a", "--log-file", "b"]],
    [["--log-file=a", "--log-file=b"]],
    [["--log-file", "a", "--log-file=a"]],
    [["--verbose"]],
    [["--LOG-FILE", "a"]],
    [["extra"]],
    [["--", "--log-file=a"]],
    [["--log-file", "a", "extra"]],
  ])("refuses %j", (argv) => {
    expect(() => parseDaemonArgs(argv)).toThrow();
  });
});

describe("resolveLogFile (CR-003)", () => {
  it("accepts a plain name directly in logs/", async () => {
    for (const name of ["daemon.log", "a", "x_1-2.log.txt"]) {
      const f = join(h.paths.logs, name);
      await expect(resolveLogFile(h.paths, f)).resolves.toBe(f);
    }
  });

  it.each([
    ["the logs dir itself", (p: string) => p],
    ["outside home", (_p: string) => join(h.root, "x.log")],
    ["another home dir", (_p: string) => join(h.paths.data, "auth.json")],
    ["dot-dot escape", (p: string) => join(p, "..", "data", "x.log")],
    ["a sub-directory of logs/ (review Z3/Z5)", (p: string) => join(p, "sub", "x.log")],
  ])("refuses %s", async (_name, make) => {
    await expect(resolveLogFile(h.paths, make(h.paths.logs))).rejects.toSatisfy((e) =>
      isWebhubError(e, "PATH_OUTSIDE_HOME"),
    );
  });

  it.each([
    "CON",
    "nul",
    "nul.txt",
    "COM1.log",
    "lpt9",
    "x.log.",
    "x.log ",
    "daemon.log:evil",
    "-x.log",
    ".hidden",
    "...",
    "a".repeat(65),
  ])("refuses the name %j (security AA3)", async (name) => {
    await expect(resolveLogFile(h.paths, join(h.paths.logs, name))).rejects.toSatisfy((e) =>
      isWebhubError(e, "HOME_INVALID"),
    );
  });

  it("refuses a directory and a hardlink (security AA1)", async () => {
    await mkdir(join(h.paths.logs, "d.log"));
    await expect(resolveLogFile(h.paths, join(h.paths.logs, "d.log"))).rejects.toSatisfy((e) =>
      isWebhubError(e, "HOME_INVALID"),
    );
    const secret = join(h.paths.home, "secret.json");
    writeFileSync(secret, "SECRET");
    linkSync(secret, join(h.paths.logs, "hl.log"));
    await expect(resolveLogFile(h.paths, join(h.paths.logs, "hl.log"))).rejects.toSatisfy((e) =>
      isWebhubError(e, "HOME_INVALID"),
    );
  });

  it("refuses logs/ when it is a junction", async (ctx) => {
    const outside = join(h.root, "outside");
    await mkdir(outside);
    await rename(h.paths.logs, `${h.paths.logs}-old`);
    try {
      await symlink(outside, h.paths.logs, "junction");
    } catch {
      ctx.skip();
    }
    await expect(resolveLogFile(h.paths, join(h.paths.logs, "x.log"))).rejects.toSatisfy((e) =>
      isWebhubError(e, "SYMLINK_REFUSED"),
    );
  });
});

describe("openLogFile (CR-003)", () => {
  it("cap is 5 MB and re-open waits 1 s", () => {
    expect(LOG_FILE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(REOPEN_AFTER_MS).toBe(1_000);
  });

  it("appends JSON lines with a timestamp", () => {
    const f = join(h.paths.logs, "daemon.log");
    const log = openLogFile(f);
    log.write({ msg: "ready", port: 1 });
    log.write({ msg: "stopped" });
    log.close();
    const got = lines(f).map((l) => JSON.parse(l));
    expect(got.map((e) => e.msg)).toEqual(["ready", "stopped"]);
    expect(typeof got[0].t).toBe("string");
  });

  it("rotates before the cap: file ≤ max, .1 holds the previous lines, no line is split", () => {
    const f = join(h.paths.logs, "daemon.log");
    const max = 4_096;
    const log = openLogFile(f, { maxBytes: max });
    for (let i = 0; i < 500; i++) log.write({ msg: "x".repeat(100), i });
    log.close();
    expect(statSync(f).size).toBeLessThanOrEqual(max);
    expect(statSync(`${f}.1`).size).toBeLessThanOrEqual(max);
    const all = [...lines(`${f}.1`), ...lines(f)].map((l) => JSON.parse(l).i);
    expect(all.at(-1)).toBe(499);
    expect(all).toEqual(all.map((_, k) => all[0] + k));
  });

  it("a line that ends exactly at the cap does not rotate; one more byte does (review Z9)", () => {
    const f = join(h.paths.logs, "daemon.log");
    const probe = join(h.paths.logs, "probe.log");
    const p = openLogFile(probe);
    p.write({ msg: "a" });
    p.close();
    const one = statSync(probe).size; // every line below has the same length
    const log = openLogFile(f, { maxBytes: one * 3 });
    for (let i = 0; i < 3; i++) log.write({ msg: "a" });
    expect(existsSync(`${f}.1`)).toBe(false);
    log.write({ msg: "a" });
    log.close();
    expect(lines(`${f}.1`)).toHaveLength(3);
    expect(lines(f)).toHaveLength(1);
  });

  it("a line bigger than the cap on an empty file does not rotate an empty file over .1", () => {
    const f = join(h.paths.logs, "daemon.log");
    writeFileSync(`${f}.1`, '{"msg":"history"}\n');
    const log = openLogFile(f, { maxBytes: 64 });
    log.write({ msg: "z".repeat(200) });
    log.close();
    expect(msgs(`${f}.1`)).toEqual(["history"]);
    expect(lines(f)).toHaveLength(1);
  });

  it("keeps the cap when the rename fails (.1 is a directory): truncates instead", async () => {
    const f = join(h.paths.logs, "daemon.log");
    await mkdir(`${f}.1`);
    const max = 2_048;
    const log = openLogFile(f, { maxBytes: max });
    for (let i = 0; i < 200; i++) log.write({ msg: "y".repeat(100), i });
    log.close();
    expect(statSync(f).size).toBeLessThanOrEqual(max);
    const kept = lines(f).map((l) => JSON.parse(l).i);
    expect(kept.at(-1)).toBe(199);
    // after a truncate the size starts again from 0 (review-2 B3): the file keeps filling, not
    // one line per truncate
    expect(kept.length).toBeGreaterThan(1);
    expect(kept).toEqual(kept.map((_, k) => (kept[0] ?? 0) + k));
  });

  it("short write, then a failing write: the next line still starts on its own line (review-2 B1)", () => {
    const f = join(h.paths.logs, "daemon.log");
    let now = 0;
    let mode: "ok" | "short" | "throw" = "ok";
    const log = openLogFile(f, {
      now: () => now,
      writeSync: (fd, buf) => {
        if (mode === "throw") throw new Error("EIO");
        return writeSync(fd, mode === "short" ? buf.subarray(0, 5) : buf);
      },
    });
    log.write({ msg: "one" });
    mode = "short";
    log.write({ msg: "cut" });
    mode = "throw";
    now = 1_000;
    log.write({ msg: "lost" });
    mode = "ok";
    now = 2_000;
    log.write({ msg: "two" });
    log.close();
    const all = readFileSync(f, "utf8").split("\n");
    expect(JSON.parse(all[0] ?? "").msg).toBe("one");
    expect(all[1]).toHaveLength(5);
    expect(JSON.parse(all[2] ?? "").msg).toBe("two");
  });

  it("the newline after a cut line counts toward the cap (review-2 B2)", () => {
    const f = join(h.paths.logs, "daemon.log");
    let now = 0;
    let short = false;
    const max = 300;
    const log = openLogFile(f, {
      now: () => now,
      maxBytes: max,
      writeSync: (fd, buf) => writeSync(fd, short ? buf.subarray(0, 10) : buf),
    });
    for (let pad = 0; pad < 120; pad++) {
      log.write({ msg: "a".repeat(pad) });
      short = true;
      log.write({ msg: "b" });
      short = false;
      now += 1_000;
      expect(statSync(f).size).toBeLessThanOrEqual(max);
    }
    log.close();
  });

  it("appends to an existing file and counts its size", async () => {
    const f = join(h.paths.logs, "daemon.log");
    await writeFile(f, `${"z".repeat(3_000)}\n`);
    const log = openLogFile(f, { maxBytes: 3_100 });
    log.write({ msg: "a".repeat(200) });
    log.close();
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(lines(f)).toHaveLength(1);
  });

  it("an open that fails never throws; re-open waits exactly 1 s (review Z10)", async () => {
    const dir = join(h.paths.logs, "later");
    const f = join(dir, "daemon.log");
    let now = 0;
    const log = openLogFile(f, { now: () => now });
    expect(() => log.write({ msg: "dropped" })).not.toThrow();
    await mkdir(dir);
    now = 999;
    log.write({ msg: "dropped too" });
    expect(existsSync(f)).toBe(false);
    now = 1_000;
    log.write({ msg: "kept" });
    log.close();
    expect(msgs(f)).toEqual(["kept"]);
  });

  it("a write that throws never throws out; the line is dropped, re-open after 1 s (review Z1)", () => {
    const f = join(h.paths.logs, "daemon.log");
    let now = 0;
    let failNext = 0;
    const log = openLogFile(f, {
      now: () => now,
      writeSync: (fd, buf) => {
        if (failNext > 0) {
          failNext--;
          throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        }
        return writeSync(fd, buf);
      },
    });
    log.write({ msg: "one" });
    failNext = 1;
    expect(() => log.write({ msg: "lost (ENOSPC)" })).not.toThrow();
    now = 500;
    log.write({ msg: "lost (waiting)" });
    now = 1_000;
    log.write({ msg: "two" });
    log.close();
    expect(msgs(f)).toEqual(["one", "two"]);
  });

  it("a short write ends the cut line before the next one (review Z7, security AA4)", () => {
    const f = join(h.paths.logs, "daemon.log");
    let now = 0;
    let short = false;
    const log = openLogFile(f, {
      now: () => now,
      writeSync: (fd, buf) => writeSync(fd, short ? buf.subarray(0, 5) : buf),
    });
    log.write({ msg: "one" });
    short = true;
    log.write({ msg: "cut" });
    short = false;
    log.write({ msg: "dropped (waiting)" });
    now = 1_000;
    log.write({ msg: "two" });
    log.close();
    const all = readFileSync(f, "utf8").split("\n");
    expect(JSON.parse(all[0] ?? "").msg).toBe("one");
    expect(all[1]).toHaveLength(5); // the cut piece stays on its own line
    expect(JSON.parse(all[2] ?? "").msg).toBe("two");
  });

  it("a clock that steps back does not stop logging (review Z6)", () => {
    const f = join(h.paths.logs, "daemon.log");
    let now = 10_000;
    let failNext = 1;
    const log = openLogFile(f, {
      now: () => now,
      writeSync: (fd, buf) => {
        if (failNext-- > 0) throw new Error("EIO");
        return writeSync(fd, buf);
      },
    });
    log.write({ msg: "lost" });
    now = 0; // earlier than the failure
    log.write({ msg: "kept" });
    log.close();
    expect(msgs(f)).toEqual(["kept"]);
  });

  it("refuses a hardlink planted after start-up (checked again on open)", () => {
    const f = join(h.paths.logs, "daemon.log");
    const secret = join(h.paths.home, "secret.json");
    writeFileSync(secret, "SECRET");
    const log = openLogFile(f);
    linkSync(secret, f);
    log.write({ msg: "x" });
    log.close();
    expect(readFileSync(secret, "utf8")).toBe("SECRET");
  });

  it("refuses a file symlink planted after start-up", async (ctx) => {
    const f = join(h.paths.logs, "daemon.log");
    const outside = join(h.root, "outside.txt");
    writeFileSync(outside, "");
    try {
      await symlink(outside, f, "file");
    } catch {
      ctx.skip(); // no symlink privilege (Developer Mode off)
    }
    const log = openLogFile(f);
    log.write({ msg: "x" });
    log.close();
    expect(readFileSync(outside, "utf8")).toBe("");
  });

  it("refuses logs/ swapped for a junction after start-up", async (ctx) => {
    const f = join(h.paths.logs, "daemon.log");
    const outside = join(h.root, "outside");
    await mkdir(outside);
    const log = openLogFile(f);
    await rename(h.paths.logs, `${h.paths.logs}-old`);
    try {
      await symlink(outside, h.paths.logs, "junction");
    } catch {
      ctx.skip();
    }
    log.write({ msg: "x" });
    log.close();
    expect(existsSync(join(outside, "daemon.log"))).toBe(false);
  });
});
