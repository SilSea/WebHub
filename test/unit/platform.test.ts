import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EXIT,
  main as elevatedMain,
  TOKEN_MAX_LENGTH,
  validateTask,
} from "../../src/platform/elevated.mjs";
import {
  getPlatform,
  isPlatformError,
  setPlatformLog,
  unsupportedPlatform,
} from "../../src/platform/index.js";
import {
  decodeTask,
  describeTask,
  ElevatedTaskSchema,
  encodeTask,
  parseTask,
  TOKEN_MAX_AGE_MS,
} from "../../src/platform/tasks.js";
import {
  cleanText,
  descendants,
  ELEVATE_PS,
  elevatedCommand,
  elevateOutcome,
  NOTIFY_PS,
  notifyVia,
  type ProcRow,
  parseExcluded,
  parseListening,
  pickFree,
} from "../../src/platform/win32.js";
import { fields, PS_UTF8 } from "../../src/platform/win32-shell.js";
import {
  ENV_PS,
  elevationFiles,
  nodeEnvProblems,
  trustTargets,
} from "../../src/platform/win32-trust.js";
import type { ExecResult } from "../../src/proc/exec.js";

const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === "function" ? p() : p);
    return "ok";
  } catch (err) {
    return isPlatformError(err) ? err.code : `other:${(err as Error).message}`;
  }
};

const decodeFields = (input: string): string[] =>
  input
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      expect(l).toMatch(/^f:[A-Za-z0-9+/=]*$/);
      return Buffer.from(l.slice(2), "base64").toString("utf8");
    });

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
    const no = () => true;
    const yes = async () => true;
    expect(await code(pickFree([4100, 4101], no, yes))).toBe("PORT_EXHAUSTED");
    expect(await code(pickFree([5000, 4000], () => false, yes))).toBe("PORT_INVALID");
    expect(await code(pickFree([0, 10], () => false, yes))).toBe("PORT_INVALID");
    expect(await code(pickFree([65535, 65535], () => false, yes))).toBe("ok");
  });
});

