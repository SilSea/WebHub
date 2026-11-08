/**
 * Client of the daemon API, used by the CLI (F-004). Before the token is ever sent, the
 * server must prove it knows it (F-003 §3.5): any other program listening on the API port
 * while the daemon is down gets a nonce, never the token.
 *
 * The proof is bound to ONE TCP connection (security-3 N2): every `request()` opens a fresh
 * keep-alive connection, proves the daemon on it, then sends the bearer on that same
 * connection. If that connection is gone, the request fails — the token never travels on a
 * connection that has not proven itself (a program that grabs the port after the daemon
 * stopped gets only nonces).
 */
import { randomBytes } from "node:crypto";
import { Agent, type ClientRequestArgs, request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import type { Paths } from "../config/home.js";
import { readDoc } from "../store/json-store.js";
import { helloProof, safeEqual } from "./auth.js";
import { type AuthFile, authFileSpec } from "./auth-file.js";
import { isServerError, ServerError } from "./errors.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface RawResponse {
  status: number;
  body: unknown;
}

export interface SendOptions {
  /** Overall deadline (default 10 s — not only idle time, H13). */
  timeoutMs?: number;
  /** Connection to use (default: a new one, closed after the response). */
  agent?: Agent;
}

export type SendFn = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  opts?: SendOptions,
) => Promise<RawResponse>;

/**
 * Keep-alive agent that opens at most ONE connection. A second attempt (the proven connection
 * was closed) fails before a single byte is written.
 */
export class OneConnectionAgent extends Agent {
  #opened = false;
  constructor() {
    super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    if (this.#opened) {
      const err = Object.assign(new Error("connection lost after the daemon proof"), {
        code: "EPROOFLOST",
      });
      process.nextTick(() => callback?.(err, undefined as never));
      return undefined;
    }
    this.#opened = true;
    // biome-ignore lint/suspicious/noExplicitAny: Agent#createConnection is untyped on the base
    return (Agent.prototype as any).createConnection.call(this, options, callback);
  }
}

const send: SendFn = (port, method, path, headers, body, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          ...headers,
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }),
        },
        timeout: timeoutMs,
        agent: opts.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try {
            parsed = text === "" ? undefined : JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", reject);
      },
    );
    // overall deadline, not only socket idle time: a slow-drip server cannot stall us (H13)
    const deadline = setTimeout(
      () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () =>
      req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
    );
    req.on("error", reject);
    req.end(body);
  });
};

const notRunning = () =>
  new ServerError("DAEMON_NOT_RUNNING", "the webhub daemon is not running", {
    hint: "Start it (webhub daemon start).",
  });

function unreachable(err: unknown): ServerError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return notRunning();
  return new ServerError("DAEMON_UNREACHABLE", "could not talk to the webhub daemon", {
    details: [code ?? (err instanceof Error ? err.name : "error")],
  });
}

export class DaemonClient {
  #auth: AuthFile;
  /**
   * @param reload re-reads auth.json (undefined = gone). When the proof fails (wrong proof or
   *   refused), the daemon may have restarted with a new token / port: the client reloads once
   *   and proves again before giving up (J7, M6). The token is never sent before a proof.
   */
  constructor(
    auth: AuthFile,
    private readonly sendFn: SendFn = send,
    private readonly reload?: () => Promise<AuthFile | undefined>,
  ) {
    this.#auth = auth;
  }

  get port(): number {
    return this.#auth.port;
  }

  /** Proves the server on the port is the daemon that wrote auth.json (no token sent). */
  async verify(): Promise<void> {
    await this.#withProof(async () => undefined);
  }

  /** Authenticated JSON request, on the connection that was just proven. Non-2xx → API_ERROR. */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#withProof(async (agent) => {
      try {
        return await this.sendFn(
          this.#auth.port,
          method,
          path,
          { authorization: `Bearer ${this.#auth.token}` },
          body === undefined ? undefined : JSON.stringify(body),
          { agent },
        );
      } catch (err) {
        throw unreachable(err);
      }
    });
    if (res.status >= 200 && res.status < 300) return res.body as T;
    const e = (res.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    throw new ServerError(
      "API_ERROR",
      typeof e?.message === "string" ? e.message : `daemon answered HTTP ${res.status}`,
      {
        status: res.status,
        ...(typeof e?.code === "string" ? { apiCode: e.code } : {}),
      },
    );
  }

  /** New connection → proof (reload auth.json once if it fails) → `fn` on that connection. */
  async #withProof<T>(fn: (agent: OneConnectionAgent) => Promise<T>): Promise<T> {
    let agent = new OneConnectionAgent();
    try {
      try {
        await this.#prove(agent);
      } catch (err) {
        if (
          this.reload === undefined ||
          !(isServerError(err, "DAEMON_IMPOSTOR") || isServerError(err, "DAEMON_NOT_RUNNING"))
        ) {
          throw err;
        }
        // only "file gone" means not running; an unsafe / corrupt file surfaces as is (M7)
        const fresh = await this.reload();
        if (fresh === undefined) throw notRunning();
        if (fresh.token === this.#auth.token && fresh.port === this.#auth.port) throw err;
        this.#auth = fresh;
        agent.destroy();
        agent = new OneConnectionAgent();
        await this.#prove(agent);
      }
      return await fn(agent);
    } finally {
      agent.destroy();
    }
  }

  async #prove(agent: OneConnectionAgent): Promise<void> {
    const { port, token } = this.#auth;
    const nonce = randomBytes(32).toString("base64url");
    let res: RawResponse;
    try {
      res = await this.sendFn(port, "GET", `/api/v1/hello?n=${nonce}`, {}, undefined, { agent });
    } catch (err) {
      throw unreachable(err);
    }
    const proof = (res.body as { proof?: unknown } | undefined)?.proof;
    if (
      res.status !== 200 ||
      typeof proof !== "string" ||
      !safeEqual(proof, helloProof(token, nonce))
    ) {
      throw new ServerError(
        "DAEMON_IMPOSTOR",
        `the program on port ${port} is not the webhub daemon (token not sent)`,
        {
          hint: "The daemon is probably not running and another program uses its port. Start webhub again; if this repeats, check which program listens on that port.",
        },
      );
    }
  }
}

/**
 * Reads `data/auth.json` (missing → DAEMON_NOT_RUNNING) and returns a client that re-reads it
 * when the daemon restarted. The daemon writes auth.json just before it listens, so right
 * after a start the port may refuse for a moment (DAEMON_NOT_RUNNING) — F-004 retries until
 * `auth.pid` is the process it spawned (review-1 H16). A file left by a crash + refused port =
 * not running (K2).
 */
export async function connectDaemon(paths: Paths): Promise<DaemonClient> {
  const read = async () => (await readDoc(paths.auth, authFileSpec, { home: paths.home }))?.value;
  const auth = await read();
  if (auth === undefined) throw notRunning();
  return new DaemonClient(auth, send, read);
}

export { send as sendRaw };
