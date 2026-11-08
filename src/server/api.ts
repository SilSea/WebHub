/**
 * API server (F-003 §3.2–3.8, DESIGN §10.3). Every request Fastify sees passes, in order:
 * exactly one allowed Host (else 421) → 503 while closing → origin-form target only → no
 * OPTIONS / CORS (405) → unknown route 404 (before any body is read) → route scope (api host vs
 * `webhub.internal`) → authentication per route `access` (default: bearer or session) → CSRF
 * rules for unsafe methods. Answered before Fastify, without the Host check and without a log
 * line (static bodies + security headers, browsers cannot trigger them): Node parser errors
 * (400/408/431) and an `Expect` other than `100-continue` (417). Every way Node hands out a
 * request must go through `refusePipelining`'s check — new server listeners (e.g. `upgrade` in
 * F-027) included, and the daemon listens on ONE address only (security-8 Y4). Routes of later features go through
 * `RouteRegistrar` and get all of this by default; a public route must say
 * `access: "public"` explicitly. Browser sessions exist only on named hosts (`hub.`/`db.`),
 * never on `127.0.0.1:<port>` (security-1 K1), and need the cookie plus the port-scoped key
 * header `x-webhub-session` (security-2 L1).
 */
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
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
  PROXY_HEADER,
  parseBearer,
  proxySecretFor,
  type SessionStore,
  safeEqual,
  sessionCookie,
  sessionFor,
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
    webhub: {
      host: string;
      hostKind: HostKind;
      auth: AuthKind;
      /** Id of the browser session when `auth` is "session". */
      sessionId: string | undefined;
      started: number;
    };
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
  /**
   * Browser login (login links) on. Off until webhub's own nginx serves the http port (F-009
   * turns it on once it has written the proxy secret into nginx) — security-3 N1.
   */
  browserLogin?: boolean;
}

export type RouteRegistrar = (app: FastifyInstance, ctx: ApiContext) => void;

export const BODY_LIMIT = 1024 * 1024;
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;
/** How often Node enforces the two timeouts above (default 30 s would stretch them — L2/J1). */
export const TIMEOUT_CHECK_MS = 1_000;
/** Longest a socket lives after its parser-error reply was written (review-5 R1 / S1). */
export const CLIENT_ERROR_CLOSE_MS = 2_000;
/** Longest a parser-error reply waits for the pending response (security-6 U2). */
export const CLIENT_ERROR_DEFER_MS = 5_000;
/**
 * A socket with no traffic either way for this long is cut — e.g. a client that sent its request
 * and never reads the answer (security-6 U1/U3). Routes that may stay silent longer (streams)
 * must send keep-alive bytes.
 */
export const CONNECTION_IDLE_MS = 15_000;
/**
 * Real need: CLI 1–2, a browser 6 per host, nginx (F-009). Each socket can cost one 64 KB parse
 * chunk of tiny requests even after it is refused, so this bounds a flood (security-7 W2).
 */
export const MAX_CONNECTIONS = 64;

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

/** Sockets whose error reply already waits for the pending response (one wait per socket). */
const deferred = new WeakSet<Socket>();

type PendingResponse = NodeJS.EventEmitter & { _headerSent?: boolean; req?: unknown };
type HttpSocket = Socket & {
  _httpMessage?: PendingResponse | null;
  parser?: { incoming?: { complete?: boolean } | null } | null;
};

/** Raw reply for errors Node's HTTP parser raises before Fastify sees a request (H3/K8). */
function clientError(err: Error & { code?: string }, socket: Socket): void {
  if (!socket.writable) return;
  // Node raises one error per further chunk: after the first, nothing more is done for this
  // socket — no listener pile-up / O(n²) event-loop freeze (security-4 Q3)
  if (deferred.has(socket)) return;
  // The response of the EARLIER request is still pending (garbage sent right behind a request):
  // writing ours now would put it out of order on the wire (security-2 L5) → stop reading and
  // write it once that response finished. Pipelining is refused (security-6 U1), so there is at
  // most one pending response — no chain (review-6 T1). An error in the request being parsed
  // itself (bad body, timeout) gets its 400 / 408 right away (review-3 M1). A response that is
  // still `_httpMessage` has not emitted `finish` (Node's own handler detaches it first) — no
  // `writableFinished` check, which Node 22 computes differently (review-6 T1).
  const s = socket as HttpSocket;
  const pending = s._httpMessage;
  const incoming = s.parser?.incoming;
  if (
    pending &&
    (pending._headerSent === true || pending.req !== incoming || incoming?.complete === true)
  ) {
    deferred.add(socket);
    socket.pause();
    // bounded: a long-running response (stream, long-poll) must not hold a socket whose FIN
    // we no longer read (security-6 U2)
    const bound = setTimeout(() => socket.destroy(), CLIENT_ERROR_DEFER_MS);
    bound.unref();
    const onFinish = () => {
      clearTimeout(bound);
      pending.removeListener("close", onClose);
      writeClientError(err, socket);
    };
    const onClose = () => {
      clearTimeout(bound);
      pending.removeListener("finish", onFinish);
      socket.destroy();
    };
    pending.once("finish", onFinish);
    pending.once("close", onClose);
    return;
  }
  writeClientError(err, socket);
}

