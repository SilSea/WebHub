/**
 * CLI output helpers (F-004 §3.1): exit codes, error lines, terminal sanitising.
 */
import { WebhubError } from "../errors.js";
import { PlatformError } from "../platform/index.js";
import { ServerError } from "../server/errors.js";

/** Exit codes of every CLI command (F-004 §3.1). */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  notRunning: 3,
  portBusy: 4,
} as const;

/** An error the CLI reports with its own exit code. Messages never hold secrets. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly details: readonly string[];
  readonly hint: string | undefined;

  constructor(
    exitCode: number,
    code: string,
    message: string,
    opts: { details?: readonly string[]; hint?: string } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = opts.details ?? [];
    this.hint = opts.hint;
  }
}

export const usageError = (message: string) =>
  new CliError(EXIT.usage, "USAGE", message, { hint: "Run 'webhub --help' for usage." });

export function exitCodeOf(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof ServerError) {
    if (err.code === "DAEMON_NOT_RUNNING") return EXIT.notRunning;
    if (err.code === "DAEMON_PORT_BUSY") return EXIT.portBusy;
    return EXIT.error;
  }
  if (
    err instanceof WebhubError &&
    (err.code === "CONFIG_INVALID" ||
      err.code === "CONFIG_FROM_NEWER_VERSION" ||
      err.code === "JSON_PARSE" ||
      err.code === "HOME_INVALID")
  ) {
    return EXIT.usage;
  }
  return EXIT.error;
}

export function errorCode(err: unknown): string {
  if (err instanceof CliError || err instanceof ServerError || err instanceof WebhubError) {
    return err.code;
  }
  if (err instanceof PlatformError) return err.code;
  return "INTERNAL";
}

/** Human error lines: message, details, hint — all sanitised. Unknown errors: class name only. */
export function errorLines(err: unknown): string[] {
  if (
    err instanceof CliError ||
    err instanceof ServerError ||
    err instanceof WebhubError ||
    err instanceof PlatformError
  ) {
    const details = "details" in err ? (err.details as readonly string[]) : [];
    const hint = "hint" in err ? (err.hint as string | undefined) : undefined;
    // with details, the first message line is enough (CONFIG_INVALID repeats them)
    const message = details.length > 0 ? (err.message.split("\n")[0] ?? "") : err.message;
    return [
      `webhub: ${sanitize(message)}`,
      ...details.map((d) => `  - ${sanitize(d)}`),
      ...(hint === undefined ? [] : [`  hint: ${sanitize(hint)}`]),
    ];
  }
  // never print an unexpected message / stack: it may hold anything (F-003 H2)
  return [`webhub: internal error (${err instanceof Error ? err.name : typeof err})`];
}

/**
 * Text from the daemon or its log is attacker-influenced (request paths from browsers):
 * removes C0 / C1 control characters (ESC sequences, CR, BEL, …; tab kept), DEL, line /
 * paragraph separators and bidi overrides before it reaches the terminal (F-004 §6).
 */
export function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += UNSAFE.some(([lo, hi]) => c >= lo && c <= hi) ? "?" : ch;
  }
  return out;
}

/** Code point ranges replaced by `sanitize` (tab 0x09 is kept). */
const UNSAFE: readonly (readonly [number, number])[] = [
  [0x00, 0x08], // C0
  [0x0a, 0x1f], // C0 incl. LF, CR, ESC
  [0x7f, 0x9f], // DEL + C1 (incl. 8-bit CSI 0x9b)
  [0x2028, 0x2029], // line / paragraph separator
  [0x202a, 0x202e], // bidi embeddings / overrides
  [0x2066, 0x2069], // bidi isolates
];
