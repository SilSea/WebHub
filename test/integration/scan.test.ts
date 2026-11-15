/**
 * F-006 end to end (spec §8 rows 7, 8): `/api/v1/scan` as a background job behind the API's
 * auth (start / progress / cancel / close), and `webhub scan` against a real daemon (dist/).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stopDaemon } from "../../src/cli/daemon-control.js";
import { ensureHome } from "../../src/config/home.js";
import { scanFile, scanRoutes } from "../../src/scanner/routes.js";
import { createApi } from "../../src/server/api.js";
import { SessionStore } from "../../src/server/auth.js";
import { acquireLock, type Lock } from "../../src/store/lock.js";
import { copyFixture, removeFixtureCopy } from "../helpers/fixture.js";
import { tempHome } from "../helpers/home.js";

const ROOT = join(import.meta.dirname, "../..");
const CLI = join(ROOT, "dist", "cli.js");

beforeAll(async () => {
  for (const [src, built] of [
    ["src/cli.ts", "dist/cli.js"],
    ["src/cli/scan-command.ts", "dist/cli/scan-command.js"],
    ["src/scanner/scan.ts", "dist/scanner/scan.js"],
    ["src/scanner/routes.ts", "dist/scanner/routes.js"],
    ["src/daemon.ts", "dist/daemon.js"],
  ] as const) {
    const b = await stat(join(ROOT, built)).catch(() => null);
    if (b === null || b.mtimeMs < (await stat(join(ROOT, src))).mtimeMs) {
      throw new Error(`${built} is missing or older than ${src} — run \`pnpm build\` first`);
    }
  }
});

let h: Awaited<ReturnType<typeof tempHome>>;
let project: string;
beforeEach(async () => {
  h = await tempHome();
  project = await copyFixture("vite-basic");
});
afterEach(async () => {
  await removeFixtureCopy(project);
  await h.cleanup();
});

describe("/api/v1/scan (F-006)", { timeout: 60_000 }, () => {
  const TOKEN = randomBytes(32).toString("base64url");
  const auth = { host: "127.0.0.1:7400", authorization: `Bearer ${TOKEN}` };
  let lock: Lock;
  // ensureHome + lock run PowerShell on Windows: slow on a loaded machine (hook default 10 s)
  beforeEach(async () => {
    await ensureHome(h.paths);
    lock = await acquireLock(h.paths);
  }, 60_000);
  afterEach(() => lock.release());

  /** API whose scans wait for `gate` before reading the config (deterministic "running"). */
  const make = (gate: () => Promise<void>) =>
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
      [
        scanRoutes(h.paths, lock, {
          config: async () => {
            await gate();
            return { scanRoots: [project] };
          },
        }),
      ],
    );

  it("needs auth; start → 202, second start → 409, progress, result saved", async () => {
    let open: () => void = () => {};
    let gate = new Promise<void>((r) => (open = r));
    const app = await make(() => gate);
    try {
      for (const method of ["GET", "POST", "DELETE"] as const) {
        const anon = await app.inject({
          method,
          url: "/api/v1/scan",
          headers: { host: "127.0.0.1:7400" },
        });
        expect(anon.statusCode, method).toBe(401);
      }
      const empty = await app.inject({ method: "GET", url: "/api/v1/scan", headers: auth });
      expect(empty.json()).toEqual({ running: null, last: null, lastError: null });

      const start = await app.inject({ method: "POST", url: "/api/v1/scan", headers: auth });
      expect(start.statusCode).toBe(202);
      const { scanId } = start.json() as { scanId: string };
      expect(scanId).toMatch(/^[0-9a-f]{16}$/);

      const again = await app.inject({ method: "POST", url: "/api/v1/scan", headers: auth });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: { code: "SCAN_RUNNING" }, scanId });

      const during = await app.inject({ method: "GET", url: "/api/v1/scan", headers: auth });
      expect((during.json() as { running: { scanId: string } }).running.scanId).toBe(scanId);
      // review-1 C13: DELETE of another scanId cancels nothing
      const other = await app.inject({
        method: "DELETE",
        url: "/api/v1/scan?scanId=0000000000000000",
        headers: auth,
      });
      expect(other.json()).toEqual({ cancelled: false });

      open();
      let body: { running: unknown; last: { scanId: string; candidates: { name: string }[] } };
      do {
        await new Promise((r) => setTimeout(r, 20));
        body = (await app.inject({ method: "GET", url: "/api/v1/scan", headers: auth })).json();
      } while (body.running !== null);
      expect(body.last.scanId).toBe(scanId);
      expect(body.last.candidates.map((c) => c.name)).toEqual(["vite-basic"]);
      expect(existsSync(scanFile(h.paths))).toBe(true);
      expect(start.headers["access-control-allow-origin"]).toBeUndefined();
      // review-1 C14: `?result=0` while a scan runs leaves out the last result
      gate = new Promise<void>(() => {});
      const second = await app.inject({ method: "POST", url: "/api/v1/scan", headers: auth });
      expect(second.statusCode).toBe(202);
      const lean = (
        await app.inject({ method: "GET", url: "/api/v1/scan?result=0", headers: auth })
      ).json() as { running: unknown; last: unknown };
      expect(lean.running).not.toBeNull();
      expect(lean.last).toBeNull();
      const full = (
        await app.inject({ method: "GET", url: "/api/v1/scan", headers: auth })
      ).json() as { last: { scanId: string } };
      expect(full.last.scanId).toBe(scanId);
    } finally {
      await app.close();
    }
  });

  it("DELETE cancels: nothing saved; closing the API aborts a running scan", async () => {
    const app = await make(() => new Promise<void>(() => {})); // never opens
    try {
      await app.inject({ method: "POST", url: "/api/v1/scan", headers: auth });
      const del = await app.inject({ method: "DELETE", url: "/api/v1/scan", headers: auth });
      expect(del.json()).toEqual({ cancelled: true });
      const after = (
        await app.inject({ method: "GET", url: "/api/v1/scan", headers: auth })
      ).json() as { running: unknown; last: unknown; lastError: unknown };
      expect(after).toEqual({ running: null, last: null, lastError: null });
      expect(existsSync(scanFile(h.paths))).toBe(false);
      const none = await app.inject({ method: "DELETE", url: "/api/v1/scan", headers: auth });
      expect(none.json()).toEqual({ cancelled: false });
      await app.inject({ method: "POST", url: "/api/v1/scan", headers: auth });
    } finally {
      const t0 = Date.now();
      await app.close(); // must not hang on the scan that waits forever
      expect(Date.now() - t0).toBeLessThan(5_000);
    }
    expect(existsSync(scanFile(h.paths))).toBe(false);
  });
});

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

