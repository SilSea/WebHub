/**
 * API server (F-003 §3.2–3.8, DESIGN §10.3). Every request passes, in order:
 * exactly one allowed Host (else 421) → no OPTIONS / CORS (405) → route scope (api host vs
 * `webhub.internal`) → authentication per route `access` (default: bearer or session) →
 * CSRF rules for unsafe methods. Routes of later features go through `RouteRegistrar` and
 * get all of this by default; a public route must say `access: "public"` explicitly.
 */
import { performance } from "node:perf_hooks";
import { type FastifyInstance, type FastifyReply, fastify } from "fastify";
import { z } from "zod";
import {
  type AuthKind,
  apiHosts,
  classifyHost,
  clearSessionCookie,
  csrfProblem,
  type HostKind,
  type HostOptions,
  helloProof,
  hostHeaderCount,
  isId,
  normaliseHost,
  parseBearer,
  readCookie,
  SESSION_COOKIE,
  type SessionStore,
  safeEqual,
  sessionCookie,
} from "./auth.js";

/** Who may call a route. `internal` = the handler checks a login code / forwarded cookie itself. */
export type Access = "public" | "bearer" | "user" | "session" | "internal";
/** Which Host kind a route answers on (other kind → 404). */
export type Scope = "api" | "internal" | "both";

declare module "fastify" {
  interface FastifyContextConfig {
    access?: Access;
    scope?: Scope;
  }
  interface FastifyRequest {
    webhub: { host: string; hostKind: HostKind; auth: AuthKind; started: number };
  }
}

export interface ApiContext {
  token: string;
  hosts: HostOptions;
  sessions: SessionStore;
  /** Body of GET /api/v1/status. */
  status: () => Record<string, unknown>;
  /** Called once after the 202 of POST /api/v1/shutdown was sent. */
  onShutdown: () => void;
  /** One structured log line (never gets tokens, codes, cookies or query strings). */
  log: (entry: Record<string, unknown>) => void;
  /** Delay after a wrong bearer token (ms). */
  failDelayMs?: number;
}

export type RouteRegistrar = (app: FastifyInstance, ctx: ApiContext) => void;

export const BODY_LIMIT = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly apiCode: string,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deny(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
};

/** Single forwarded host from nginx (internal requests only); must be an API host. */
function forwardedHost(
  value: string | string[] | undefined,
  hosts: HostOptions,
): string | undefined {
  if (typeof value !== "string" || value.includes(",")) return undefined;
  const h = normaliseHost(value);
  return h !== undefined && apiHosts(hosts).includes(h) ? h : undefined;
}

