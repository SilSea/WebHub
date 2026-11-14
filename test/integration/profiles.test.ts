/**
 * F-005 end to end: `GET /api/v1/profiles` behind the API's auth, and `webhub profiles` against
 * a real daemon (built dist/).
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stopDaemon } from "../../src/cli/daemon-control.js";
import { profileRoutes } from "../../src/profiles/routes.js";
import { createApi } from "../../src/server/api.js";
import { SessionStore } from "../../src/server/auth.js";
import { tempHome } from "../helpers/home.js";

const ROOT = join(import.meta.dirname, "../..");
const CLI = join(ROOT, "dist", "cli.js");

const VALID = `schemaVersion: 1
id: mine
language: node
detect:
  all: [{ file: "package.json" }]
  score: 60
start: { cmd: "mine --port {PORT}" }
port: { default: 3000, via: arg }
`;

beforeAll(async () => {
  for (const [src, built] of [
    ["src/cli.ts", "dist/cli.js"],
    ["src/cli/profiles-command.ts", "dist/cli/profiles-command.js"],
    ["src/profiles/loader.ts", "dist/profiles/loader.js"],
    ["src/profiles/schema.ts", "dist/profiles/schema.js"],
    ["src/daemon.ts", "dist/daemon.js"],
  ] as const) {
    const b = await stat(join(ROOT, built)).catch(() => null);
    if (b === null || b.mtimeMs < (await stat(join(ROOT, src))).mtimeMs) {
      throw new Error(`${built} is missing or older than ${src} — run \`pnpm build\` first`);
    }
  }
});

let h: Awaited<ReturnType<typeof tempHome>>;
beforeEach(async () => {
  h = await tempHome();
});
afterEach(() => h.cleanup());

describe("GET /api/v1/profiles (F-005)", () => {
  const TOKEN = randomBytes(32).toString("base64url");
  const make = () =>
    createApi(
      {
        token: TOKEN,
        hosts: { apiPort: 7400, httpPort: 80, domainSuffix: "localhost" },
        sessions: new SessionStore(),
        status: () => ({}),
        onShutdown: () => {},
        log: () => {},
        failDelayMs: 0,
      },
      [profileRoutes(h.paths)],
    );

  it("needs auth; answers ids, sources and relative files only", async () => {
    mkdirSync(h.paths.profiles, { recursive: true });
    writeFileSync(join(h.paths.profiles, "mine.yml"), VALID);
    writeFileSync(join(h.paths.profiles, "bad.yml"), "id: [");
    const app = await make();
    try {
      const anon = await app.inject({
        method: "GET",
        url: "/api/v1/profiles",
        headers: { host: "127.0.0.1:7400" },
      });
      expect(anon.statusCode).toBe(401);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/profiles",
        headers: { host: "127.0.0.1:7400", authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        profiles: { id: string; source: string }[];
        problems: { file: string }[];
      };
      expect(body.profiles.map((p) => p.id)).toContain("vite");
      expect(body.profiles.find((p) => p.id === "mine")).toEqual({
        id: "mine",
        language: "node",
        source: "user",
        file: "data/profiles/mine.yml",
      });
      expect(body.problems.map((p) => p.file)).toEqual(["data/profiles/bad.yml"]);
      expect(res.body).not.toContain(h.root.replaceAll("\\", "\\\\"));
      // a browser on another site cannot read it (no CORS)
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function cli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString();
    });
    child.once("close", (code) => resolve({ code, out, err }));
  });
}

describe("webhub profiles (F-005)", { timeout: 120_000 }, () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    env = { ...process.env, WEBHUB_HOME: h.paths.home, WEBHUB_API_PORT: String(await freePort()) };
  });
  afterEach(async () => {
    await stopDaemon(h.paths, { force: true, timeoutMs: 3_000 }).catch(() => {});
  });
  afterAll(() => {});

  it("--no-start without a daemon → exit 3", async () => {
    const r = await cli(["--no-start", "profiles"], env);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/not running/);
  });

  it("starts the daemon, lists profiles; --check / --json; problems sanitised on stderr", async () => {
    const r = await cli(["profiles"], env);
    expect(r.code).toBe(0);
    expect(r.err).toContain("starting the daemon");
    expect(r.out).toMatch(/^ID\s+LANGUAGE\s+SOURCE/);
    expect(r.out).toMatch(/\nvite\s+node\s+built-in/);

    const ok = await cli(["profiles", "--check"], env);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("all profile files are valid");

    mkdirSync(h.paths.profiles, { recursive: true });
    writeFileSync(join(h.paths.profiles, "vite.yml"), VALID.replace("id: mine", "id: vite"));
    // a key with an escape sequence: the error names the key, the escape must not reach the
    // terminal raw
    writeFileSync(
      join(h.paths.profiles, "evil.yml"),
      `${VALID.replace("id: mine", "id: evil")}"k\\e[31m\\x9bRED": 1\n`,
    );
    const list = await cli(["profiles"], env);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(
      /\nvite\s+node\s+user \(data\/profiles\/vite\.yml, replaces built-in\)/,
    );
    expect(list.err).toContain("data/profiles/evil.yml");
    expect(list.err).toContain("k?[31m?RED");
    expect(list.err).not.toContain("\u001b");

    const check = await cli(["profiles", "--check"], env);
    expect(check.code).toBe(2);
    const json = await cli(["--json", "profiles", "--check"], env);
    expect(json.code).toBe(2);
    const body = JSON.parse(json.out) as {
      profiles: { id: string }[];
      problems: { file: string }[];
    };
    expect(body.problems.map((p) => p.file)).toEqual(["data/profiles/evil.yml"]);
    expect(body.profiles.length).toBeGreaterThanOrEqual(7);
    // C1 (8-bit CSI) is not escaped by JSON.stringify: sanitised too (security-1 S7)
    expect(json.out).not.toContain(String.fromCharCode(0x9b));
    expect(json.out).toContain("k?[31m?RED");
  });

  it("bad option → exit 2", async () => {
    const r = await cli(["profiles", "--nope"], env);
    expect(r.code).toBe(2);
  });
});
