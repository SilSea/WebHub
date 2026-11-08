/**
 * API server (F-003 §3.2–3.8, DESIGN §10.3). Every request passes, in order:
 * exactly one allowed Host (else 421) → origin-form target only → no OPTIONS / CORS (405) →
 * route scope (api host vs `webhub.internal`) → authentication per route `access` (default:
 * bearer or session) → CSRF rules for unsafe methods. Routes of later features go through
 * `RouteRegistrar` and get all of this by default; a public route must say
 * `access: "public"` explicitly. Browser sessions exist only on named hosts (`hub.`/`db.`),
 * never on `127.0.0.1:<port>` (security-1 K1).
 */
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { type FastifyInstance, type FastifyReply, fastify } from "fastify";
import { z } from "zod";
import {
  type AuthKind,
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
  sessionHosts,
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
  /** Called once after POST /api/v1/shutdown was answered (or the client went away). */
  onShutdown: () => void;
  /** One structured log line (never gets tokens, codes, cookies, queries or error messages). */
  log: (entry: Record<string, unknown>) => void;
  /** Delay after a wrong bearer token (ms). */
  failDelayMs?: number;
}

export type RouteRegistrar = (app: FastifyInstance, ctx: ApiContext) => void;

export const BODY_LIMIT = 1024 * 1024;
export const HEADERS_TIMEOUT_MS = 10_000;
export const MAX_CONNECTIONS = 256;

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

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
};

function deny(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).headers(SECURITY_HEADERS).send({ error: { code, message } });
}

/** Single forwarded host from nginx (internal requests only); must be a session host. */
function forwardedHost(
  value: string | string[] | undefined,
  hosts: HostOptions,
): string | undefined {
  if (typeof value !== "string" || value.includes(",")) return undefined;
  const h = normaliseHost(value);
  return h !== undefined && sessionHosts(hosts).includes(h) ? h : undefined;
}