export async function createApi(
  ctx: ApiContext,
  registrars: readonly RouteRegistrar[] = [],
): Promise<FastifyInstance> {
  const app = fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
    return503OnClosing: true,
    trustProxy: false,
  });
  // JSON only: a browser can send text/plain or form bodies cross-site without a preflight
  app.removeContentTypeParser(["text/plain"]);
  app.decorateRequest("webhub", null as never);

  app.addHook("onRequest", async (req, reply) => {
    const started = performance.now();
    req.webhub = { host: "", hostKind: "api", auth: "none", started };
    // 1. Host allowlist — before anything else (DNS rebinding)
    if (hostHeaderCount(req.raw.rawHeaders) !== 1) {
      return deny(reply, 421, "MISDIRECTED", "unknown host");
    }
    const h = classifyHost(req.headers.host, ctx.hosts);
    if (h === undefined) return deny(reply, 421, "MISDIRECTED", "unknown host");
    req.webhub.host = h.host;
    req.webhub.hostKind = h.kind;
    // 2. no CORS at all
    if (req.method === "OPTIONS") return deny(reply, 405, "METHOD_NOT_ALLOWED", "not allowed");
    if (req.is404) return; // not-found handler answers (no data)
    // 3. scope
    const cfg = req.routeOptions.config;
    const scope: Scope = cfg.scope ?? "api";
    if (scope !== "both" && scope !== h.kind) return deny(reply, 404, "NOT_FOUND", "not found");
    // 4. authentication
    const access: Access = cfg.access ?? "user";
    let auth: AuthKind = "none";
    const authz = req.headers.authorization;
    if (authz !== undefined) {
      const t = parseBearer(authz);
      if (t === undefined || !safeEqual(t, ctx.token)) {
        await sleep(ctx.failDelayMs ?? 50);
        return deny(reply, 401, "UNAUTHORIZED", "not authorized");
      }
      auth = "bearer";
    } else if (
      h.kind === "api" &&
      ctx.sessions.checkSession(readCookie(req.headers.cookie, SESSION_COOKIE), h.host)
    ) {
      auth = "session";
    }
    req.webhub.auth = auth;
    const ok =
      access === "public" ||
      access === "internal" ||
      (access === "bearer" && auth === "bearer") ||
      (access === "session" && auth === "session") ||
      (access === "user" && auth !== "none");
    if (!ok) return deny(reply, 401, "UNAUTHORIZED", "not authorized");
    // 5. CSRF
    const site = req.headers["sec-fetch-site"];
    const problem = csrfProblem(
      req.method,
      {
        origin: req.headers.origin,
        "sec-fetch-site": typeof site === "string" ? site : undefined,
      },
      h.host,
      auth,
    );
    if (problem !== undefined) return deny(reply, 403, "FORBIDDEN", problem);
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    ctx.log({
      method: req.method,
      path: req.url.split("?")[0], // never the query (login codes, nonces)
      status: reply.statusCode,
      ms: Math.round(performance.now() - (req.webhub?.started ?? performance.now())),
    });
  });

  app.setNotFoundHandler((_req, reply) => deny(reply, 404, "NOT_FOUND", "not found"));

  app.setErrorHandler(
    (err: { statusCode?: number; apiCode?: string; message?: string }, _req, reply) => {
      const status =
        typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
          ? err.statusCode
          : 500;
      if (err instanceof HttpError) return deny(reply, status, err.apiCode, err.message);
      const known: Record<number, [string, string]> = {
        400: ["BAD_REQUEST", "bad request"],
        413: ["BODY_TOO_LARGE", "request body too large"],
        415: ["UNSUPPORTED_MEDIA_TYPE", "send JSON (Content-Type: application/json)"],
      };
      const [code, message] =
        known[status] ??
        (status < 500 ? ["BAD_REQUEST", "bad request"] : ["INTERNAL", "internal error"]);
      if (status >= 500)
        ctx.log({ level: "error", msg: "request failed", error: err.message ?? "" });
      return deny(reply, status, code, message);
    },
  );

  // ---------- routes ----------

  app.get("/api/v1/health", { config: { access: "public" } }, async () => ({ ok: true }));

  app.get("/api/v1/hello", { config: { access: "public" } }, async (req) => {
    const n = (req.query as Record<string, unknown>).n;
    if (!isId(n)) throw new HttpError(400, "BAD_REQUEST", "n must be 32 random bytes (base64url)");
    return { proof: helloProof(ctx.token, n), pid: process.pid };
  });

  app.get("/api/v1/status", async () => ctx.status());

  app.post("/api/v1/shutdown", { config: { access: "bearer" } }, async (_req, reply) => {
    let called = false;
    reply.raw.once("finish", () => {
      if (!called) {
        called = true;
        ctx.onShutdown();
      }
    });
    return reply.code(202).send({ ok: true });
  });

  const LoginLinkBody = z.strictObject({ host: z.string().max(300).optional() }).optional();
  app.post("/api/v1/login-links", { config: { access: "bearer" } }, async (req) => {
    const body = LoginLinkBody.safeParse(req.body ?? undefined);
    if (!body.success) throw new HttpError(400, "BAD_REQUEST", 'body must be {"host"?: string}');
    const wanted = body.data?.host;
    const host = wanted === undefined ? req.webhub.host : normaliseHost(wanted);
    if (host === undefined || !apiHosts(ctx.hosts).includes(host)) {
      throw new HttpError(400, "BAD_REQUEST", "host is not a webhub host");
    }
    const { code, expiresAt } = ctx.sessions.createCode(host);
    return {
      url: `http://${host}/_webhub/login?t=${code}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });

  app.post("/api/v1/logout", { config: { access: "session" } }, async (req, reply) => {
    ctx.sessions.deleteSession(readCookie(req.headers.cookie, SESSION_COOKIE));
    return reply.code(204).header("set-cookie", clearSessionCookie()).send();
  });

  app.get(
    "/_webhub/login",
    { config: { access: "internal", scope: "both" } },
    async (req, reply) => {
      const target =
        req.webhub.hostKind === "internal"
          ? forwardedHost(req.headers["x-forwarded-host"], ctx.hosts)
          : req.webhub.host;
      const t = (req.query as Record<string, unknown>).t;
      if (target === undefined || typeof t !== "string" || !ctx.sessions.consumeCode(t, target)) {
        return reply
          .code(401)
          .type("text/plain; charset=utf-8")
          .send("This login link is invalid, expired or already used. Run `webhub ui` again.");
      }
      const id = ctx.sessions.createSession(target);
      return reply.code(303).header("set-cookie", sessionCookie(id)).header("location", "/").send();
    },
  );

  app.get("/_auth", { config: { access: "internal", scope: "internal" } }, async (req, reply) => {
    const target = forwardedHost(req.headers["x-forwarded-host"], ctx.hosts);
    const ok =
      target !== undefined &&
      ctx.sessions.checkSession(readCookie(req.headers.cookie, SESSION_COOKIE), target);
    return reply.code(ok ? 204 : 401).send();
  });

  for (const r of registrars) r(app, ctx);
  await app.ready();
  return app;
}
