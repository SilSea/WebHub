export type ErrorCode =
  | "HOME_INVALID"
  | "CONFIG_INVALID"
  | "CONFIG_FROM_NEWER_VERSION"
  | "JSON_PARSE"
  | "LOCKED"
  | "NOT_LOCKED"
  | "SYMLINK_REFUSED"
  | "PATH_OUTSIDE_HOME"
  | "FILE_TOO_LARGE"
  | "SECRET_BACKEND";

export interface WebhubErrorOptions {
  file?: string;
  hint?: string;
  details?: readonly string[];
  cause?: unknown;
}

/**
 * Every error webhub raises on purpose. Messages must never contain secret values
 * (WORKFLOW §8 — Secrets).
 */
export class WebhubError extends Error {
  readonly code: ErrorCode;
  readonly file: string | undefined;
  readonly hint: string | undefined;
  readonly details: readonly string[];

  constructor(code: ErrorCode, message: string, opts: WebhubErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "WebhubError";
    this.code = code;
    this.file = opts.file;
    this.hint = opts.hint;
    this.details = opts.details ?? [];
  }
}

export function isWebhubError(err: unknown, code?: ErrorCode): err is WebhubError {
  return err instanceof WebhubError && (code === undefined || err.code === code);
}
