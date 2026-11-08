/**
 * Errors of the daemon / API client (F-003). Kept separate from F-001's `WebhubError`
 * (adding codes there = changing a `done` feature, R1) — same pattern as `PlatformError`.
 * Messages never contain the token, login codes or session ids.
 */
export type ServerErrorCode =
  | "DAEMON_RUNNING"
  | "DAEMON_PORT_BUSY"
  | "DAEMON_NOT_RUNNING"
  | "DAEMON_IMPOSTOR"
  | "DAEMON_UNREACHABLE"
  | "API_ERROR";

export interface ServerErrorOptions {
  hint?: string;
  details?: readonly string[];
  /** HTTP status (API_ERROR). */
  status?: number;
  /** Error code returned by the API (API_ERROR). */
  apiCode?: string;
  cause?: unknown;
}

export class ServerError extends Error {
  readonly code: ServerErrorCode;
  readonly hint: string | undefined;
  readonly details: readonly string[];
  readonly status: number | undefined;
  readonly apiCode: string | undefined;

  constructor(code: ServerErrorCode, message: string, opts: ServerErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ServerError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details ?? [];
    this.status = opts.status;
    this.apiCode = opts.apiCode;
  }
}

export function isServerError(err: unknown, code?: ServerErrorCode): err is ServerError {
  return err instanceof ServerError && (code === undefined || err.code === code);
}
