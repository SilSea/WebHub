import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApiContext, BODY_LIMIT, createApi } from "../../src/server/api.js";
import {
  apiHosts,
  classifyHost,
  csrfProblem,
  helloProof,
  LOGIN_CODE_TTL_MS,
  normaliseHost,
  parseBearer,
  readCookie,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  SessionStore,
  sessionCookie,
} from "../../src/server/auth.js";
import { DaemonClient } from "../../src/server/client.js";
import { isServerError } from "../../src/server/errors.js";

const TOKEN = randomBytes(32).toString("base64url");
const HOSTS = { apiPort: 7400, httpPort: 80, domainSuffix: "localhost" };
const API = "127.0.0.1:7400";
const bearer = { authorization: `Bearer ${TOKEN}` };

describe("Host allowlist (DNS rebinding)", () => {
  it("accepts exactly the API hosts and webhub.internal", () => {
    expect(apiHosts(HOSTS)).toEqual(["127.0.0.1:7400", "hub.localhost", "db.localhost"]);
    expect(apiHosts({ ...HOSTS, httpPort: 8080 })).toEqual([
      "127.0.0.1:7400",
      "hub.localhost:8080",
      "db.localhost:8080",
    ]);
    expect(classifyHost("127.0.0.1:7400", HOSTS)).toEqual({ kind: "api", host: API });
    expect(classifyHost("HUB.localhost.", HOSTS)).toEqual({ kind: "api", host: "hub.localhost" });
    expect(classifyHost("webhub.internal", HOSTS)?.kind).toBe("internal");
    for (const bad of [
      undefined,
      "",
      "localhost:7400",
      "127.0.0.1",
      "127.0.0.1:7401",
      "127.0.0.1:7400.evil.com",
      "evil.com",
      "hub.localhost:80",
      "hub.localhost.evil.com",
      "[::1]:7400",
      "x.hub.localhost",
      "hub.localhost:8080",
      "hub.localhost@evil.com",
    ]) {
      expect(classifyHost(bad, HOSTS), String(bad)).toBeUndefined();
    }
    expect(normaliseHost(" Hub.LocalHost.:8080 ")).toBe("hub.localhost:8080");
  });
});

describe("pure auth helpers", () => {
  it("parseBearer only takes a well-formed Bearer token", () => {
    expect(parseBearer(`Bearer ${TOKEN}`)).toBe(TOKEN);
    for (const bad of [
      undefined,
      TOKEN,
      `bearer ${TOKEN}`,
      `Bearer  ${TOKEN}`,
      "Bearer a b",
      "Basic x",
    ]) {
      expect(parseBearer(bad)).toBeUndefined();
    }
  });

  it("readCookie refuses duplicates; session cookie is host-only, HttpOnly, Strict", () => {
    expect(readCookie("a=1; webhub_session=x; b=2", "webhub_session")).toBe("x");
    expect(readCookie("webhub_session=x; webhub_session=y", "webhub_session")).toBeUndefined();
    expect(readCookie(undefined, "webhub_session")).toBeUndefined();
    const c = sessionCookie("id");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c.toLowerCase()).not.toContain("domain");
  });

  it("csrfProblem: unsafe methods need same origin; cookie auth needs Origin", () => {
    const h = "hub.localhost";
    expect(csrfProblem("GET", { origin: "http://evil.com" }, h, "session")).toBeUndefined();
    expect(csrfProblem("POST", { origin: "http://hub.localhost" }, h, "session")).toBeUndefined();
    expect(csrfProblem("POST", {}, h, "session")).toBe("missing Origin");
    expect(csrfProblem("POST", {}, h, "bearer")).toBeUndefined(); // CLI
    expect(csrfProblem("POST", { origin: "http://evil.com" }, h, "bearer")).toBeDefined();
    expect(csrfProblem("POST", { origin: "null" }, h, "session")).toBeDefined();
    expect(
      csrfProblem(
        "POST",
        { origin: "http://hub.localhost", "sec-fetch-site": "cross-site" },
        h,
        "session",
      ),
    ).toBeDefined();
    expect(
      csrfProblem(
        "POST",
        { origin: "http://hub.localhost", "sec-fetch-site": "same-site" },
        h,
        "session",
      ),
    ).toBeDefined();
    expect(csrfProblem("UPGRADE", { origin: "http://db.localhost" }, h, "session")).toBeDefined();
  });

  it("login codes: single use, host-bound, expire after 60 s", () => {
    let now = 1_000;
    const s = new SessionStore(() => now);
    const a = s.createCode("hub.localhost");
    expect(s.consumeCode(a.code, "db.localhost")).toBe(false); // wrong host burns it
    expect(s.consumeCode(a.code, "hub.localhost")).toBe(false);
    const b = s.createCode("hub.localhost");
    expect(s.consumeCode(b.code, "hub.localhost")).toBe(true);
    expect(s.consumeCode(b.code, "hub.localhost")).toBe(false); // used
    const c = s.createCode("hub.localhost");
    now += LOGIN_CODE_TTL_MS + 1;
    expect(s.consumeCode(c.code, "hub.localhost")).toBe(false);
    expect(s.consumeCode("not-a-code", "hub.localhost")).toBe(false);
  });

  it("sessions: host-bound, idle and absolute expiry", () => {
    let now = 0;
    const s = new SessionStore(() => now);
    const id = s.createSession("hub.localhost");
    expect(s.checkSession(id, "hub.localhost")).toBe(true);
    expect(s.checkSession(id, "db.localhost")).toBe(false);
    now += SESSION_IDLE_MS - 1;
    expect(s.checkSession(id, "hub.localhost")).toBe(true); // refreshes idle
    for (let t = 0; t < 20; t++) {
      now += SESSION_IDLE_MS / 2;
      if (now > SESSION_MAX_MS) break;
      s.checkSession(id, "hub.localhost");
    }
    now = SESSION_MAX_MS + 1;
    expect(s.checkSession(id, "hub.localhost")).toBe(false);
    const idle = s.createSession("hub.localhost");
    now += SESSION_IDLE_MS + 1;
    expect(s.checkSession(idle, "hub.localhost")).toBe(false);
    expect(s.checkSession(undefined, "hub.localhost")).toBe(false);
  });
});

