/**
 * F-003 API behaviour that only shows on real sockets: timeouts (K4/L2), missing Host on
 * HTTP/1.1 (J3), 503 while closing (H4), shutdown when the client disconnects (H10), pipelined
 * garbage (L5) and the client's overall deadline (H13).
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../../src/server/api.js";
import { SessionStore } from "../../src/server/auth.js";
import { sendRaw } from "../../src/server/client.js";

const TOKEN = randomBytes(32).toString("base64url");
const HOST = "hub.localhost"; // an allowed API host whatever the listen port

let app: FastifyInstance;
let port: number;
let shutdowns: number;
let logs: Record<string, unknown>[];

beforeEach(async () => {
  shutdowns = 0;
  logs = [];
  app = await createApi({
    token: TOKEN,
    hosts: { apiPort: 7400, httpPort: 80, domainSuffix: "localhost" },
    sessions: new SessionStore(),
    status: () => ({}),
    onShutdown: () => {
      shutdowns++;
    },
    log: (e) => logs.push(e),
    failDelayMs: 0,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const a = app.server.address();
  port = typeof a === "object" && a !== null ? a.port : 0;
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
    // either the 200 alone, or the 200 first — never a 400 before it
    expect(statuses[0] ?? "200").toBe("200");
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
    await expect(sendRaw(p, "GET", "/", {}, undefined, 400)).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