describe("process input validation", () => {
  it("bad PIDs → PID_INVALID before any tool runs", async () => {
    const p = getPlatform("win32").process;
    expect(await code(p.info(0))).toBe("PID_INVALID");
    expect(await code(p.killTree(1.5, "x"))).toBe("PID_INVALID");
    expect(await code(p.usage([1, -3]))).toBe("PID_INVALID");
  });

  it("descendants: root first, ignores children older than the parent (PID reuse)", () => {
    const t = (i: number, p: number, c: string): ProcRow => ({ i, p, c });
    const root = t(10, 1, "2026-11-07T10:00:00.0000000Z");
    const table = [
      root,
      t(11, 10, "2026-11-07T10:00:01.0000000Z"), // child
      t(12, 11, "2026-11-07T10:00:02.0000000Z"), // grandchild
      t(13, 10, "2026-11-07T09:00:00.0000000Z"), // parent was an earlier holder of PID 10
      t(14, 10, ""), // start time unknown → not ours
      t(15, 99, "2026-11-07T10:00:03.0000000Z"),
    ];
    expect(descendants(table, root).map((r) => r.i)).toEqual([10, 11, 12]);
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

  it("parity: hand-written validator in elevated.mts accepts exactly what the zod schema accepts", () => {
    const evilProto = JSON.parse('{"kind":"noop","__proto__":{"x":1}}') as unknown;
    const corpus: unknown[] = [
      { kind: "noop" },
      { kind: "exec", cmd: "calc.exe" },
      { kind: "noop", extra: 1 },
      { kind: "noop", extra: undefined },
      evilProto,
      Object.create({ kind: "noop" }) as unknown, // inherited kind
      "noop",
      null,
      undefined,
      [],
      [{ kind: "noop" }],
      { kind: "NOOP" },
      { kind: "hosts.writeBlock" },
      {},
      42,
    ];
    for (const input of corpus) {
      const zodOk = (() => {
        try {
          parseTask(input);
          return true;
        } catch {
          return false;
        }
      })();
      // the admin side may be stricter than zod, never looser
      if (validateTask(input) !== undefined) expect(zodOk, String(input)).toBe(true);
      // and on every value AFTER the JSON trip the token makes, both sides agree exactly
      // (zod also accepts an inherited `kind`; JSON drops it, so compare on the tripped value)
      const json = JSON.stringify(input);
      if (json !== undefined) {
        const tripped: unknown = JSON.parse(json);
        const zodTripped = ElevatedTaskSchema.safeParse(tripped).success;
        expect(validateTask(tripped) !== undefined, json).toBe(zodTripped);
      }
    }
    expect(validateTask(evilProto)).toBeUndefined();
  });

  it("parity: every allowlisted kind has a valid sample accepted by BOTH validators (E5)", () => {
    const samples: Record<string, unknown> = { noop: { kind: "noop" } };
    const kinds = ElevatedTaskSchema.options.map((o) => o.shape.kind.value as string);
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) {
      const s = samples[k];
      expect(s, `add a sample for kind ${k}`).toBeDefined();
      expect(parseTask(s)).toEqual(s);
      expect(validateTask(JSON.parse(JSON.stringify(s)))).toEqual(s);
    }
  });

  it("elevated.mts is self-contained: imports only node: built-ins (security-2 T3)", async () => {
    const src = await readFile(new URL("../../src/platform/elevated.mts", import.meta.url), "utf8");
    const specs = [
      ...src.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g),
    ].map((m) => m[1] ?? m[2]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s).toMatch(/^node:/);
  });

  it("token round-trip; malformed tokens refused", async () => {
    const t = encodeTask({ kind: "noop" });
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTask(t)).toEqual({ kind: "noop" });
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of [
      "",
      "has space",
      '"quote"',
      "a".repeat(9000),
      Buffer.from("{").toString("base64url"),
      enc({ kind: "noop" }), // bare task without envelope
      enc({ v: 1, iat: Date.now(), task: { kind: "exec", cmd: "x" } }),
      enc({ v: 1, iat: Date.now(), task: { kind: "noop" }, extra: 1 }),
      enc({ v: 2, iat: Date.now(), task: { kind: "noop" } }),
    ]) {
      expect(await code(() => decodeTask(bad))).toBe("ELEVATION_INVALID");
    }
  });

  it("token expires (late UAC answer runs nothing)", async () => {
    const now = 1_800_000_000_000;
    const t = encodeTask({ kind: "noop" }, now);
    expect(decodeTask(t, now + TOKEN_MAX_AGE_MS)).toEqual({ kind: "noop" });
    expect(await code(() => decodeTask(t, now + TOKEN_MAX_AGE_MS + 1))).toBe("ELEVATION_EXPIRED");
    expect(await code(() => decodeTask(t, now - 120_000))).toBe("ELEVATION_EXPIRED");
  });

  it("elevated entry: 10 valid (never 0), 2 invalid, 3 expired", async () => {
    expect(EXIT.ok).not.toBe(0);
    expect(await elevatedMain([encodeTask({ kind: "noop" })])).toBe(EXIT.ok);
    expect(await elevatedMain(["a".repeat(TOKEN_MAX_LENGTH + 1)])).toBe(2);
    expect(await elevatedMain([])).toBe(2);
    expect(await elevatedMain(["a", "b"])).toBe(2);
    expect(await elevatedMain([Buffer.from('{"kind":"exec"}').toString("base64url")])).toBe(2);
    expect(
      await elevatedMain([encodeTask({ kind: "noop" }, Date.now() - TOKEN_MAX_AGE_MS - 1000)]),
    ).toBe(3);
  });

  it("describeTask gives text for the UAC explanation", () => {
    expect(describeTask({ kind: "noop" })).toMatch(/\w/);
  });

  it("invalid task is refused before any UAC prompt", async () => {
    expect(await code(getPlatform("win32").elevate({ kind: "exec", cmd: "calc" }))).toBe(
      "ELEVATION_INVALID",
    );
  });

  it("elevated command: real path of node + built self-contained entry (also from source)", () => {
    const { exe, script } = elevatedCommand();
    expect(exe).toBe(realpathSync.native(process.execPath));
    expect(script).toMatch(/[\\/]dist[\\/]platform[\\/]elevated\.mjs$/);
  });

  it("elevate script is fixed text; exe/script/token only as stdin fields", () => {
    const evil = `C:\\x" & calc & "\n$(calc)`;
    const input = fields([evil, evil, "tok"]);
    expect(decodeFields(input)).toEqual([evil, evil, "tok"]);
    expect(ELEVATE_PS).not.toContain("calc");
    expect(ELEVATE_PS).toContain("1223");
  });

  it("elevate outcome: only 1223 is DENIED; expiry, timeout and failures distinct", async () => {
    expect(await code(() => elevateOutcome(`EXIT:${EXIT.ok}\r\n`, 0))).toBe("ok");
    expect(await code(() => elevateOutcome("EXIT:0\r\n", 0))).toBe("ELEVATION_FAILED"); // main never ran
    expect(await code(() => elevateOutcome("DENIED\r\n", 0))).toBe("ELEVATION_DENIED");
    expect(await code(() => elevateOutcome("EXIT:3", 0))).toBe("ELEVATION_EXPIRED");
    expect(await code(() => elevateOutcome("EXIT:2", 0))).toBe("ELEVATION_FAILED");
    expect(await code(() => elevateOutcome("FAIL:Win32Exception 2", 0))).toBe("ELEVATION_FAILED");
    expect(await code(() => elevateOutcome("", -1))).toBe("ELEVATION_FAILED");
  });
});

