import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApiContext, BODY_LIMIT, createApi } from "../../src/server/api.js";
import {
  apiHosts,
  checkUpgrade,
  classifyHost,
  csrfProblem,
  helloProof,
  keyFromSubprotocols,
  LOGIN_CODE_TTL_MS,
  normaliseHost,
  parseBearer,
  proxySecretFor,
  readCookies,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  SessionStore,
  sessionCookie,
} from "../../src/server/auth.js";
import { DaemonClient, type SendFn } from "../../src/server/client.js";
import { isServerError } from "../../src/server/errors.js";

const TOKEN = randomBytes(32).toString("base64url");
const HOSTS = { apiPort: 7400, httpPort: 80, domainSuffix: "localhost" };
const API = "127.0.0.1:7400";
const bearer = { authorization: `Bearer ${TOKEN}` };
/** What webhub's nginx adds to every forwarded request (security-3 N1). */
const via = { "x-webhub-proxy": proxySecretFor(TOKEN) };

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

  it("readCookies returns every value (≤ 8); session cookie is a host-only browser-session cookie", () => {
    expect(readCookies("a=1; webhub_session=x; b=2", "webhub_session")).toEqual(["x"]);
    expect(readCookies("webhub_session=x; webhub_session=y", "webhub_session")).toEqual(["x", "y"]);
    expect(readCookies(undefined, "webhub_session")).toEqual([]);
    const nine = Array.from({ length: 9 }, (_, i) => `webhub_session=v${i}`).join("; ");
    expect(readCookies(nine, "webhub_session")).toEqual(
      Array.from({ length: 8 }, (_, i) => `v${i}`),
    );
    const c = sessionCookie("id");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c.toLowerCase()).not.toContain("domain");
    expect(c).not.toContain("Max-Age"); // gone with the browser (L1)
  });

  it("keyFromSubprotocols takes exactly one webhub-key.<key> next to webhub.v1", () => {
    const k = "K".repeat(43);
    expect(keyFromSubprotocols(`webhub.v1, webhub-key.${k}`)).toBe(k);
    expect(keyFromSubprotocols(`webhub-key.${k}`)).toBeUndefined(); // nothing safe to echo (M8)
    expect(keyFromSubprotocols("webhub.v1")).toBeUndefined();
    expect(keyFromSubprotocols(`webhub.v1, webhub-key.${k}, webhub-key.x`)).toBeUndefined();
    expect(keyFromSubprotocols(undefined)).toBeUndefined();
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

  it("sessions: id + key + host bound, idle and absolute expiry", () => {
    let now = 0;
    const s = new SessionStore(() => now);
    const { id, key } = s.createSession("hub.localhost");
    const other = s.createSession("hub.localhost");
    expect(s.findSession([id], key, "hub.localhost")).toBe(id);
    expect(s.findSession([id], key, "db.localhost")).toBeUndefined();
    expect(s.findSession([id], other.key, "hub.localhost")).toBeUndefined(); // key of another session
    expect(s.findSession([other.id, id], key, "hub.localhost")).toBe(id); // tossed cookie first
    expect(s.findSession([id], "short", "hub.localhost")).toBeUndefined();
    now += SESSION_IDLE_MS - 1;
    expect(s.findSession([id], key, "hub.localhost")).toBe(id); // refreshes idle
    for (let t = 0; t < 40; t++) {
      now += SESSION_IDLE_MS / 2;
      if (now > SESSION_MAX_MS) break;
      s.findSession([id], key, "hub.localhost");
    }
    now = SESSION_MAX_MS + 1;
    expect(s.findSession([id], key, "hub.localhost")).toBeUndefined();
    const idle = s.createSession("hub.localhost");
    now += SESSION_IDLE_MS + 1;
    expect(s.findSession([idle.id], idle.key, "hub.localhost")).toBeUndefined();
    expect(s.findSession([], key, "hub.localhost")).toBeUndefined();
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
        browserLogin: true,
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

  /**
   * Logs in through a login link. `cookie` = Cookie header, `key` = the fragment secret,
   * `as` = the headers the dashboard sends (host + cookie + key).
   */
  const login = async (host = "hub.localhost") => {
    const link = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ host }),
    );
    expect(link.statusCode).toBe(200);
    const url = new URL(link.json().url as string);
    const res = await req("GET", `${url.pathname}${url.search}`, { host, ...via });
    expect(res.statusCode).toBe(303);
    const cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
    const key = /^\/#k=([A-Za-z0-9_-]{43})$/.exec(String(res.headers.location))?.[1] ?? "";
    expect(key).not.toBe("");
    return { cookie, key, as: { host, cookie, "x-webhub-session": key } };
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
    expect(res.json()).toEqual({ proof: helloProof(TOKEN, n) }); // no pid (K7)
    expect(res.body).not.toContain(TOKEN);
    expect((await req("GET", "/api/v1/hello?n=short")).statusCode).toBe(400);
  });

  it("login link → session for that host only; code single use; wrong host refused", async () => {
    const { cookie, as } = await login("hub.localhost");
    expect(cookie.startsWith("webhub_session=")).toBe(true);
    expect((await req("GET", "/api/v1/status", as)).statusCode).toBe(200);
    expect((await req("GET", "/api/v1/status", { ...as, host: "db.localhost" })).statusCode).toBe(
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
    expect((await req("GET", path, { host: "hub.localhost", ...via })).statusCode).toBe(401); // other host burns it
    expect((await req("GET", path, { host: "db.localhost", ...via })).statusCode).toBe(401);
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
      { ...as, origin: "http://hub.localhost", "content-type": "application/json" },
      "{}",
    );
    expect(viaCookie.statusCode).toBe(401);
  });

  it("a stolen cookie alone is useless: the key header is required (L1)", async () => {
    const a = await login("hub.localhost");
    const b = await login("hub.localhost");
    // what a program on hub.localhost:<other port> can capture: the cookie, never the key
    expect(
      (await req("GET", "/api/v1/status", { host: "hub.localhost", cookie: a.cookie })).statusCode,
    ).toBe(401);
    expect(
      (await req("GET", "/api/v1/status", { ...a.as, "x-webhub-session": b.key })).statusCode,
    ).toBe(401);
    expect(
      (await req("GET", "/api/v1/status", { ...a.as, "x-webhub-session": "x" })).statusCode,
    ).toBe(401);
    // tossed values never become a session (no fixation): a few next to the real one are skipped
    const junk = (n: number) =>
      Array.from({ length: n }, () => `webhub_session=${randomBytes(32).toString("base64url")}`);
    const tossed = { ...a.as, cookie: [...junk(7), a.cookie].join("; ") };
    expect((await req("GET", "/api/v1/status", tossed)).statusCode).toBe(200);
    // ... nor is another valid session's cookie usable with this key
    const mixed = { ...a.as, cookie: `${b.cookie}; ${a.cookie}` };
    expect((await req("GET", "/api/v1/status", mixed)).statusCode).toBe(200);
    // accepted residual (N3 / M2): pushing the real value past 8 (or overwriting it) = logout
    const flood = { ...a.as, cookie: [...junk(8), a.cookie].join("; ") };
    expect((await req("GET", "/api/v1/status", flood)).statusCode).toBe(401);
  });

  it("login only through webhub's nginx; no links before nginx exists (N1)", async () => {
    const link = await req("POST", "/api/v1/login-links", bearer);
    const url = new URL(link.json().url as string);
    const path = `${url.pathname}${url.search}`;
    // a squatter on the http port got the link and redeems it directly: refused, code kept
    for (const h of [
      {},
      { "x-webhub-proxy": "x" },
      { "x-webhub-proxy": proxySecretFor("other") },
    ]) {
      const r = await req("GET", path, { host: "hub.localhost", ...h });
      expect(r.statusCode).toBe(401);
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
    const internal = await req("GET", path, {
      host: "webhub.internal",
      "x-forwarded-host": "hub.localhost",
    });
    expect(internal.statusCode).toBe(401);
    expect((await req("GET", path, { host: "hub.localhost", ...via })).statusCode).toBe(303);
    // browser login off (default until F-009) → no links at all
    await app.close();
    await make({ browserLogin: false });
    const off = await req("POST", "/api/v1/login-links", bearer);
    expect(off.statusCode).toBe(503);
    expect(off.json().error.code).toBe("LOGIN_UNAVAILABLE");
  });

  it("HEAD on a login link is not a login and does not burn the code (J4)", async () => {
    const link = await req("POST", "/api/v1/login-links", bearer);
    const url = new URL(link.json().url as string);
    const head = await req("HEAD", `${url.pathname}${url.search}`, {
      host: "hub.localhost",
      ...via,
    });
    expect([404, 405]).toContain(head.statusCode);
    expect(head.headers["set-cookie"]).toBeUndefined();
    const get = await req("GET", `${url.pathname}${url.search}`, { host: "hub.localhost", ...via });
    expect(get.statusCode).toBe(303);
  });

  it("login-links: empty JSON body ok; prototype poisoning refused", async () => {
    const empty = await req("POST", "/api/v1/login-links", {
      ...bearer,
      "content-type": "application/json",
    });
    expect(empty.statusCode).toBe(200);
    for (const body of ['{"__proto__":{"host":"evil.com"}}', '{"constructor":{"prototype":{}}}']) {
      const res = await req(
        "POST",
        "/api/v1/login-links",
        { ...bearer, "content-type": "application/json" },
        body,
      );
      expect(res.statusCode, body).toBe(400);
    }
  });

  it("login response: real Set-Cookie flags, key in the fragment; nothing leaks", async () => {
    const link = await req("POST", "/api/v1/login-links", bearer);
    expect(link.statusCode).toBe(200);
    const url = new URL(link.json().url as string);
    expect(url.host).toBe("hub.localhost"); // default = dashboard host, never the IP host (K1)
    const res = await req("GET", `${url.pathname}${url.search}`, { host: "hub.localhost", ...via });
    expect(res.statusCode).toBe(303);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers.location).toMatch(/^\/#k=[A-Za-z0-9_-]{43}$/);
    const set = String(res.headers["set-cookie"]);
    expect(set).toMatch(/^webhub_session=[A-Za-z0-9_-]{43}; /);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    expect(set.toLowerCase()).not.toContain("domain");
    expect(set).not.toContain("Max-Age");
    // cookie id and key are different secrets
    expect(set).not.toContain(String(res.headers.location).slice(4));
  });

  it("no browser session on the IP host: cookies are not port-scoped (K1)", async () => {
    const forIp = await req(
      "POST",
      "/api/v1/login-links",
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ host: API }),
    );
    expect(forIp.statusCode).toBe(400);
    // a valid code for hub cannot be redeemed on the IP host
    const link = await req("POST", "/api/v1/login-links", bearer);
    const url = new URL(link.json().url as string);
    const onIp = await req("GET", `${url.pathname}${url.search}`, { host: API, ...via });
    expect(onIp.statusCode).toBe(401);
    expect(onIp.headers["set-cookie"]).toBeUndefined();
    // a hub session replayed with the IP Host is useless, even with its key
    const { as } = await login("hub.localhost");
    expect((await req("GET", "/api/v1/status", { ...as, host: API })).statusCode).toBe(401);
  });

  it("HEAD keeps auth; bad URL → uniform 400 / 421 with headers; OPTIONS has Allow", async () => {
    expect((await req("HEAD", "/api/v1/status")).statusCode).toBe(401);
    expect((await req("HEAD", "/api/v1/status", bearer)).statusCode).toBe(200);
    const badGood = await req("GET", "/%E0%A4%A", bearer);
    expect(badGood.statusCode).toBe(400);
    expect(badGood.json()).toEqual({ error: { code: "BAD_REQUEST", message: "bad request" } });
    expect(badGood.headers["x-content-type-options"]).toBe("nosniff");
    const badEvil = await req("GET", "/%E0%A4%A", { host: "evil.com" });
    expect(badEvil.statusCode).toBe(421);
    expect(badEvil.body).not.toContain("E0");
    // logged, without the target (J5)
    expect(logs.filter((l) => l.path === "(invalid target)")).toEqual([
      { method: "GET", path: "(invalid target)", status: 400 },
      { method: "GET", path: "(invalid target)", status: 421 },
    ]);
    expect(JSON.stringify(logs)).not.toContain("E0");
    expect((await req("OPTIONS", "/api/v1/status")).headers.allow).toBe("GET, HEAD, POST");
  });

  it("no CORS / security headers on every kind of response", async () => {
    const { as } = await login();
    const responses = [
      await req("GET", "/api/v1/health"),
      await req("GET", "/api/v1/status"),
      await req("GET", "/api/v1/status", { host: "evil.com" }),
      await req("GET", "/nope", bearer),
      await req("POST", "/api/v1/logout", as),
      await req("POST", "/api/v1/login-links", { ...bearer, "content-type": "text/plain" }, "x"),
      await req("GET", "/_webhub/login?t=x", { host: "hub.localhost" }),
      await req("GET", "/api/v1/hello?n=x"),
    ];
    for (const res of responses) {
      expect(Object.keys(res.headers).filter((k) => k.startsWith("access-control"))).toEqual([]);
      expect(res.headers["x-content-type-options"], String(res.statusCode)).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("server limits against slowloris / socket exhaustion (K4; real timing: integration)", () => {
    expect(app.server.headersTimeout).toBe(10_000);
    expect(app.server.maxConnections).toBe(64);
    expect(app.server.requestTimeout).toBe(30_000);
  });

  it("logout accepts a JSON content type with an empty body", async () => {
    const { as } = await login();
    const res = await req("POST", "/api/v1/logout", {
      ...as,
      origin: "http://hub.localhost",
      "content-type": "application/json",
    });
    expect(res.statusCode).toBe(204);
  });

  it("CSRF: session POST needs Origin; cross-site and text/plain refused", async () => {
    const { as: base } = await login();
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

  it("webhub.internal: only /_webhub/login (no /_auth yet — F-026); forwarded host checked", async () => {
    const internal = { host: "webhub.internal" };
    expect((await req("GET", "/api/v1/status", { ...internal, ...bearer })).statusCode).toBe(404);
    expect((await req("GET", "/api/v1/health", internal)).statusCode).toBe(404);
    const { cookie } = await login("db.localhost");
    for (const h of [internal, { host: "db.localhost" }]) {
      expect(
        (await req("GET", "/_auth", { ...h, cookie, "x-forwarded-host": "db.localhost" }))
          .statusCode,
      ).toBe(404);
    }
    const link = async () =>
      new URL(
        (
          await req(
            "POST",
            "/api/v1/login-links",
            { ...bearer, "content-type": "application/json" },
            JSON.stringify({ host: "hub.localhost" }),
          )
        ).json().url as string,
      );
    for (const xfh of ["evil.com", "hub.localhost, evil.com", API]) {
      const u = await link();
      const bad = await req("GET", `${u.pathname}${u.search}`, {
        ...internal,
        ...via,
        "x-forwarded-host": xfh,
      });
      expect(bad.statusCode, xfh).toBe(401);
    }
    // login through nginx (internal Host + forwarded host + proxy secret)
    const url = await link();
    const res = await req("GET", `${url.pathname}${url.search}`, {
      ...internal,
      ...via,
      "x-forwarded-host": "hub.localhost",
    });
    expect(res.statusCode).toBe(303);
  });

  it("shutdown: bearer only, 202 then callback once", async () => {
    const { as } = await login();
    expect(
      (await req("POST", "/api/v1/shutdown", { ...as, origin: "http://hub.localhost" })).statusCode,
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
    // the 5xx log line names the error class only, never its message (H2)
    const text = JSON.stringify(logs);
    expect(text).toContain('"error":"Error"');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("internal\\\\path");
  });

  it("checkUpgrade: same Host / auth / Origin rules as unsafe requests (H6)", async () => {
    const { cookie, key, as } = await login("hub.localhost");
    const opts = { ...HOSTS, token: TOKEN, sessions };
    const up = (headers: Record<string, string>) =>
      checkUpgrade({ rawHeaders: Object.entries(headers).flat(), headers }, opts);
    expect(up({ host: API, authorization: `Bearer ${TOKEN}` })).toEqual({
      ok: true,
      host: API,
      auth: "bearer",
      protocol: undefined,
    });
    const origin = "http://hub.localhost";
    expect(up({ ...as, origin })).toMatchObject({ ok: true, auth: "session" });
    // browsers' WebSocket: the key as a subprotocol; the server echoes webhub.v1, never the key
    const ws = (k: string, c = cookie) =>
      up({
        host: "hub.localhost",
        cookie: c,
        origin,
        "sec-websocket-protocol": `webhub.v1, webhub-key.${k}`,
      });
    expect(ws(key)).toEqual({
      ok: true,
      host: "hub.localhost",
      auth: "session",
      protocol: "webhub.v1",
    });
    expect(
      up({ host: "hub.localhost", cookie, origin, "sec-websocket-protocol": `webhub-key.${key}` }),
    ).toMatchObject({ ok: false, status: 401 }); // key only: nothing safe to echo (M8)
    const other = await login("hub.localhost");
    expect(ws(other.key)).toMatchObject({ ok: false, status: 401 }); // another session's key
    expect(ws(key, `webhub_session=${"A".repeat(43)}; ${cookie}`)).toMatchObject({ ok: true }); // tossed
    expect(up({ host: "hub.localhost", cookie, origin })).toMatchObject({ ok: false, status: 401 }); // no key (L1)
    expect(up(as)).toMatchObject({ ok: false, status: 403 });
    expect(up({ ...as, origin: "http://evil.com" })).toMatchObject({ ok: false, status: 403 });
    expect(up({ ...as, host: API, origin: `http://${API}` })).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(up({ host: "evil.com", authorization: `Bearer ${TOKEN}` })).toMatchObject({
      ok: false,
      status: 421,
    });
    expect(up({ host: "webhub.internal", authorization: `Bearer ${TOKEN}` })).toMatchObject({
      ok: false,
      status: 421,
    });
    expect(up({ host: API, authorization: "Bearer nope" })).toMatchObject({
      ok: false,
      status: 401,
      delay: true, // caller waits like HTTP does
    });
    expect(
      checkUpgrade({ rawHeaders: ["Host", API, "host", API], headers: { host: API } }, opts),
    ).toMatchObject({ ok: false, status: 421 });
  });

  it("log lines never contain token, code, cookie, key or query string", async () => {
    const { cookie, key, as } = await login();
    await req("GET", `/api/v1/hello?n=${randomBytes(32).toString("base64url")}`);
    await req("GET", "/api/v1/status", as);
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(3);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("?");
    expect(text).not.toContain(cookie.split("=")[1] ?? "x");
    expect(text).not.toContain(key);
    expect(text).not.toMatch(/authorization|cookie|x-webhub-session/i);
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
      return { status: 200, body: { proof: "forged" } };
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

  it("the proof is fresh for every request (N2) and runs on the request's own connection", async () => {
    const order: string[] = [];
    const agents = new Set<unknown>();
    const daemon: SendFn = async (_p, _m, path, headers, _b, opts) => {
      agents.add(opts?.agent);
      order.push(
        path.startsWith("/api/v1/hello") ? "hello" : `req:${headers.authorization !== undefined}`,
      );
      if (path.startsWith("/api/v1/hello")) {
        const n = new URL(path, "http://x").searchParams.get("n") ?? "";
        return { status: 200, body: { proof: helloProof(TOKEN, n) } };
      }
      return { status: 200, body: { ok: true } };
    };
    const c = new DaemonClient(auth, daemon);
    await c.request("GET", "/a");
    await c.request("POST", "/b");
    expect(order).toEqual(["hello", "req:true", "hello", "req:true"]);
    expect(agents.size).toBe(2); // one connection (agent) per request, shared by its proof
    expect(agents.has(undefined)).toBe(false);
  });

  it("a reload error is not reported as 'not running' (M7)", async () => {
    const c = new DaemonClient(
      auth,
      async () => ({ status: 200, body: { proof: "forged" } }),
      async () => {
        throw new Error("unsafe path");
      },
    );
    await expect(c.verify()).rejects.toThrow("unsafe path");
  });

  it("after a daemon restart (new token) the client reloads auth.json — not an impostor (J7/M6)", async () => {
    const NEW = randomBytes(32).toString("base64url");
    let serverToken = TOKEN;
    const sent: string[] = [];
    const daemon: SendFn = async (_p, _m, path, headers) => {
      if (path.startsWith("/api/v1/hello")) {
        const n = new URL(path, "http://x").searchParams.get("n") ?? "";
        return { status: 200, body: { proof: helloProof(serverToken, n) } };
      }
      sent.push(headers.authorization ?? "");
      return headers.authorization === `Bearer ${serverToken}`
        ? { status: 200, body: { ok: true } }
        : { status: 401, body: { error: { code: "UNAUTHORIZED", message: "not authorized" } } };
    };
    let file: typeof auth | undefined = auth;
    const c = new DaemonClient(auth, daemon, async () => file);
    expect(await c.request("GET", "/api/v1/status")).toEqual({ ok: true });
    serverToken = NEW; // restart
    file = { ...auth, token: NEW };
    // first call after the restart already works: proof fails → reload → prove again (M6)
    expect(await c.request("GET", "/api/v1/status")).toEqual({ ok: true });
    expect(sent).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEW}`]); // old token never sent again
    // daemon stopped and its file gone → not running (not "impostor")
    serverToken = "other";
    file = undefined;
    await expect(c.request("GET", "/api/v1/status")).rejects.toSatisfy((e) =>
      isServerError(e, "DAEMON_NOT_RUNNING"),
    );
    expect(sent).toHaveLength(2);
  });
});