function writeClientError(err: Error & { code?: string }, socket: Socket): void {
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
  // The socket must close for sure: the server is allowHalfOpen, and a paused (deferred) socket
  // never reads the peer's FIN (review-5 R1 / security-5 S1). Keep reading (the failed parser
  // discards it) so the FIN is seen and a client still sending gets the reply, not an RST
  // (review-6 T2); backstop for a peer that never closes.
  const backstop = setTimeout(() => socket.destroy(), CLIENT_ERROR_CLOSE_MS);
  backstop.unref();
  socket.once("close", () => clearTimeout(backstop));
  socket.resume();
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-type: application/json; charset=utf-8\r\n${headers}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export const LOG_PATH_MAX = 200;

/** Path as logged: no query, at most LOG_PATH_MAX chars, nothing for a foreign Host (Y1). */
export function logPath(raw: string, status: number): string {
  if (status === 421) return "(foreign host)";
  if (!raw.startsWith("/")) return "(invalid target)";
  const path = raw.split("?")[0] ?? "";
  return path.length > LOG_PATH_MAX
    ? `${path.slice(0, LOG_PATH_MAX)}…(+${path.length - LOG_PATH_MAX})`
    : path;
}

/** Sockets with a request whose response has not finished yet. */
const busy = new WeakSet<Socket>();

/**
 * No HTTP pipelining (security-6 U1): a request that arrives while the previous response on
 * the same socket is unfinished destroys the socket, before Fastify builds anything for it.
 * Otherwise a client that never reads could pile up thousands of pending requests per socket
 * (heap → OOM). The CLI and browsers never pipeline. Every way Node hands out a request goes
 * through the same check: `request`, `checkContinue` (`Expect: 100-continue`) and
 * `checkExpectation` (any other `Expect`, which Node would otherwise answer 417 by itself,
 * bypassing the check — security-7 W1). Node still parses the rest of the chunk it is reading
 * after a destroy; `MAX_CONNECTIONS` bounds that cost (security-7 W2).
 */
function refusePipelining(server: HttpServer): void {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  const handlers = server.listeners("request") as Handler[];
  server.removeAllListeners("request");
  const admit = (req: IncomingMessage, res: ServerResponse): boolean => {
    const socket = req.socket;
    if (socket.destroyed) return false;
    if (busy.has(socket)) {
      socket.destroy();
      return false;
    }
    busy.add(socket);
    const done = () => busy.delete(socket);
    res.once("finish", done);
    res.once("close", done);
    return true;
  };
  const run: Handler = (req, res) => {
    for (const h of handlers) h(req, res);
  };
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (admit(req, res)) run(req, res);
  });
  server.on("checkContinue", (req: IncomingMessage, res: ServerResponse) => {
    if (!admit(req, res)) return;
    res.writeContinue();
    run(req, res);
  });
  server.on("checkExpectation", (req: IncomingMessage, res: ServerResponse) => {
    if (!admit(req, res)) return;
    const body = JSON.stringify({
      error: { code: "EXPECTATION_FAILED", message: "expectation failed" },
    });
    res.writeHead(417, {
      ...SECURITY_HEADERS,
      connection: "close",
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
}

export async function createApi(
  ctx: ApiContext,
  registrars: readonly RouteRegistrar[] = [],
): Promise<FastifyInstance> {
  let closing = false;
  const proxySecret = proxySecretFor(ctx.token);
  const app = fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
    requestTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 5_000,
    connectionTimeout: CONNECTION_IDLE_MS,
    http: {
      // slowloris from local processes (K4): enforce the timeouts every second (L2/J1)
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      connectionsCheckingInterval: TIMEOUT_CHECK_MS,
      // HTTP/1.1 without Host must reach our hook (421 + headers), not Node's bare 400 (J3)
      requireHostHeader: false,
    },
    return503OnClosing: false, // answered by our own hook (uniform body + headers — H4)
    trustProxy: false,
    clientErrorHandler: clientError,
    // errors Fastify raises before routing (bad URL encoding …) skip the hooks: same rules here (H3)
    frameworkErrors: (_err, req, reply) => {
      const badHost =
        hostHeaderCount(req.raw.rawHeaders) !== 1 ||
        classifyHost(req.headers.host, ctx.hosts) === undefined;
      // logged with the real status, never with the target (J5 / M5)
      ctx.log({ method: req.method, path: "(invalid target)", status: badHost ? 421 : 400 });
      return badHost
        ? deny(reply, 421, "MISDIRECTED", "unknown host")
        : deny(reply, 400, "BAD_REQUEST", "bad request");
    },
  });
  app.server.maxConnections = MAX_CONNECTIONS;
  refusePipelining(app.server);
  // Idle sockets (no traffic either way for CONNECTION_IDLE_MS, or the keep-alive timeout) are
  // destroyed — e.g. a client that never reads its answer (security-6 U1/U3). A request still
  // being received is left to the header / request timeouts, which answer 408 (M1).
  app.server.on("timeout", (socket: Socket) => {
    const incoming = (socket as HttpSocket).parser?.incoming;
    if (incoming && incoming.complete !== true) return;
    socket.destroy();
  });
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
    req.webhub = { host: "", hostKind: "api", auth: "none", sessionId: undefined, started };
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
    // unknown route: answered here, before any body is read or parsed (security-7 W3)
    if (req.is404) return deny(reply, 404, "NOT_FOUND", "not found");
    // 4. scope
    const cfg = req.routeOptions.config;
    const scope: Scope = cfg.scope ?? "api";
    if (scope !== "both" && scope !== h.kind) return deny(reply, 404, "NOT_FOUND", "not found");
    // 5. authentication — sessions only on named hosts (K1), cookie + key header (L1)
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
    } else {
      const id = sessionFor(req.headers, h.host, ctx.hosts, ctx.sessions);
      if (id !== undefined) {
        auth = "session";
        req.webhub.sessionId = id;
      }
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
      // never the query (login codes, nonces) nor a foreign authority; bounded length, and
      // nothing from a foreign Host — no log flood with attacker data (security-8 Y1)
      path: logPath(raw, reply.statusCode),
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
    // until webhub's nginx owns the http port, a link would go to whatever listens there (N1)
    if (ctx.browserLogin !== true) {
      throw new HttpError(
        503,
        "LOGIN_UNAVAILABLE",
        "browser login needs webhub's nginx (not set up yet)",
      );
    }
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
    ctx.sessions.deleteSession(req.webhub.sessionId);
    return reply.code(204).header("set-cookie", clearSessionCookie()).send();
  });

  app.get(
    "/_webhub/login",
    // no automatic HEAD: a HEAD (link preview / probe) must not burn the code (J4)
    { config: { access: "internal", scope: "both" }, exposeHeadRoute: false },
    async (req, reply) => {
      const target =
        req.webhub.hostKind === "internal"
          ? forwardedHost(req.headers["x-forwarded-host"], ctx.hosts)
          : sessionHosts(ctx.hosts).includes(req.webhub.host)
            ? req.webhub.host
            : undefined;
      const t = (req.query as Record<string, unknown>).t;
      // only through webhub's nginx: a squatter on the http port that received the link cannot
      // redeem it here directly (security-3 N1); checked before the code is touched
      const proxy = req.headers[PROXY_HEADER];
      const viaNginx = typeof proxy === "string" && safeEqual(proxy, proxySecret);
      if (
        !viaNginx ||
        target === undefined ||
        typeof t !== "string" ||
        !ctx.sessions.consumeCode(t, target)
      ) {
        return reply
          .code(401)
          .type("text/plain; charset=utf-8")
          .send("This login link is invalid, expired or already used. Run `webhub ui` again.");
      }
      const { id, key } = ctx.sessions.createSession(target);
      // the key goes in the fragment: never sent to a server, never in a Referer; the dashboard
      // moves it into sessionStorage (port-scoped) and clears the URL (security-2 L1)
      return reply
        .code(303)
        .header("set-cookie", sessionCookie(id))
        .header("location", `/#k=${key}`)
        .send();
    },
  );
  // `/_auth` (nginx auth_request for db tools) is NOT here: a cookie alone is leakable (L1) and
  // nginx must fail closed when the daemon is down (L4) — designed with F-026.

  for (const r of registrars) r(app, ctx);
  await app.ready();
  return app;
}