describe("elevation trust checks (pure parts)", () => {
  it("trustTargets: files full, every ancestor checked once", () => {
    const t = trustTargets(["C:\\a\\b\\c.js", "C:\\a\\b\\d.js", "C:\\a\\b"]);
    expect(t).toEqual([
      ["F", "C:\\a\\b\\c.js"],
      ["F", "C:\\a\\b\\d.js"],
      ["F", "C:\\a\\b"],
      ["A", "C:\\a"],
      ["A", "C:\\"],
    ]);
  });

  it("nodeEnvProblems: NODE_* (except NODE_ENV), OPENSSL_*, SSL_CERT_*, UV_*; deduplicated", () => {
    const names = [
      "Path",
      "TEMP",
      "JAVA_HOME",
      "NODE_ENV",
      "node_options",
      "NODE_PATH",
      "OPENSSL_CONF",
      "OPENSSL_MODULES",
      "SSL_CERT_FILE",
      "UV_THREADPOOL_SIZE",
      "ICU_DATA",
      "NODE_OPTIONS", // same as node_options (Windows env names are case-insensitive)
    ];
    expect(nodeEnvProblems(names).map((s) => s.split(" ")[2])).toEqual([
      "node_options",
      "NODE_PATH",
      "OPENSSL_CONF",
      "OPENSSL_MODULES",
      "SSL_CERT_FILE",
      "UV_THREADPOOL_SIZE",
      "ICU_DATA",
    ]);
  });

  it("nodeEnvProblems: non-ASCII look-alike names refused (best-fit → OPENSSL_CONF, U1)", () => {
    const lookAlikes = [
      "\uff2fPENSSL_CONF",
      "OPEN\u015aSL_CONF",
      "\u014cPENSSL_CONF",
      "OPENSSL\uff3fCONF",
      "\u0e17\u0e14\u0e2a\u0e2d\u0e1a",
    ];
    const problems = nodeEnvProblems(lookAlikes);
    expect(problems).toHaveLength(lookAlikes.length);
    for (const p of problems) expect(p).toMatch(/non-ASCII/);
  });

  it("elevationFiles: node.exe, its folder, DLL/manifest/.local in it, script + folder (U3)", () => {
    expect(
      elevationFiles("C:\\n\\node.exe", "C:\\w\\elevated.mjs", [
        "node.exe",
        "evil.DLL",
        "node.exe.manifest",
        "node.exe.local",
        "README.md",
      ]),
    ).toEqual([
      "C:\\n\\node.exe",
      "C:\\n",
      "C:\\n\\evil.DLL",
      "C:\\n\\node.exe.manifest",
      "C:\\n\\node.exe.local",
      "C:\\w\\elevated.mjs",
      "C:\\w",
    ]);
  });

  it("environment script reads machine, user and volatile keys incl. session subkeys (T2/E1)", () => {
    expect(ENV_PS).toContain("Session Manager\\Environment");
    expect(ENV_PS).toContain("HKCU:\\Environment");
    expect(ENV_PS).toContain("HKCU:\\Volatile Environment");
    expect(ENV_PS).toMatch(/Get-ChildItem -LiteralPath 'HKCU:\\Volatile Environment'/);
  });
});

