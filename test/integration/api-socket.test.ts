/**
 * F-003 API behaviour that only shows on real sockets: timeouts (K4/L2), missing Host on
 * HTTP/1.1 (J3), 503 while closing (H4), shutdown when the client disconnects (H10), pipelined
 * garbage (L5) and the client's overall deadline (H13).
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../../src/server/api.js";
import { helloProof, SessionStore } from "../../src/server/auth.js";
import { DaemonClient, sendRaw } from "../../src/server/client.js";
import { isServerError } from "../../src/server/errors.js";

const TOKEN = randomBytes(32).toString("base64url");
const HOST = "hub.localhost"; // an allowed API host whatever the listen port

let app: FastifyInstance;
let port: number;
let shutdowns: number;
let logs: Record<string, unknown>[];
let counted: number;

beforeEach(async () => {
  shutdowns = 0;
  counted = 0;
  logs = [];
  const hosts = { apiPort: 0, httpPort: 80, domainSuffix: "localhost" };
  app = await createApi(
    {
      token: TOKEN,
      hosts,
      sessions: new SessionStore(),
      status: () => ({}),
      onShutdown: () => {
        shutdowns++;
      },
      log: (e) => logs.push(e),
      failDelayMs: 0,
    },
    [
      // a slow public route, like later features may have (security-4 Q3)
      (a) =>
        a.get("/api/v1/x/slow", { config: { access: "public" } }, async (req) => {
          const ms = Number((req.query as { ms?: string }).ms ?? 400);
          await new Promise((r) => setTimeout(r, ms));
          return { ms };
        }),
      (a) =>
        a.get("/api/v1/x/count", { config: { access: "public" } }, async () => {
          counted++;
          await new Promise((r) => setTimeout(r, 50));
          return { counted };
        }),
      // a large answer a client may refuse to read (security-6 U1/U3)
      (a) =>
        a.get("/api/v1/x/big", { config: { access: "public" } }, async () => ({
          big: "x".repeat(4 * 1024 * 1024),
        })),
    ],
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const a = app.server.address();
  port = typeof a === "object" && a !== null ? a.port : 0;
  hosts.apiPort = port; // the allowlist reads ctx.hosts live: accept 127.0.0.1:<port>
});
afterEach(async () => {
  app.server.closeAllConnections();
  await app.close();
});

function open(): Promise<{ s: Socket; text: () => string; ended: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const s = connect({ host: "127.0.0.1", port }, () => resolve({ s, text: () => out, ended }));
    let out = "";
    s.on("data", (b) => {
      out += b.toString();
    });
    const ended = new Promise<number>((r) => s.on("close", () => r(performance.now() - t0)));
    s.on("error", () => {});
    s.once("error", reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("API on real sockets", { timeout: 30_000 }, () => {
  it("slow headers are cut after ~10 s, not 30 s (K4 / L2)", async () => {
    const c = await open();
    c.s.write(`GET /api/v1/health HTTP/1.1\r\nHost: ${HOST}\r\n`); // never finished
    const ms = await c.ended;
    expect(ms).toBeGreaterThan(9_000);
    expect(ms).toBeLessThan(12_500);
    expect(c.text()).toMatch(/^HTTP\/1\.1 408 /);
    expect(c.text()).toContain("x-content-type-options: nosniff");
  });

  it("HTTP/1.1 without Host → 421 with security headers (J3)", async () => {
    const c = await open();
    c.s.write("GET /api/v1/health HTTP/1.1\r\nConnection: close\r\n\r\n");
    await c.ended;
    expect(c.text()).toMatch(/^HTTP\/1\.1 421 /);
    expect(c.text()).toContain("x-content-type-options: nosniff");
    expect(c.text()).toContain('"MISDIRECTED"');
  });

  it("a request completed while closing → 503 SHUTTING_DOWN (H4)", async () => {
    const c = await open();
    c.s.write(`GET /api/v1/health HTTP/1.1\r\nHost: ${HOST}\r\n`);
    await wait(100);
    const closing = app.close();
    await wait(100);
    c.s.write("Connection: close\r\n\r\n");
    await c.ended;
    await closing;
    expect(c.text()).toMatch(/^HTTP\/1\.1 503 /);
    expect(c.text()).toContain('"SHUTTING_DOWN"');
  });

  it("shutdown still fires when the client disconnects right after sending (H10)", async () => {
    const c = await open();
    c.s.end(
      `POST /api/v1/shutdown HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`,
    );
    c.s.destroy();
    const deadline = Date.now() + 3_000;
    while (shutdowns === 0 && Date.now() < deadline) await wait(20);
    expect(shutdowns).toBe(1);
  });

  it("garbage pipelined after a valid request never answers out of order (L5)", async () => {
    const c = await open();
    c.s.write(`GET /api/v1/health HTTP/1.1\r\nHost: ${HOST}\r\n\r\n\x00garbage\r\n\r\n`);
    await c.ended;
    const statuses = [...c.text().matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => m[1]);
    expect(statuses).toEqual(["200", "400"]); // the valid request first, then exactly one 400
  });

  it("garbage in many chunks behind a slow response: one 400, no listener pile-up (Q3)", async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on("warning", onWarning);
    try {
      const c = await open();
      c.s.write(`GET /api/v1/x/slow HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`);
      await wait(20);
      for (let i = 0; i < 60; i++) {
        c.s.write("\x00");
        await wait(2);
      }
      const t0 = performance.now();
      await c.ended;
      const statuses = [...c.text().matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => m[1]);
      expect(statuses).toEqual(["200", "400"]);
      expect(performance.now() - t0).toBeLessThan(2_000);
      await wait(50);
      expect(warnings).not.toContain("MaxListenersExceededWarning");
    } finally {
      process.off("warning", onWarning);
    }
  });

  const count = () =>
    new Promise<number>((r, j) => app.server.getConnections((e, n) => (e ? j(e) : r(n))));
  async function connectionsDrop(ms: number): Promise<number> {
    const deadline = Date.now() + ms;
    while ((await count()) > 0 && Date.now() < deadline) await wait(20);
    return count();
  }

  it("pipelining is refused: socket destroyed, the second request never runs (U1)", async () => {
    const c = await open();
    const get = `GET /api/v1/x/count HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`;
    c.s.write(`${get}${get}${get}`);
    await c.ended;
    await wait(100);
    expect(counted).toBeLessThanOrEqual(1);
    expect(await connectionsDrop(1_000)).toBe(0);
  });

  it("a flood of tiny pipelined requests that are never read: sockets cut, nothing piles up (U1)", async () => {
    const tiny = "GET / HTTP/1.1\r\nHost:x\r\n\r\n".repeat(2_000);
    const clients = await Promise.all(Array.from({ length: 20 }, () => open()));
    for (const c of clients) {
      c.s.pause(); // never reads
      c.s.write(tiny);
    }
    await Promise.all(clients.map((c) => c.ended));
    expect(await connectionsDrop(2_000)).toBe(0);
    expect(logs.length).toBeLessThan(200); // at most one handled request per socket
    // the API still answers
    const ok = await open();
    ok.s.write(`GET /api/v1/health HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
    await ok.ended;
    expect(ok.text()).toMatch(/^HTTP\/1\.1 200 /);
  });

  it("request + garbage: 200, 400, and the server socket is closed, never leaked (R1 / S1)", async () => {
    const clients = await Promise.all([1, 2, 3, 4, 5].map(() => open()));
    for (const c of clients) {
      c.s.write(`GET /api/v1/health HTTP/1.1\r\nHost: ${HOST}\r\n\r\n\x00garbage\r\n\r\n`);
    }
    await Promise.all(clients.map((c) => c.ended)); // the server closes, the client did not
    for (const c of clients) {
      const statuses = [...c.text().matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => m[1]);
      expect(statuses).toEqual(["200", "400"]);
    }
    expect(await connectionsDrop(1_000)).toBe(0);
    const t0 = performance.now();
    await app.close();
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("garbage behind a long-running response, client gone: socket freed within the bound (U2)", async () => {
    const clients = await Promise.all([1, 2, 3].map(() => open()));
    for (const c of clients) {
      c.s.end(`GET /api/v1/x/slow?ms=12000 HTTP/1.1\r\nHost: ${HOST}\r\n\r\n\x00garbage\r\n\r\n`);
    }
    await wait(200);
    expect(await count()).toBe(3);
    expect(await connectionsDrop(7_000)).toBe(0);
  });

  it("a client still sending a huge header gets its 431, not a reset (T2)", async () => {
    for (let i = 0; i < 3; i++) {
      const c = await open();
      c.s.write(
        `GET /api/v1/health HTTP/1.1\r\nHost: ${HOST}\r\nX-Big: ${"a".repeat(2 * 1024 * 1024)}\r\n\r\n`,
      );
      await c.ended;
      expect(c.text()).toMatch(/^HTTP\/1\.1 431 /);
    }
    expect(await connectionsDrop(2_500)).toBe(0);
  });

  it("a client that never reads a large answer is cut after the idle timeout (U1 / U3)", {
    timeout: 30_000,
  }, async () => {
    const c = await open();
    c.s.pause();
    c.s.write(`GET /api/v1/x/big HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`);
    const t0 = Date.now();
    await wait(200);
    expect(await count()).toBe(1);
    expect(await connectionsDrop(22_000)).toBe(0); // idle (15 s) or keep-alive after a flush
    expect(Date.now() - t0).toBeGreaterThan(4_000);
    c.s.destroy();
  });

  it("a bad body of the request itself still gets a uniform 400 (M1)", async () => {
    const c = await open();
    c.s.write(
      `POST /api/v1/login-links HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n`,
    );
    await c.ended;
    expect(c.text()).toMatch(/^HTTP\/1\.1 400 /);
    expect(c.text()).toContain("x-content-type-options: nosniff");
  });

  it("a body that never completes gets 408 by the request timeout (M1)", {
    timeout: 45_000,
  }, async () => {
    const c = await open();
    c.s.write(
      `POST /api/v1/login-links HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{"a`,
    );
    const ms = await c.ended;
    expect(c.text()).toMatch(/^HTTP\/1\.1 408 /);
    expect(ms).toBeLessThan(33_000);
  });
});

describe("client: the token only travels on a proven connection (N2)", () => {
  let fake: Server;
  afterEach(async () => {
    fake.closeAllConnections();
    await new Promise((r) => fake.close(r));
  });

  it("proof answered, then the connection is closed → request fails, token never sent", async () => {
    const seen: string[] = [];
    fake = createServer((req, res) => {
      seen.push(`${req.url} ${req.headers.authorization ?? "-"}`);
      const n = new URL(req.url ?? "/", "http://x").searchParams.get("n") ?? "";
      // a real proof (e.g. the daemon answering just before it exits), then the socket closes —
      // whatever answers the next connection must not get the token
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ proof: helloProof(TOKEN, n) }));
    });
    await new Promise<void>((r) => fake.listen({ host: "127.0.0.1", port: 0 }, () => r()));
    const a = fake.address();
    const p = typeof a === "object" && a !== null ? a.port : 0;
    const client = new DaemonClient({
      schemaVersion: 1,
      token: TOKEN,
      pid: 1,
      port: p,
      startedAt: "x",
    });
    await expect(client.request("GET", "/api/v1/status")).rejects.toSatisfy((e) =>
      isServerError(e, "DAEMON_UNREACHABLE"),
    );
    expect(seen).toHaveLength(1);
    expect(seen.join("")).not.toContain(TOKEN);
  });

  it("against the real API: proof + request share one connection", async () => {
    fake = createServer(); // nothing to fake here (afterEach closes it)
    await new Promise<void>((r) => fake.listen({ host: "127.0.0.1", port: 0 }, () => r()));
    const sockets = new Set<unknown>();
    app.server.on("connection", (s) => sockets.add(s));
    const client = new DaemonClient({
      schemaVersion: 1,
      token: TOKEN,
      pid: 1,
      port,
      startedAt: "x",
    });
    expect(await client.request("GET", "/api/v1/status")).toEqual({});
    expect(sockets.size).toBe(1);
    await client.request("GET", "/api/v1/status");
    expect(sockets.size).toBe(2); // next request: new connection, new proof
  });
});

describe("client vs a 101 answer (Q2)", () => {
  it("an impostor answering 101 makes the call fail, never hang", async () => {
    const srv = createNetServer((s) => {
      s.once("data", () =>
        s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n"),
      );
      s.on("error", () => {});
    });
    await new Promise<void>((r) => srv.listen({ host: "127.0.0.1", port: 0 }, () => r()));
    try {
      const a = srv.address();
      const p = typeof a === "object" && a !== null ? a.port : 0;
      const c = new DaemonClient({
        schemaVersion: 1,
        token: TOKEN,
        pid: 1,
        port: p,
        startedAt: "x",
      });
      const t0 = performance.now();
      await expect(c.verify()).rejects.toSatisfy(
        (e) => isServerError(e, "DAEMON_UNREACHABLE") && e.details.join() === "EUPGRADE",
      );
      expect(performance.now() - t0).toBeLessThan(3_000);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("client deadline", () => {
  let drip: Server;
  afterEach(async () => {
    drip.closeAllConnections();
    await new Promise((r) => drip.close(r));
  });

  it("a server that drips its answer is cut by the overall deadline (H13)", async () => {
    drip = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write(" "), 50); // keeps the socket busy, never ends
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => drip.listen({ host: "127.0.0.1", port: 0 }, () => r()));
    const a = drip.address();
    const p = typeof a === "object" && a !== null ? a.port : 0;
    const t0 = performance.now();
    await expect(sendRaw(p, "GET", "/", {}, undefined, { timeoutMs: 400 })).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
