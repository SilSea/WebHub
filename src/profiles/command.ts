/**
 * Profile commands (`start.cmd`, `runtime.install`, `container.setup`) — F-005 §3.1, Q5.
 *
 * A command is ONE string split into argv here; it never goes through a shell. On Windows a
 * `.cmd` / `.bat` program (npm.cmd, …) is still run by cmd.exe, which interprets `& | < > ^ %`
 * and friends inside arguments — so those characters are refused everywhere, quoted or not, and
 * so are the values put into placeholders.
 */

export const MAX_COMMAND_LENGTH = 1000;
export const MAX_ARGS = 64;

/** Placeholders every command may use; others must be declared in `start.vars`. */
export const BUILTIN_PLACEHOLDERS = ["PORT", "HOST"] as const;

/**
 * Printable ASCII only (space included): no control / C1 characters, no tab, no bidi,
 * zero-width, NBSP or fullwidth look-alikes (`＂` becomes `"` under Windows best-fit) — the
 * command shown at run approval is the one that runs (review-1 K7, security-1 S3).
 */
const PRINTABLE = /^[\x20-\x7e]*$/;
/** Characters a shell (cmd.exe or sh) would interpret. */
const UNSAFE = /[&|;<>()`$^%!\\]/;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,31})\}/g;
/** Value of a placeholder: no spaces, quotes, shell characters; never an option (`-x`). */
const VALUE = /^[A-Za-z0-9._:@/+=][A-Za-z0-9._:@/+=-]{0,199}$/;
export const VAR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Splits a command into arguments: spaces separate, `"..."` or `'...'` around a WHOLE argument
 * keep spaces together (no escapes, no other quote inside). Throws CommandError on a
 * non-printable / non-ASCII or shell character, a misplaced or unclosed quote, a stray `{` /
 * `}`, an option as the program, or a command that is empty / too long.
 */
export function splitCommand(cmd: string): string[] {
  if (cmd.length === 0 || cmd.length > MAX_COMMAND_LENGTH) {
    throw new CommandError(`command must be 1–${MAX_COMMAND_LENGTH} characters`);
  }
  if (!PRINTABLE.test(cmd)) {
    throw new CommandError("command must be printable ASCII (no control or non-ASCII characters)");
  }
  if (UNSAFE.test(cmd)) {
    throw new CommandError(
      "command contains a shell character (& | ; < > ( ) ` $ ^ % ! or backslash); commands never run through a shell",
    );
  }
  const misplaced = () =>
    new CommandError("quotes must enclose a whole argument and hold no other quote");
  const args: string[] = [];
  let cur = "";
  let inArg = false;
  let quote: string | undefined;
  let closed = false;
  for (const ch of cmd) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
        closed = true;
      } else if (ch === '"' || ch === "'") {
        throw misplaced();
      } else {
        cur += ch;
      }
    } else if (ch === " ") {
      if (inArg) args.push(cur);
      cur = "";
      inArg = false;
      closed = false;
    } else if (closed) {
      throw misplaced(); // `"a"b`
    } else if (ch === '"' || ch === "'") {
      if (inArg) throw misplaced(); // `a"b"`
      quote = ch;
      inArg = true;
    } else {
      cur += ch;
      inArg = true;
    }
  }
  if (quote !== undefined) throw new CommandError("command has an unclosed quote");
  if (inArg) args.push(cur);
  if (args.length === 0) throw new CommandError("command is empty");
  if (args.length > MAX_ARGS) throw new CommandError(`command has more than ${MAX_ARGS} arguments`);
  if (args[0] === "" || args[0]?.startsWith("-") === true) {
    throw new CommandError("command must start with a program name");
  }
  for (const a of args) {
    // braces only as whole placeholders
    if (/[{}]/.test(a.replace(PLACEHOLDER, ""))) {
      throw new CommandError(`stray "{" or "}" in argument (placeholders look like {PORT})`);
    }
  }
  return args;
}

/** Names of the placeholders a command uses. */
export function placeholdersOf(cmd: string): string[] {
  return [...new Set([...cmd.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ""))];
}

/** True when `value` may be put into a placeholder. */
export function isSafeValue(value: string): boolean {
  return VALUE.test(value) && !namesNonLoopback(value);
}

/**
 * True when an argument or value names a non-loopback bind address: `0.0.0.0`, `::`, `[::]`,
 * or an IPv4 literal outside 127/8 (security-1 S4). Host names are left to the run approval
 * and the listener check (F-007 / F-017).
 */
export function namesNonLoopback(text: string): boolean {
  if (text.includes("[::]") || /(^|[=:,@ ])::($|[ ,/])/.test(text) || text === "::") return true;
  for (const m of text.matchAll(/(?<![0-9.])(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![0-9.])/g)) {
    if (m[1] !== "127") return true;
  }
  return false;
}

/**
 * argv of `cmd` with its placeholders replaced. A value replaces text inside one argument and
 * never splits it. Throws CommandError on a missing / unsafe value.
 */
export function renderCommand(cmd: string, values: Readonly<Record<string, string>>): string[] {
  return splitCommand(cmd).map((arg) =>
    arg.replace(PLACEHOLDER, (_m, name: string) => {
      const v = Object.hasOwn(values, name) ? values[name] : undefined;
      if (v === undefined) throw new CommandError(`no value for placeholder {${name}}`);
      if (!isSafeValue(v)) throw new CommandError(`unsafe value for placeholder {${name}}`);
      return v;
    }),
  );
}
