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

/** Characters a shell (cmd.exe or sh) would interpret, plus control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
const UNSAFE = /[&|;<>()`$^%!\\\n\r\u0000-\u001f\u007f]/;
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
 * Splits a command into arguments: whitespace separates, `"..."` or `'...'` keep spaces
 * together (no escapes inside). Throws CommandError on a shell character, an unclosed quote,
 * a stray `{` / `}`, or a command that is empty / too long.
 */
export function splitCommand(cmd: string): string[] {
  if (cmd.length === 0 || cmd.length > MAX_COMMAND_LENGTH) {
    throw new CommandError(`command must be 1–${MAX_COMMAND_LENGTH} characters`);
  }
  if (UNSAFE.test(cmd)) {
    throw new CommandError(
      "command contains a shell character (& | ; < > ( ) ` $ ^ % ! \\ or a control character); commands never run through a shell",
    );
  }
  const args: string[] = [];
  let cur = "";
  let inArg = false;
  let quote: string | undefined;
  for (const ch of cmd) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inArg = true;
    } else if (ch === " " || ch === "\t") {
      if (inArg) args.push(cur);
      cur = "";
      inArg = false;
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
  return VALUE.test(value);
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
