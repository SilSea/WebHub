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
        timeout: TIMEOUT_MS,
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
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function unreachable(err: unknown): ServerError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") {
    return new ServerError("DAEMON_NOT_RUNNING", "the webhub daemon is not running", {
      hint: "Start it (webhub daemon start).",
    });
  }
  return new ServerError("DAEMON_UNREACHABLE", "could not talk to the webhub daemon", {
    details: [code ?? (err instanceof Error ? err.message : "error")],
  });
}

export class DaemonClient {
  #verified = false;
  constructor(
    private readonly auth: AuthFile,
    private readonly sendFn: typeof send = send,
  ) {}

  get port(): number {
    return this.auth.port;
  }

  /** Proves the server on the port is the daemon that wrote auth.json (no token sent). */
  async verify(): Promise<void> {
    if (this.#verified) return;
    const nonce = randomBytes(32).toString("base64url");
    let res: RawResponse;
    try {
      res = await this.sendFn(this.auth.port, "GET", `/api/v1/hello?n=${nonce}`, {}, undefined);
    } catch (err) {
      throw unreachable(err);
    }
    const proof = (res.body as { proof?: unknown } | undefined)?.proof;
    if (
      res.status !== 200 ||
      typeof proof !== "string" ||
      !safeEqual(proof, helloProof(this.auth.token, nonce))
    ) {
      throw new ServerError(
        "DAEMON_IMPOSTOR",
        `the program on port ${this.auth.port} is not the webhub daemon (token not sent)`,
        {
          hint: "The daemon is probably not running and another program uses its port. Start webhub again; if this repeats, check which program listens on that port.",
        },
      );
    }
    this.#verified = true;
  }

  /** Authenticated JSON request. Non-2xx → API_ERROR with the API's error code. */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    await this.verify();
    let res: RawResponse;
    try {
      res = await this.sendFn(
        this.auth.port,
        method,
        path,
        { authorization: `Bearer ${this.auth.token}` },
        body === undefined ? undefined : JSON.stringify(body),
      );
    } catch (err) {
      throw unreachable(err);
    }
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

/** Reads `data/auth.json` (missing → DAEMON_NOT_RUNNING) and returns a client. */
export async function connectDaemon(paths: Paths): Promise<DaemonClient> {
  const res = await readDoc(paths.auth, authFileSpec, { home: paths.home });
  if (res === undefined) {
    throw new ServerError("DAEMON_NOT_RUNNING", "the webhub daemon is not running", {
      hint: "Start it (webhub daemon start).",
    });
  }
  return new DaemonClient(res.value);
}

export { send as sendRaw };
