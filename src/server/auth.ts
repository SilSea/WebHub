/**
 * Pure auth building blocks of the API (F-003 §3.2–3.5, DESIGN §10.3). No I/O here, so every
 * rule is unit-tested without a server.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "webhub_session";
/**
 * Second session secret, sent by the dashboard's JS on every API call (security-2 L1).
 * Cookies are not port-scoped and `*.localhost` reaches every loopback port, so any program
 * on `127.0.0.1:<Q>` can be opened as `http://hub.localhost:<Q>` and receives the hub cookie.
 * The key lives in the page's sessionStorage, which IS scoped to scheme + host + port.
 */
export const SESSION_HEADER = "x-webhub-session";
/** WebSocket clients cannot set headers: the key travels as a subprotocol `webhub-key.<key>`. */
export const SESSION_SUBPROTOCOL_PREFIX = "webhub-key.";
/** The subprotocol a webhub WebSocket server echoes (never the key one). */
export const WS_PROTOCOL = "webhub.v1";
/** Header nginx adds with `proxySecretFor(token)` (security-3 N1). */
export const PROXY_HEADER = "x-webhub-proxy";
export const INTERNAL_HOST = "webhub.internal";
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
export const LOGIN_CODE_TTL_MS = 60_000;
const MAX_SESSIONS = 1000;
const MAX_CODES = 100;
const MAX_COOKIE_VALUES = 8;

/** 32 random bytes, base64url (43 chars). */
export const randomId = (): string => randomBytes(32).toString("base64url");
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const isId = (s: unknown): s is string => typeof s === "string" && ID_RE.test(s);

// ---------- Host allowlist (DNS rebinding) ----------

export interface HostOptions {
  /** Port the API listens on (127.0.0.1:<apiPort>). */
  apiPort: number;
  /** Port nginx serves http on (hub./db.<suffix> get `:<port>` unless 80). */
  httpPort: number;
  /** config.domainSuffix, default "localhost". */
  domainSuffix: string;
}

/** Hosts a browser / the CLI may use to reach the API (exact, lower case). */
export function apiHosts(o: HostOptions): string[] {
  const suffix = o.httpPort === 80 ? "" : `:${o.httpPort}`;
  return [
    `127.0.0.1:${o.apiPort}`,
    `hub.${o.domainSuffix}${suffix}`,
    `db.${o.domainSuffix}${suffix}`,
  ];
}

/**
 * Hosts that may hold a browser session: named hosts only (security-1 K1). Never an IP host:
 * `127.0.0.1:<apiPort>` = bearer only. The hub./db. cookie still reaches
 * `hub.<suffix>:<any port>` (any local program can force that navigation — security-2 L1), so
 * a session needs the cookie AND the port-scoped key header (`SESSION_HEADER`).
 */
export function sessionHosts(o: HostOptions): string[] {
  return apiHosts(o).filter((h) => !h.startsWith("127.0.0.1:"));
}

export type HostKind = "api" | "internal";

/**
 * Normalises one Host header value (lower case, trailing dot of the name removed) and
 * classifies it. Anything not on the list → undefined (caller answers 421).
 */
export function classifyHost(
  raw: string | undefined,
  o: HostOptions,
): { kind: HostKind; host: string } | undefined {
  if (raw === undefined) return undefined;
  const host = normaliseHost(raw);
  if (host === undefined) return undefined;
  if (host === INTERNAL_HOST) return { kind: "internal", host };
  return apiHosts(o).includes(host) ? { kind: "api", host } : undefined;
}

export function normaliseHost(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  const m = /^([a-z0-9.-]+?)\.?(:\d{1,5})?$/.exec(v);
  if (m === null || m[1] === undefined || m[1] === "") return undefined;
  return `${m[1]}${m[2] ?? ""}`;
}

/** Number of Host headers in Node's rawHeaders (duplicates are refused). */
export function hostHeaderCount(rawHeaders: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "host") n++;
  }
  return n;
}

// ---------- secrets compare / proof ----------

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `Bearer <token>` → token, else undefined. */
export function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(header);
  return m?.[1];
}

/** Proof that the server knows the token, without revealing it (F-003 §3.5). */
export function helloProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`webhub-hello:${nonce}`).digest("base64url");
}

/**
 * Secret webhub's nginx adds to every request it forwards (`X-Webhub-Proxy`, F-009 writes it
 * into its user-only config and strips any client copy). A login code is redeemed only with
 * it: a program squatting the http port receives the code but cannot turn it into a session
 * (security-3 N1). Derived from the per-start token → changes with every daemon start.
 */