describe("webhub scan (F-006)", { timeout: 120_000 }, () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    env = { ...process.env, WEBHUB_HOME: h.paths.home, WEBHUB_API_PORT: String(await freePort()) };
    mkdirSync(h.paths.home, { recursive: true });
    writeFileSync(
      h.paths.config,
      JSON.stringify({ schemaVersion: 1, scanRoots: [join(project, "..")] }),
    );
  });
  afterEach(async () => {
    await stopDaemon(h.paths, { force: true, timeoutMs: 3_000 }).catch(() => {});
  });

  it("--last before any scan → exit 1; scan → table; --json; --last", async () => {
    const none = await cli(["scan", "--last"], env);
    expect(none.code).toBe(1);
    expect(none.err).toContain("no scan result yet");

    const r = await cli(["scan"], env);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^NAME\s+KIND\s+PROFILE\s+RUNNER\s+PORT\s+PATH/);
    expect(r.out).toMatch(/\nvite-basic\s+site\s+vite\s+native\s+5173 \(arg\)\s+/);
    expect(r.err).toContain("1 site(s)");

    const json = await cli(["--json", "scan", "--last"], env);
    expect(json.code).toBe(0);
    const body = JSON.parse(json.out) as { candidates: { name: string; path: string }[] };
    expect(body.candidates.map((c) => c.name)).toEqual(["vite-basic"]);
    expect(body.candidates[0]?.path).toBe(project);
  });

  it("missing scan root is reported; bad option → exit 2", async () => {
    writeFileSync(
      h.paths.config,
      JSON.stringify({ schemaVersion: 1, scanRoots: [join(h.root, "nope")] }),
    );
    const r = await cli(["scan"], env);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/scan root .*nope: missing/);
    const bad = await cli(["scan", "--nope"], env);
    expect(bad.code).toBe(2);
  });
});
