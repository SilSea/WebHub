/**
 * Client of the daemon API, used by the CLI (F-004). Before the token is ever sent, the
 * server must prove it knows it (F-003 §3.5): any other program listening on the API port
 * while the daemon is down gets a nonce, never the token.
 */
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Paths } from "../config/home.js";
import { readDoc } from "../store/json-store.js";
import { helloProof, safeEqual } from "./auth.js";
import { type AuthFile, authFileSpec } from "./auth-file.js";
import { ServerError } from "./errors.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

interface RawResponse {
  status: number;
  body: unknown;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs = TIMEOUT_MS,
): Promise<RawResponse> {
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
        agent: false,
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
}

function unreachable(err: unknown): ServerError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return notRunning();
  return new ServerError("DAEMON_UNREACHABLE", "could not talk to the webhub daemon", {
    details: [code ?? (err instanceof Error ? err.message : "error")],
  });
}

const notRunning = () =>
  new ServerError("DAEMON_NOT_RUNNING", "the webhub daemon is not running", {
    hint: "Start it (webhub daemon start).",
  });

export type SendFn = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
) => Promise<RawResponse>;

export class DaemonClient {
  #verified = false;
  #auth: AuthFile;
  /**
   * @param reload re-reads auth.json (undefined = gone). When a proof fails, the daemon may
   *   have restarted with a new token: the client reloads once before reporting an impostor (J7).
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
    if (this.#verified) return;
    try {
      await this.#prove();
    } catch (err) {
      if (this.reload === undefined) throw err;
      const fresh = await this.reload().catch(() => undefined);
      if (fresh === undefined) throw notRunning();
      if (fresh.token === this.#auth.token && fresh.port === this.#auth.port) throw err;
      this.#auth = fresh;
      await this.#prove();
    }
    this.#verified = true;
  }

  async #prove(): Promise<void> {
    const { port, token } = this.#auth;
    const nonce = randomBytes(32).toString("base64url");
    let res: RawResponse;
    try {
      res = await this.sendFn(port, "GET", `/api/v1/hello?n=${nonce}`, {}, undefined);
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

  /** Authenticated JSON request. Non-2xx → API_ERROR with the API's error code. */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    await this.verify();
    let res: RawResponse;
    try {
      res = await this.sendFn(
        this.#auth.port,
        method,
        path,
        { authorization: `Bearer ${this.#auth.token}` },
        body === undefined ? undefined : JSON.stringify(body),
      );
    } catch (err) {
      // the daemon may have restarted (new token) or another program took the port: prove again
      this.#verified = false;
      throw unreachable(err);
    }
    if (res.status === 401) this.#verified = false;
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
}

/**
 * Reads `data/auth.json` (missing → DAEMON_NOT_RUNNING) and returns a client.
 * The daemon writes auth.json just before it listens, so right after a start the port may
 * refuse for a moment (DAEMON_NOT_RUNNING) — F-004 retries until `auth.pid` is the process it
 * spawned (review-1 H16). A file left by a crash + refused port = not running (K2).
 */
export async function connectDaemon(paths: Paths): Promise<DaemonClient> {
  const read = async () => (await readDoc(paths.auth, authFileSpec, { home: paths.home }))?.value;
  const auth = await read();
  if (auth === undefined) throw notRunning();
  return new DaemonClient(auth, send, read);
}

export { send as sendRaw };