describe("notify", () => {
  const fake = (stdout: string) => {
    const calls: { script: string; input: string | undefined }[] = [];
    const run = async (script: string, input?: string): Promise<ExecResult> => {
      calls.push({ script, input });
      return { code: 0, stdout, stderr: "" };
    };
    return { calls, run };
  };

  it("script never contains the text; text only as base64 stdin fields", async () => {
    const f = fake("OK\r\n");
    const evil = `webhub '"; $(calc) <b>&`;
    expect(await notifyVia(f.run, evil, "body `n $env:X")).toBe(true);
    expect(await notifyVia(f.run, "other title", "")).toBe(true);
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) {
      expect(c.script).toBe(`${PS_UTF8}\n${NOTIFY_PS}`);
      expect(c.script).not.toContain("calc");
    }
    expect(decodeFields(f.calls[0]?.input ?? "")).toEqual([evil, "body `n $env:X"]);
    expect(decodeFields(f.calls[1]?.input ?? "")).toEqual(["other title", ""]); // empty survives
  });

  it("failure → false + logged, never throws", async () => {
    const logs: string[] = [];
    setPlatformLog((m) => logs.push(m));
    try {
      expect(await notifyVia(fake("FAIL:COMException\r\n").run, "t", "b")).toBe(false);
      const boom = async (): Promise<ExecResult> => {
        throw new Error("spawn failed");
      };
      expect(await notifyVia(boom, "t", "b")).toBe(false);
    } finally {
      setPlatformLog(() => {});
    }
    expect(logs).toEqual([
      "notify failed: FAIL:COMException",
      "notify failed: notify: could not run PowerShell",
    ]);
  });

  it("cleanText: control/XML-invalid chars removed, length in code points, no split pairs", () => {
    expect(cleanText("a\u0000b\nc\u001b[31m", 100)).toBe("a b c [31m");
    expect(cleanText("x\uffffy\ud800z", 100)).toBe("x y z");
    expect(Array.from(cleanText("x".repeat(200), 10))).toHaveLength(10);
    const emoji = cleanText("😀".repeat(20), 5);
    expect(emoji).toBe("😀😀😀😀…");
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)).toBe(false);
  });
});

describe("unsupported OS", () => {
  it("async calls reject with PLATFORM_UNSUPPORTED (never throw synchronously)", async () => {
    const p = unsupportedPlatform("linux");
    const pending = p.ports.listening(); // must not throw here
    await expect(pending).rejects.toSatisfy((e) => isPlatformError(e, "PLATFORM_UNSUPPORTED"));
    expect(await code(p.process.killTree(1, "x"))).toBe("PLATFORM_UNSUPPORTED");
    expect(await code(p.elevate({ kind: "noop" }))).toBe("PLATFORM_UNSUPPORTED");
    expect(await code(() => p.capabilities())).toBe("PLATFORM_UNSUPPORTED");
    expect(await p.notify("t", "b")).toBe(false);
    expect(getPlatform("darwin").name).toBe("darwin");
  });
});
