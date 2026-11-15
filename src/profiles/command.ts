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

/** Options whose next argument (or `=value`) is a bind address. */
const HOST_OPTIONS = new Set([
  "--host",
  "--hostname",
  "-H",
  "--bind",
  "-b",
  "--listen",
  "--ip",
  "--addr",
  "--address",
  "--bind-address",
  "host",
  "hostname",
  "bind",
  "HOST",
  "HOSTNAME",
  "BIND",
]);
/** IPv4 as inet_aton reads it: 1–4 parts, decimal / octal (leading 0) / hex (0x). */
const INET_ATON = /^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}$/i;
const LOOPBACK_V4 =
  /^127\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){2}$/;
const DOTTED_QUAD = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;

/** An address literal in any form a resolver accepts, or undefined when `v` is not one. */
function addressLiteral(v: string, hostValue: boolean): "loopback" | "other" | undefined {
  let s = v.startsWith("[") && v.includes("]") ? v.slice(1, v.indexOf("]")) : v;
  if (/^[0-9a-f:.]+$/i.test(s) && (s.match(/:/g)?.length ?? 0) >= 2) {
    return s === "::1" ? "loopback" : "other"; // IPv6 (any spelling other than ::1)
  }
  // `addr:port` (one colon) → the address part
  const colon = s.indexOf(":");
  if (colon !== -1 && s.indexOf(":", colon + 1) === -1 && /^[0-9]+$/.test(s.slice(colon + 1))) {
    s = s.slice(0, colon);
  }
  // positional literals only as dotted quads (a lone `0` / `8000` is not an address); after a
  // host option every inet_aton form counts (`--host 0`, `-H 0x0`, `--host=0177.1`)
  if (!(hostValue ? INET_ATON.test(s) : DOTTED_QUAD.test(s))) return undefined;
  return LOOPBACK_V4.test(s) ? "loopback" : "other";
}

/**
 * True when a single value names a non-loopback address: a dotted quad outside 127/8 (also
 * `0127.0.0.1`), any IPv6 literal other than `::1` (`::`, `[::]`, `::0`, `0::`), with or
 * without `:port` (security-1 S4, review-2 L1). Version numbers like `x==0.110.0.1` or
 * `pkg=1.2.3.4-1` are not addresses (L5).
 */
export function namesNonLoopback(text: string): boolean {
  return addressLiteral(text, false) === "other";
}

/**
 * True when finished argv binds outside loopback: positional literals, and every address form
 * after a host option (`--host 0`, `--host=0x0`, `HOST=0.0`). Host names (`0.0.0.0.nip.io`)
 * are left to the run approval and the listener check (F-007 / F-017 — spec §3.4a).
 */
export function bindsNonLoopback(args: readonly string[]): boolean {
  for (const [i, arg] of args.entries()) {
    const eq = arg.indexOf("=");
    const key = eq === -1 ? undefined : arg.slice(0, eq);
    const value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (addressLiteral(arg, false) === "other") return true;
    if (
      value !== undefined &&
      addressLiteral(value, key !== undefined && HOST_OPTIONS.has(key)) === "other"
    ) {
      return true;
    }
    const next = args[i + 1];
    if (HOST_OPTIONS.has(arg) && next !== undefined && addressLiteral(next, true) === "other")
      return true;
  }
  return false;
}

/**
 * argv of `cmd` with its placeholders replaced. A value replaces text inside one argument and
 * never splits it. Throws CommandError on a missing / unsafe value, or when the finished argv
 * binds outside loopback (an address assembled from parts — review-2 L1).
 */
export function renderCommand(cmd: string, values: Readonly<Record<string, string>>): string[] {
  const args = splitCommand(cmd).map((arg) =>
    arg.replace(PLACEHOLDER, (_m, name: string) => {
      const v = Object.hasOwn(values, name) ? values[name] : undefined;
      if (v === undefined) throw new CommandError(`no value for placeholder {${name}}`);
      if (!isSafeValue(v)) throw new CommandError(`unsafe value for placeholder {${name}}`);
      return v;
    }),
  );
  if (bindsNonLoopback(args)) {
    throw new CommandError(
      "binds outside loopback (0.0.0.0, ::, a LAN address in any spelling); use {HOST}",
    );
  }
  return args;
}