describe("API server", () => {
  let app: FastifyInstance;
  let logs: Record<string, unknown>[];
  let sessions: SessionStore;
  let shutdowns: number;

  const make = async (
    extra: Partial<ApiContext> = {},
    registrars: Parameters<typeof createApi>[1] = [],
  ) => {
    logs = [];
    sessions = new SessionStore();
    shutdowns = 0;
    app = await createApi(
      {
        token: TOKEN,
        hosts: HOSTS,
        sessions,
        status: () => ({ version: "0.0.0", pid: 1 }),
        onShutdown: () => {
          shutdowns++;
        },
        log: (e) => logs.push(e),
        failDelayMs: 0,
        ...extra,
      },
      registrars,
    );
  };
  beforeEach(() => make());
  afterEach(() => app.close());

  const req = (
    method: string,
    url: string,
    headers: Record<string, string> = {},
    payload?: string,
  ) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { host: API, ...headers },
      ...(payload === undefined ? {} : { payload }),
    });

  /** Logs in through a login link; returns the cookie header for `host`. */
  const login = async (host = "hub.localhost") => {
    const link = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ host }),
    );
    expect(link.statusCode).toBe(200);
    const url = new URL(link.json().url as string);
    const res = await req("GET", `${url.pathname}${url.search}`, { host });
    expect(res.statusCode).toBe(303);
    const set = String(res.headers["set-cookie"]);
    return set.split(";")[0] ?? "";
  };

  it("unknown / missing / duplicate Host → 421 before auth, no data", async () => {
    for (const host of ["evil.com", "localhost:7400", "127.0.0.1:7400.evil.com"]) {
      const res = await req("GET", "/api/v1/status", { ...bearer, host });
      expect(res.statusCode, host).toBe(421);
      expect(res.json()).toEqual({ error: { code: "MISDIRECTED", message: "unknown host" } });
    }
    const dup = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: [API, "evil.com"] as unknown as string },
    });
    expect(dup.statusCode).toBe(421);
  });

  it("health is public; status needs auth; wrong token → 401", async () => {
    expect((await req("GET", "/api/v1/health")).json()).toEqual({ ok: true });
    expect((await req("GET", "/api/v1/status")).statusCode).toBe(401);
    expect((await req("GET", "/api/v1/status", { authorization: "Bearer wrong" })).statusCode).toBe(
      401,
    );
    expect((await req("GET", "/api/v1/status", { authorization: TOKEN })).statusCode).toBe(401);
    const ok = await req("GET", "/api/v1/status", bearer);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ version: "0.0.0", pid: 1 });
  });

  it("no CORS: OPTIONS → 405, no Access-Control-* headers anywhere; security headers set", async () => {
    const pre = await req("OPTIONS", "/api/v1/status", {
      origin: "http://evil.com",
      "access-control-request-method": "POST",
    });
    expect(pre.statusCode).toBe(405);
    for (const res of [pre, await req("GET", "/api/v1/health", { origin: "http://evil.com" })]) {
      expect(Object.keys(res.headers).filter((k) => k.startsWith("access-control"))).toEqual([]);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("hello proves the token without revealing it", async () => {
    const n = randomBytes(32).toString("base64url");
    const res = await req("GET", `/api/v1/hello?n=${n}`);
    expect(res.json().proof).toBe(helloProof(TOKEN, n));
    expect(res.body).not.toContain(TOKEN);
    expect((await req("GET", "/api/v1/hello?n=short")).statusCode).toBe(400);
  });

  it("login link → cookie for that host only; code single use; wrong host refused", async () => {
    const cookie = await login("hub.localhost");
    expect(cookie.startsWith("webhub_session=")).toBe(true);
    expect((await req("GET", "/api/v1/status", { host: "hub.localhost", cookie })).statusCode).toBe(
      200,
    );
    expect((await req("GET", "/api/v1/status", { host: "db.localhost", cookie })).statusCode).toBe(
      401,
    );

    const link = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ host: "db.localhost" }),
    );
    const url = new URL(link.json().url as string);
    const path = `${url.pathname}${url.search}`;
    expect((await req("GET", path, { host: "hub.localhost" })).statusCode).toBe(401); // other host burns it
    expect((await req("GET", path, { host: "db.localhost" })).statusCode).toBe(401);
    const bad = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ host: "evil.com" }),
    );
    expect(bad.statusCode).toBe(400);
    // a session cannot create login links (bearer only)
    const viaCookie = await req(
      "POST",
      "/api/v1/login-links",
      {
        host: "hub.localhost",
        cookie,
        origin: "http://hub.localhost",
        "content-type": "application/json",
      },
      "{}",
    );
    expect(viaCookie.statusCode).toBe(401);
  });

  it("login response does not leak the code (no-store, no-referrer)", async () => {
    const link = await req("POST", "/api/v1/login-links", bearer);
    expect(link.statusCode).toBe(200);
    const url = new URL(link.json().url as string);
    expect(url.host).toBe(API); // default = host the request came in on
    const res = await req("GET", `${url.pathname}${url.search}`);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers.location).toBe("/");
  });

  it("CSRF: cookie POST needs Origin; cross-site and text/plain refused", async () => {
    const cookie = await login();
    const base = { host: "hub.localhost", cookie };
    expect((await req("POST", "/api/v1/logout", base)).statusCode).toBe(403);
    expect(
      (await req("POST", "/api/v1/logout", { ...base, origin: "http://evil.com" })).statusCode,
    ).toBe(403);
    expect(
      (
        await req("POST", "/api/v1/logout", {
          ...base,
          origin: "http://hub.localhost",
          "sec-fetch-site": "cross-site",
        })
      ).statusCode,
    ).toBe(403);
    const plain = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "text/plain" },
      "{}",
    );
    expect(plain.statusCode).toBe(415);
    const form = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/x-www-form-urlencoded" },
      "a=1",
    );
    expect(form.statusCode).toBe(415);
    const out = await req("POST", "/api/v1/logout", { ...base, origin: "http://hub.localhost" });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await req("GET", "/api/v1/status", base)).statusCode).toBe(401);
  });

  it("webhub.internal: only /_auth and /_webhub/login; forwarded host must be allowed", async () => {
    const internal = { host: "webhub.internal" };
    expect((await req("GET", "/api/v1/status", { ...internal, ...bearer })).statusCode).toBe(404);
    expect((await req("GET", "/api/v1/health", internal)).statusCode).toBe(404);
    expect((await req("GET", "/_auth", { host: "hub.localhost" })).statusCode).toBe(404);
    const cookie = await login("db.localhost");
    expect(
      (await req("GET", "/_auth", { ...internal, cookie, "x-forwarded-host": "db.localhost" }))
        .statusCode,
    ).toBe(204);
    expect(
      (await req("GET", "/_auth", { ...internal, cookie, "x-forwarded-host": "hub.localhost" }))
        .statusCode,
    ).toBe(401);
    expect(
      (await req("GET", "/_auth", { ...internal, cookie, "x-forwarded-host": "evil.com" }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await req("GET", "/_auth", {
          ...internal,
          cookie,
          "x-forwarded-host": "db.localhost, evil.com",
        })
      ).statusCode,
    ).toBe(401);
    // login through nginx (internal Host + forwarded host)
    const link = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ host: "hub.localhost" }),
    );
    const url = new URL(link.json().url as string);
    const res = await req("GET", `${url.pathname}${url.search}`, {
      ...internal,
      "x-forwarded-host": "hub.localhost",
    });
    expect(res.statusCode).toBe(303);
  });

  it("shutdown: bearer only, 202 then callback once", async () => {
    const cookie = await login();
    expect(
      (
        await req("POST", "/api/v1/shutdown", {
          host: "hub.localhost",
          cookie,
          origin: "http://hub.localhost",
        })
      ).statusCode,
    ).toBe(401);
    const res = await req("POST", "/api/v1/shutdown", bearer);
    expect(res.statusCode).toBe(202);
    expect(shutdowns).toBe(1);
  });

  it("body over the limit → 413; errors have no stack / internals", async () => {
    const big = JSON.stringify({ host: "x".repeat(BODY_LIMIT) });
    const res = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/json" },
      big,
    );
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: { code: "BODY_TOO_LARGE", message: "request body too large" },
    });
    const broken = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/json" },
      "{bad",
    );
    expect(broken.statusCode).toBe(400);
    expect(broken.body).not.toMatch(/at |\\|\/src\//);
    expect((await req("GET", "/nope", bearer)).json()).toEqual({
      error: { code: "NOT_FOUND", message: "not found" },
    });
  });

  it("routes of later features are authenticated by default (registrar)", async () => {
    await app.close();
    await make({}, [
      (a) => {
        a.get("/api/v1/x/secret", async () => ({ secret: true }));
        a.get("/api/v1/x/open", { config: { access: "public" } }, async () => ({ open: true }));
        a.get("/api/v1/x/boom", async () => {
          throw new Error(`C:\\internal\\path ${TOKEN}`);
        });
      },
    ]);
    expect((await req("GET", "/api/v1/x/secret")).statusCode).toBe(401);
    expect((await req("GET", "/api/v1/x/secret", bearer)).statusCode).toBe(200);
    expect((await req("GET", "/api/v1/x/open")).statusCode).toBe(200);
    const boom = await req("GET", "/api/v1/x/boom", bearer);
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: { code: "INTERNAL", message: "internal error" } });
    expect(boom.body).not.toContain("path");
    expect(boom.body).not.toContain(TOKEN);
  });

  it("log lines never contain token, code, cookie or query string", async () => {
    const cookie = await login();
    await req("GET", `/api/v1/hello?n=${randomBytes(32).toString("base64url")}`);
    await req("GET", "/api/v1/status", { host: "hub.localhost", cookie });
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(3);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("?");
    expect(text).not.toContain(cookie.split("=")[1] ?? "x");
    expect(text).not.toMatch(/authorization|cookie/i);
  });
});

