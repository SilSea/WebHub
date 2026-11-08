import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Paths } from "../../src/config/home.js";
import { startDaemon } from "../../src/daemon.js";
import { execFile, systemExe } from "../../src/proc/exec.js";
import { connectDaemon, DaemonClient, sendRaw } from "../../src/server/client.js";
import { isServerError } from "../../src/server/errors.js";
import { tempHome } from "../helpers/home.js";

const ROOT = join(import.meta.dirname, "../..");
const DAEMON = join(ROOT, "dist", "daemon.js");

beforeAll(async () => {
  // the daemon runs from dist/: refuse to test a stale build
  for (const [src, built] of [
    ["src/daemon.ts", "dist/daemon.js"],
    ["src/server/api.ts", "dist/server/api.js"],
    ["src/server/auth.ts", "dist/server/auth.js"],
  ] as const) {
    const b = await stat(join(ROOT, built)).catch(() => null);
    if (b === null || b.mtimeMs < (await stat(join(ROOT, src))).mtimeMs) {
      throw new Error(`${built} is missing or older than ${src} — run \`pnpm build\` first`);
    }
  }
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

interface Proc {
  child: ChildProcess;
  out: string[];
  err: string[];
  exit: Promise<number | null>;
}

const children: ChildProcess[] = [];

function runDaemon(home: string, port: number): Proc {
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, WEBHUB_HOME: home, WEBHUB_API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.on("data", (b: Buffer) => out.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => err.push(b.toString()));
  const exit = new Promise<number | null>((r) => child.once("close", (c) => r(c)));
  return { child, out, err, exit };
}

async function ready(p: Proc): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (p.out.join("").includes('"msg":"ready"')) return;
    if (p.child.exitCode !== null) throw new Error(`daemon exited: ${p.err.join("")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("daemon did not become ready");
}

let h: { root: string; paths: Paths; cleanup(): Promise<void> };
beforeEach(async () => {
  h = await tempHome();
});
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
  await new Promise((r) => setTimeout(r, 200));
  await h.cleanup();
});

describe("daemon lifecycle", { timeout: 120_000 }, () => {
  it("start → auth.json (user-only) → status → shutdown removes auth.json and lock", async () => {
    const port = await freePort();
    const d = runDaemon(h.paths.home, port);
    await ready(d);
    const auth = JSON.parse(await readFile(h.paths.auth, "utf8")) as {
      token: string;
      port: number;
      pid: number;
    };
    expect(auth.port).toBe(port);
    expect(auth.pid).toBe(d.child.pid);
    expect(auth.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform === "win32") {
      const acl = (await execFile(systemExe("icacls.exe"), [h.paths.auth])).stdout;
      const entries = acl
        .split(/\r?\n/)
        .map((l) => l.replace(h.paths.auth, "").trim())
        .filter((l) => l !== "" && !/^Successfully/.test(l));
      expect(entries).toHaveLength(2); // SYSTEM + the current user (inherited from the home)
      for (const e of entries) expect(e).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated/i);
    }
    const client = await connectDaemon(h.paths);
    const status = await client.request<{ pid: number; home: string }>("GET", "/api/v1/status");
    expect(status.pid).toBe(d.child.pid);
    expect(status.home).toBe(h.paths.home);
    // the token never appears in the daemon's output
    expect(d.out.join("") + d.err.join("")).not.toContain(auth.token);

    await client.request("POST", "/api/v1/shutdown");
    expect(await d.exit).toBe(0);
    expect(existsSync(h.paths.auth)).toBe(false);
    expect(existsSync(h.paths.lock)).toBe(false);
    await expect(connectDaemon(h.paths)).rejects.toSatisfy((e) =>
      isServerError(e, "DAEMON_NOT_RUNNING"),
    );
  });

  it("second daemon on the same home → exit 3; port in use → exit 4 naming the owner", async () => {
    const port = await freePort();
    const d = runDaemon(h.paths.home, port);
    await ready(d);
    const second = runDaemon(h.paths.home, await freePort());
    expect(await second.exit).toBe(3);
    expect(second.err.join("")).toMatch(/already running/);

    const other = await tempHome();
    try {
      const busy = runDaemon(other.paths.home, port); // port held by the first daemon
      expect(await busy.exit).toBe(4);
      const text = busy.err.join("");
      expect(text).toMatch(new RegExp(`port ${port}`));
      if (process.platform === "win32") expect(text).toContain(`PID ${d.child.pid}`);
      expect(existsSync(other.paths.auth)).toBe(false);
      expect(existsSync(other.paths.lock)).toBe(false);
    } finally {
      await other.cleanup();
    }
    d.child.kill("SIGTERM");
    await d.exit;
  });

  it("restart → new token; the old token is refused", async () => {
    const port = await freePort();
    const d1 = runDaemon(h.paths.home, port);
    await ready(d1);
    const old = JSON.parse(await readFile(h.paths.auth, "utf8")) as { token: string };
    await (await connectDaemon(h.paths)).request("POST", "/api/v1/shutdown");
    await d1.exit;

    const d2 = runDaemon(h.paths.home, port);
    await ready(d2);
    const now = JSON.parse(await readFile(h.paths.auth, "utf8")) as { token: string };
    expect(now.token).not.toBe(old.token);
    const res = await sendRaw(
      port,
      "GET",
      "/api/v1/status",
      { authorization: `Bearer ${old.token}` },
      undefined,
    );
    expect(res.status).toBe(401);
    // a client still holding the old auth data cannot even verify the server
    const stale = new DaemonClient({
      schemaVersion: 1,
      token: old.token,
      pid: 1,
      port,
      startedAt: "x",
    });
    await expect(stale.verify()).rejects.toSatisfy((e) => isServerError(e, "DAEMON_IMPOSTOR"));
    await (await connectDaemon(h.paths)).request("POST", "/api/v1/shutdown");
    expect(await d2.exit).toBe(0);
  });

  it("raw requests: missing Host → 421, absolute-form target → 400 (not logged with its host)", async () => {
    const port = await freePort();
    const d = runDaemon(h.paths.home, port);
    await ready(d);
    const raw = (text: string) =>
      new Promise<string>((resolve, reject) => {
        const s = connect({ host: "127.0.0.1", port }, () => s.write(text));
        let out = "";
        s.on("data", (b) => {
          out += b.toString();
        });
        s.on("end", () => resolve(out));
        s.on("error", reject);
      });
    expect(await raw("GET /api/v1/health HTTP/1.0\r\n\r\n")).toMatch(/^HTTP\/1\.1 421 /);
    const abs = await raw(
      `GET http://evil.example/api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    expect(abs).toMatch(/^HTTP\/1\.1 400 /);
    await (await connectDaemon(h.paths)).request("POST", "/api/v1/shutdown");
    await d.exit;
    expect(d.out.join("")).not.toContain("evil.example");
  });

  it("invalid config → exit 2, problems listed once, nothing left behind", async () => {
    const ok = runDaemon(h.paths.home, await freePort()); // creates the home
    await ready(ok);
    await (await connectDaemon(h.paths)).request("POST", "/api/v1/shutdown");
    await ok.exit;
    await writeFile(h.paths.config, JSON.stringify({ schemaVersion: 1, mode: "nope" }));
    const bad = runDaemon(h.paths.home, await freePort());
    expect(await bad.exit).toBe(2);
    const text = bad.err.join("");
    expect(text.match(/mode/g)?.length).toBe(1);
    expect(existsSync(h.paths.auth)).toBe(false);
    expect(existsSync(h.paths.lock)).toBe(false);
  });

  it("in-process: abort signal and API shutdown both stop cleanly (stopped resolves)", async () => {
    const env = { ...process.env, WEBHUB_HOME: h.paths.home };
    const ac = new AbortController();
    const a = await startDaemon({ env, port: await freePort(), signal: ac.signal, log: () => {} });
    expect(existsSync(h.paths.auth)).toBe(true);
    ac.abort();
    await a.stopped;
    expect(existsSync(h.paths.auth)).toBe(false);
    expect(existsSync(h.paths.lock)).toBe(false);

    const pre = new AbortController();
    pre.abort(); // signal before ready → stops right after start
    const b = await startDaemon({ env, port: await freePort(), signal: pre.signal, log: () => {} });
    await b.stopped;
    expect(existsSync(h.paths.auth)).toBe(false);

    const c = await startDaemon({ env, port: await freePort(), log: () => {} });
    await (await connectDaemon(h.paths)).request("POST", "/api/v1/shutdown");
    await c.stopped;
    expect(existsSync(h.paths.auth)).toBe(false);
    expect(existsSync(h.paths.lock)).toBe(false);
  });

  it("an impostor on the port never receives the token", async () => {
    const seen: string[] = [];
    const impostor: Server = createServer((req, res) => {
      seen.push(JSON.stringify(req.headers) + req.url);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ proof: "x", pid: 1 }));
    });
    await new Promise<void>((r) => impostor.listen({ host: "127.0.0.1", port: 0 }, () => r()));
    try {
      const a = impostor.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      const token = "A".repeat(43);
      const c = new DaemonClient({ schemaVersion: 1, token, pid: 1, port, startedAt: "x" });
      await expect(c.request("GET", "/api/v1/status")).rejects.toSatisfy((e) =>
        isServerError(e, "DAEMON_IMPOSTOR"),
      );
      expect(seen).toHaveLength(1);
      expect(seen.join("")).not.toContain(token);
    } finally {
      await new Promise((r) => impostor.close(r));
    }
  });
});
