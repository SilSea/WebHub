import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { main as elevatedMain } from "../../src/platform/elevated.js";
import { getPlatform, isPlatformError, unsupportedPlatform } from "../../src/platform/index.js";
import { decodeTask, describeTask, encodeTask, parseTask } from "../../src/platform/tasks.js";
import {
  cleanText,
  elevatedCommand,
  parseExcluded,
  parseListening,
  pickFree,
} from "../../src/platform/win32.js";

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === "function" ? p() : p);
    return "ok";
  } catch (err) {
    return isPlatformError(err) ? err.code : `other:${(err as Error).message}`;
  }
};

describe("parsers (fixture output)", () => {
  it("parseListening: JSON line, IPv4/IPv6, empty", () => {
    const out = 'noise\r\nJSON:[{"a":"0.0.0.0","p":135,"o":1864},{"a":"::1","p":4100,"o":42}]\r\n';
    expect(parseListening(out)).toEqual([
      { port: 135, address: "0.0.0.0", pid: 1864, family: 4 },
      { port: 4100, address: "::1", pid: 42, family: 6 },
    ]);
    expect(parseListening("JSON:[]")).toEqual([]);
  });

  it.each([
    ["no JSON line", "garbage"],
    ["malformed", "JSON:[{"],
    ["wrong shape", 'JSON:[{"a":1,"p":"x"}]'],
    ["port out of range", 'JSON:[{"a":"x","p":70000,"o":1}]'],
  ])("parseListening rejects %s", async (_n, out) => {
    expect(await code(() => parseListening(out))).toBe("PLATFORM_TOOL");
  });

  it("parseExcluded: numbers only, administered flag, ignores localized text and junk", () => {
    const out = [
      "Protocol tcp Port Exclusion Ranges",
      "",
      "Start Port    End Port",
      "----------    --------",
      "     50000       50059     *",
      "     54288       54288",
      "     99999       99999",
      "      5000        4000",
      "* - Administered port exclusions.",
      "Plage d'exclusion 1 2 3",
    ].join("\r\n");
    expect(parseExcluded(out)).toEqual([
      { start: 50000, end: 50059, administered: true },
      { start: 54288, end: 54288, administered: false },
    ]);
  });
});

describe("pickFree", () => {
  it("skips taken and unbindable ports; lowest first", async () => {
    const taken = (p: number) => p === 4100 || p === 4101;
    const bind = async (p: number) => p !== 4102;
    expect(await pickFree([4100, 4110], taken, bind)).toBe(4103);
  });

  it("exhausted / invalid range", async () => {
    expect(
      await code(
        pickFree(
          [4100, 4101],
          () => true,
          async () => true,
        ),
      ),
    ).toBe("PORT_EXHAUSTED");
    expect(
      await code(
        pickFree(
          [5000, 4000],
          () => false,
          async () => true,
        ),
      ),
    ).toBe("PORT_INVALID");
    expect(
      await code(
        pickFree(
          [0, 10],
          () => false,
          async () => true,
        ),
      ),
    ).toBe("PORT_INVALID");
  });
});

describe("elevated tasks (allowlist)", () => {
  it("accepts only known kinds with exact fields", async () => {
    expect(parseTask({ kind: "noop" })).toEqual({ kind: "noop" });
    for (const bad of [
      { kind: "exec", cmd: "calc.exe" },
      { kind: "noop", extra: 1 },
      "noop",
      null,
      { kind: "hosts.writeBlock" },
    ]) {
      expect(await code(() => parseTask(bad))).toBe("ELEVATION_INVALID");
    }
  });

  it("token round-trip; malformed tokens refused", async () => {
    const t = encodeTask({ kind: "noop" });
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTask(t)).toEqual({ kind: "noop" });
    for (const bad of [
      "",
      "has space",
      '"quote"',
      "a".repeat(9000),
      Buffer.from("{").toString("base64url"),
    ]) {
      expect(await code(() => decodeTask(bad))).toBe("ELEVATION_INVALID");
    }
    const evil = Buffer.from(JSON.stringify({ kind: "exec", cmd: "x" })).toString("base64url");
    expect(await code(() => decodeTask(evil))).toBe("ELEVATION_INVALID");
  });

  it("elevated entry: exit 0 for a valid task, 2 for anything else", async () => {
    expect(await elevatedMain([encodeTask({ kind: "noop" })])).toBe(0);
    expect(await elevatedMain([])).toBe(2);
    expect(await elevatedMain(["a", "b"])).toBe(2);
    expect(await elevatedMain([Buffer.from('{"kind":"exec"}').toString("base64url")])).toBe(2);
  });

  it("describeTask gives text for the UAC explanation", () => {
    expect(describeTask({ kind: "noop" })).toMatch(/\w/);
  });

  it("invalid task is refused before any UAC prompt", async () => {
    expect(await code(getPlatform("win32").elevate({ kind: "exec", cmd: "calc" }))).toBe(
      "ELEVATION_INVALID",
    );
  });

  it("elevated command uses absolute paths (no PATH lookup)", () => {
    const { exe, script } = elevatedCommand();
    expect(isAbsolute(exe)).toBe(true);
    expect(isAbsolute(script)).toBe(true);
    expect(script).toMatch(/elevated\.(ts|js)$/);
  });
});

describe("notify text", () => {
  it("removes control characters and caps length", () => {
    expect(cleanText("a\u0000b\nc\u001b[31m", 100)).toBe("a b c [31m");
    expect(cleanText("x".repeat(200), 10)).toHaveLength(10);
  });
});

describe("unsupported OS", () => {
  it("every call → PLATFORM_UNSUPPORTED; notify → false", async () => {
    const p = unsupportedPlatform("linux");
    expect(await code(() => p.ports.listening())).toBe("PLATFORM_UNSUPPORTED");
    expect(await code(() => p.process.killTree(1, "x"))).toBe("PLATFORM_UNSUPPORTED");
    expect(await code(() => p.elevate({ kind: "noop" }))).toBe("PLATFORM_UNSUPPORTED");
    expect(await p.notify("t", "b")).toBe(false);
    expect(getPlatform("darwin").name).toBe("darwin");
  });
});