describe("client handshake", () => {
  const auth = { schemaVersion: 1 as const, token: TOKEN, pid: 1, port: 7400, startedAt: "x" };

  it("never sends the token to a server that cannot prove it knows it", async () => {
    const seen: Record<string, string>[] = [];
    const impostor = async (
      _p: number,
      _m: string,
      _path: string,
      headers: Record<string, string>,
    ) => {
      seen.push(headers);
      return { status: 200, body: { proof: "forged", pid: 9 } };
    };
    const c = new DaemonClient(auth, impostor);
    await expect(c.request("GET", "/api/v1/status")).rejects.toSatisfy((e) =>
      isServerError(e, "DAEMON_IMPOSTOR"),
    );
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it("real proof → token sent; API errors mapped", async () => {
    const calls: { path: string; headers: Record<string, string> }[] = [];
    const real = async (_p: number, _m: string, path: string, headers: Record<string, string>) => {
      calls.push({ path, headers });
      if (path.startsWith("/api/v1/hello")) {
        const n = new URL(path, "http://x").searchParams.get("n") ?? "";
        return { status: 200, body: { proof: helloProof(TOKEN, n), pid: 1 } };
      }
      if (path === "/api/v1/fail")
        return { status: 400, body: { error: { code: "BAD_REQUEST", message: "nope" } } };
      return { status: 200, body: { ok: true } };
    };
    const c = new DaemonClient(auth, real);
    expect(await c.request("GET", "/api/v1/status")).toEqual({ ok: true });
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    await expect(c.request("GET", "/api/v1/fail")).rejects.toSatisfy(
      (e) => isServerError(e, "API_ERROR") && e.apiCode === "BAD_REQUEST" && e.status === 400,
    );
    const refused = new DaemonClient(auth, async () => {
      throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
    });
    await expect(refused.verify()).rejects.toSatisfy((e) => isServerError(e, "DAEMON_NOT_RUNNING"));
  });
});
