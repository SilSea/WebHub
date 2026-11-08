/**
 * Pure auth building blocks of the API (F-003 §3.2–3.5, DESIGN §10.3). No I/O here, so every
 * rule is unit-tested without a server.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "webhub_session";
export const INTERNAL_HOST = "webhub.internal";
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_CODE_TTL_MS = 60_000;
const MAX_SESSIONS = 1000;
const MAX_CODES = 100;

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
 * cookies are not port-scoped, so a cookie for `127.0.0.1` would also be sent to every
 * project dev server on `http://127.0.0.1:<any port>`. `127.0.0.1:<apiPort>` = bearer only.
 * Known limit: a hub./db. cookie is likewise sent to `hub.<suffix>:<other port>` if the user
 * ever opens such a URL served by another program.
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

// ---------- cookies ----------

/** Value of `name` in a Cookie header; duplicates → undefined (ambiguous). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  let found: string | undefined;
  let count = 0;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    count++;
    found = part.slice(eq + 1).trim();
  }
  return count === 1 ? found : undefined;
}

/** Host-only (no Domain), HttpOnly, SameSite=Strict session cookie. */
export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`;
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
  };
}

export type UpgradeResult =
  | { ok: true; host: string; auth: Exclude<AuthKind, "none"> }
  | { ok: false; status: 401 | 403 | 421; reason: string };

/**
 * Same rules as an unsafe HTTP request (an upgrade is never "safe"): one allowed API Host,
 * valid bearer or a session for that host, and same-origin (Origin required with a cookie).
 */
export function checkUpgrade(
  req: UpgradeRequest,
  o: HostOptions & { token: string; sessions: SessionStore },
): UpgradeResult {
  if (hostHeaderCount(req.rawHeaders) !== 1)
    return { ok: false, status: 421, reason: "unknown host" };
  const h = classifyHost(req.headers.host, o);
  if (h === undefined || h.kind !== "api")
    return { ok: false, status: 421, reason: "unknown host" };
  let auth: Exclude<AuthKind, "none">;
  if (req.headers.authorization !== undefined) {
    const t = parseBearer(req.headers.authorization);
    if (t === undefined || !safeEqual(t, o.token))
      return { ok: false, status: 401, reason: "not authorized" };
    auth = "bearer";
  } else if (
    sessionHosts(o).includes(h.host) &&
    o.sessions.checkSession(readCookie(req.headers.cookie, SESSION_COOKIE), h.host)
  ) {
    auth = "session";
  } else {
    return { ok: false, status: 401, reason: "not authorized" };
  }
  const site = req.headers["sec-fetch-site"];
  const problem = csrfProblem(
    "UPGRADE",
    { origin: req.headers.origin, "sec-fetch-site": typeof site === "string" ? site : undefined },
    h.host,
    auth,
  );
  if (problem !== undefined) return { ok: false, status: 403, reason: problem };
  return { ok: true, host: h.host, auth };
}

// ---------- sessions + login codes (in memory) ----------

interface Session {
  host: string;
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

  createSession(host: string): string {
    this.#sweep();
    if (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest !== undefined) this.#sessions.delete(oldest);
    }
    const id = randomId();
    const t = this.now();
    this.#sessions.set(id, { host, created: t, lastSeen: t });
    return id;
  }

  /** Valid session for exactly this host (refreshes idle time). */
  checkSession(id: string | undefined, host: string): boolean {
    if (!isId(id)) return false;
    const s = this.#sessions.get(id);
    if (s === undefined) return false;
    const t = this.now();
    if (t - s.lastSeen > SESSION_IDLE_MS || t - s.created > SESSION_MAX_MS) {
      this.#sessions.delete(id);
      return false;
    }
    if (s.host !== host) return false;
    s.lastSeen = t;
    return true;
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