export function proxySecretFor(token: string): string {
  return createHmac("sha256", token).update("webhub-proxy").digest("base64url");
}

// ---------- cookies ----------

/**
 * The first 8 values of `name` in a Cookie header. Several values appear when another port of
 * the same host tosses its own cookie (security-2 L1): the session check tries each and only
 * the one bound to the key header matches, so a tossed value never becomes a session (no
 * fixation). It CAN still log the user out (overwrite of the same name/path from another port,
 * or pushing the real value past 8) — accepted residual risk until HTTPS + `__Host-` (N3/M2).
 */
export function readCookies(header: string | undefined, name: string): string[] {
  if (header === undefined) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    if (out.length === MAX_COOKIE_VALUES) break;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    out.push(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Host-only (no Domain), HttpOnly, SameSite=Strict browser-session cookie. No Max-Age: gone
 * when the browser closes (security-2 L1).
 */
export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// ---------- CSRF ----------

export type AuthKind = "bearer" | "session" | "none";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Cross-origin rules for a request on `host` (F-003 §3.4). Returns a reason when refused.
 * - unsafe methods with a cookie session need `Origin: http://<host>`
 * - any request that sends Origin / Sec-Fetch-Site on an unsafe method must be same-origin
 */
export function csrfProblem(
  method: string,
  headers: { origin?: string | undefined; "sec-fetch-site"?: string | undefined },
  host: string,
  auth: AuthKind,
): string | undefined {
  if (SAFE_METHODS.has(method)) return undefined;
  const origin = headers.origin;
  const site = headers["sec-fetch-site"];
  if (origin !== undefined && origin !== `http://${host}`) return "cross-origin request";
  if (site !== undefined && site !== "same-origin") return "cross-site request";
  if (auth === "session" && origin === undefined) return "missing Origin";
  return undefined;
}

// ---------- WebSocket upgrade (shared by later features, e.g. dashboard F-027) ----------

export interface UpgradeRequest {
  rawHeaders: readonly string[];
  headers: {
    host?: string | undefined;
    origin?: string | undefined;
    authorization?: string | undefined;
    cookie?: string | undefined;
    "sec-fetch-site"?: string | string[] | undefined;
    "x-webhub-session"?: string | string[] | undefined;
    "sec-websocket-protocol"?: string | string[] | undefined;
  };
}

/**
 * Session key from a `Sec-WebSocket-Protocol` list. Valid only as exactly one
 * `webhub-key.<key>` next to `webhub.v1` (the protocol the server echoes — never the key one;
 * a browser fails the handshake when no offered protocol is echoed — review-3 M8).
 */
export function keyFromSubprotocols(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const list = value.split(",").map((p) => p.trim());
  const keys = list.filter((p) => p.startsWith(SESSION_SUBPROTOCOL_PREFIX));
  if (keys.length !== 1 || !list.includes(WS_PROTOCOL)) return undefined;
  return keys[0]?.slice(SESSION_SUBPROTOCOL_PREFIX.length);
}

/**
 * Session id for a request on `host`: a session host, one cookie value and the key of that same
 * session (default: the `x-webhub-session` header). Undefined otherwise.
 */
export function sessionFor(
  headers: { cookie?: string | undefined; "x-webhub-session"?: string | string[] | undefined },
  host: string,
  o: HostOptions,
  sessions: SessionStore,
  key: string | undefined = headerKey(headers),
): string | undefined {
  if (!sessionHosts(o).includes(host) || key === undefined) return undefined;
  return sessions.findSession(readCookies(headers.cookie, SESSION_COOKIE), key, host);
}

function headerKey(headers: {
  "x-webhub-session"?: string | string[] | undefined;
}): string | undefined {
  const v = headers[SESSION_HEADER];
  return typeof v === "string" ? v : undefined;
}

export type UpgradeResult =
  | {
      ok: true;
      host: string;
      auth: Exclude<AuthKind, "none">;
      /** Subprotocol to answer with (`webhub.v1` when offered), never the key one. */
      protocol: string | undefined;
    }
  | {
      ok: false;
      status: 401 | 403 | 421;
      reason: string;
      /** Wrong bearer token: the caller waits 50 ms before answering (as HTTP — §3.3). */
      delay: boolean;
    };

/**
 * Same rules as an unsafe HTTP request (an upgrade is never "safe"): one allowed API Host,
 * valid bearer or a session for that host (cookie + key from the `x-webhub-session` header or
 * the `webhub-key.<key>` + `webhub.v1` subprotocols), and same-origin (Origin required with a
 * session). The caller answers with `protocol`, never the key subprotocol.
 */
export function checkUpgrade(
  req: UpgradeRequest,
  o: HostOptions & { token: string; sessions: SessionStore },
): UpgradeResult {
  const no = (status: 401 | 403 | 421, reason: string, delay = false) =>
    ({ ok: false, status, reason, delay }) as const;
  if (hostHeaderCount(req.rawHeaders) !== 1) return no(421, "unknown host");
  const h = classifyHost(req.headers.host, o);
  if (h === undefined || h.kind !== "api") return no(421, "unknown host");
  let auth: Exclude<AuthKind, "none">;
  if (req.headers.authorization !== undefined) {
    const t = parseBearer(req.headers.authorization);
    if (t === undefined || !safeEqual(t, o.token)) return no(401, "not authorized", true);
    auth = "bearer";
  } else if (
    sessionFor(
      req.headers,
      h.host,
      o,
      o.sessions,
      headerKey(req.headers) ?? keyFromSubprotocols(req.headers["sec-websocket-protocol"]),
    ) !== undefined
  ) {
    auth = "session";
  } else {
    return no(401, "not authorized");
  }
  const site = req.headers["sec-fetch-site"];
  const problem = csrfProblem(
    "UPGRADE",
    { origin: req.headers.origin, "sec-fetch-site": typeof site === "string" ? site : undefined },
    h.host,
    auth,
  );
  if (problem !== undefined) return no(403, problem);
  const offered = req.headers["sec-websocket-protocol"];
  const protocol =
    typeof offered === "string" && offered.split(",").some((p) => p.trim() === WS_PROTOCOL)
      ? WS_PROTOCOL
      : undefined;
  return { ok: true, host: h.host, auth, protocol };
}

// ---------- sessions + login codes (in memory) ----------

interface Session {
  host: string;
  key: string;
  created: number;
  lastSeen: number;
}

interface LoginCode {
  host: string;
  expires: number;
}

/** In-memory sessions and one-time login codes. Daemon restart = everything gone. */
export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #codes = new Map<string, LoginCode>();
  constructor(private readonly now: () => number = Date.now) {}

  createCode(host: string): { code: string; expiresAt: number } {
    this.#sweep();
    if (this.#codes.size >= MAX_CODES) {
      const oldest = this.#codes.keys().next().value;
      if (oldest !== undefined) this.#codes.delete(oldest);
    }
    const code = randomId();
    const expiresAt = this.now() + LOGIN_CODE_TTL_MS;
    this.#codes.set(code, { host, expires: expiresAt });
    return { code, expiresAt };
  }

  /** Single use: the code is gone after this call, valid or not for this host. */
  consumeCode(code: string, host: string): boolean {
    if (!isId(code)) return false;
    const c = this.#codes.get(code);
    if (c === undefined) return false;
    this.#codes.delete(code);
    return c.host === host && this.now() <= c.expires;
  }

  /** New session: `id` goes into the cookie, `key` to the page (URL fragment → sessionStorage). */
  createSession(host: string): { id: string; key: string } {
    this.#sweep();
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest !== undefined) this.#sessions.delete(oldest);
    }
    const id = randomId();
    const key = randomId();
    const t = this.now();
    this.#sessions.set(id, { host, key, created: t, lastSeen: t });
    return { id, key };
  }

  /**
   * The id (one of the cookie values) of a live session for exactly this host whose key equals
   * `key`; refreshes its idle time. Undefined when none matches.
   */
  findSession(ids: readonly string[], key: string, host: string): string | undefined {
    if (!isId(key)) return undefined;
    const t = this.now();
    for (const id of ids) {
      if (!isId(id)) continue;
      const s = this.#sessions.get(id);
      if (s === undefined) continue;
      if (t - s.lastSeen > SESSION_IDLE_MS || t - s.created > SESSION_MAX_MS) {
        this.#sessions.delete(id);
        continue;
      }
      if (s.host !== host || !safeEqual(s.key, key)) continue;
      s.lastSeen = t;
      return id;
    }
    return undefined;
  }

  deleteSession(id: string | undefined): void {
    if (id !== undefined) this.#sessions.delete(id);
  }

  get sizes(): { sessions: number; codes: number } {
    return { sessions: this.#sessions.size, codes: this.#codes.size };
  }

  #sweep(): void {
    const t = this.now();
    for (const [k, c] of this.#codes) if (t > c.expires) this.#codes.delete(k);
    for (const [k, s] of this.#sessions) {
      if (t - s.lastSeen > SESSION_IDLE_MS || t - s.created > SESSION_MAX_MS) {
        this.#sessions.delete(k);
      }
    }
  }
}