/** Raw reply for errors Node's HTTP parser raises before Fastify sees a request (H3/K8). */
function clientError(err: Error & { code?: string }, socket: Socket): void {
  if (!socket.writable) return;
  const [status, text] =
    err.code === "ERR_HTTP_REQUEST_TIMEOUT"
      ? [408, "Request Timeout"]
      : err.code === "HPE_HEADER_OVERFLOW"
        ? [431, "Request Header Fields Too Large"]
        : [400, "Bad Request"];
  const body = JSON.stringify({ error: { code: "BAD_REQUEST", message: "bad request" } });
  const headers = Object.entries(SECURITY_HEADERS)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-type: application/json; charset=utf-8\r\n${headers}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export async function createApi(
  ctx: ApiContext,
  registrars: readonly RouteRegistrar[] = [],
): Promise<FastifyInstance> {
  let closing = false;
  const app = fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
    requestTimeout: 30_000,
    keepAliveTimeout: 5_000,
    return503OnClosing: false, // answered by our own hook (uniform body + headers — H4)
    trustProxy: false,
    clientErrorHandler: clientError,
    // errors Fastify raises before routing (bad URL encoding …) skip the hooks: same rules here (H3)
    frameworkErrors: (_err, req, reply) => {
      if (
        hostHeaderCount(req.raw.rawHeaders) !== 1 ||
        classifyHost(req.headers.host, ctx.hosts) === undefined
      ) {
        return deny(reply, 421, "MISDIRECTED", "unknown host");
      }
      return deny(reply, 400, "BAD_REQUEST", "bad request");
    },
  });
  // slowloris / socket exhaustion from local processes (K4)
  app.server.headersTimeout = HEADERS_TIMEOUT_MS;
  app.server.maxConnections = MAX_CONNECTIONS;
  // JSON only: a browser can send text/plain or form bodies cross-site without a preflight.
  // An empty JSON body is "no body" (fetch with a JSON content type and no payload — H15).
  app.removeContentTypeParser(["text/plain", "application/json"]);
  const jsonParser = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (body === "") return done(null, undefined);
    return jsonParser(req, typeof body === "string" ? body : body.toString("utf8"), done);
  });
  app.decorateRequest("webhub", null as never);
  app.addHook("preClose", async () => {
    closing = true;
  });

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
    if (closing) return deny(reply, 503, "SHUTTING_DOWN", "webhub is stopping");
    // 2. origin-form targets only (`/path`), no absolute-form `http://other/…` (K5)
    if (!(req.raw.url ?? "").startsWith("/")) return deny(reply, 400, "BAD_REQUEST", "bad request");
    // 3. no CORS at all
    if (req.method === "OPTIONS") {
      reply.header("allow", "GET, HEAD, POST");
      return deny(reply, 405, "METHOD_NOT_ALLOWED", "not allowed");
    }
    if (req.is404) return; // not-found handler answers (no data)
    // 4. scope
    const cfg = req.routeOptions.config;
    const scope: Scope = cfg.scope ?? "api";
    if (scope !== "both" && scope !== h.kind) return deny(reply, 404, "NOT_FOUND", "not found");
    // 5. authentication — sessions only on named hosts (K1)
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
      sessionHosts(ctx.hosts).includes(h.host) &&
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
    // 6. CSRF
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
    reply.headers(SECURITY_HEADERS);
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    const raw = req.raw.url ?? "";
    ctx.log({
      method: req.method,
      // never the query (login codes, nonces) nor a foreign authority
      path: raw.startsWith("/") ? raw.split("?")[0] : "(invalid target)",
      status: reply.statusCode,
      ms: Math.round(performance.now() - (req.webhub?.started ?? performance.now())),
    });
  });

  app.setNotFoundHandler((_req, reply) => deny(reply, 404, "NOT_FOUND", "not found"));

  app.setErrorHandler((err: { statusCode?: number; code?: string; name?: string }, _req, reply) => {
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
    // the message may hold paths / secrets of later features → class / code only (H2)
    if (status >= 500) {
      ctx.log({ level: "error", msg: "request failed", error: err.code ?? err.name ?? "Error" });
    }
    return deny(reply, status, code, message);
  });

  // ---------- routes ----------

  app.get("/api/v1/health", { config: { access: "public" } }, async () => ({ ok: true }));

  app.get("/api/v1/hello", { config: { access: "public" } }, async (req) => {
    const n = (req.query as Record<string, unknown>).n;
    if (!isId(n)) throw new HttpError(400, "BAD_REQUEST", "n must be 32 random bytes (base64url)");
    return { proof: helloProof(ctx.token, n) };
  });

  app.get("/api/v1/status", async () => ctx.status());

  app.post("/api/v1/shutdown", { config: { access: "bearer" } }, async (_req, reply) => {
    let called = false;
    const once = () => {
      if (called) return;
      called = true;
      ctx.onShutdown();
    };
    // `close` too: a client that disconnects early still stops the daemon (H10)
    reply.raw.once("finish", once);
    reply.raw.once("close", once);
    return reply.code(202).send({ ok: true });
  });

  const LoginLinkBody = z.strictObject({ host: z.string().max(300).optional() }).optional();
  app.post("/api/v1/login-links", { config: { access: "bearer" } }, async (req) => {
    const body = LoginLinkBody.safeParse(req.body ?? undefined);
    if (!body.success) throw new HttpError(400, "BAD_REQUEST", 'body must be {"host"?: string}');
    const wanted = body.data?.host;
    const allowed = sessionHosts(ctx.hosts);
    // default: the dashboard host (never the IP host the CLI talks to — K1)
    const host = wanted === undefined ? allowed[0] : normaliseHost(wanted);
    if (host === undefined || !allowed.includes(host)) {
      throw new HttpError(400, "BAD_REQUEST", `host must be one of: ${allowed.join(", ")}`);
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
          : sessionHosts(ctx.hosts).includes(req.webhub.host)
            ? req.webhub.host
            : undefined;
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
