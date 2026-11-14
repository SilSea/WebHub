#!/usr/bin/env node
/**
 * webhub CLI (F-004): a thin client of the daemon (DESIGN §13). Commands live in
 * `src/cli/`; this file parses the global options and dispatches.
 *
 * Exit codes: 0 ok, 1 error / unknown command, 2 bad usage or config, 3 daemon not running,
 * 4 API port busy.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { daemonCommand } from "./cli/daemon-command.js";
import { abandonStart } from "./cli/daemon-control.js";
import { errorJson, errorLines, exitCodeOf, sanitize } from "./cli/output.js";
import { type Paths, pathsFor, resolveHome } from "./config/home.js";
import { readVersion } from "./version.js";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Aborted by Ctrl+C: ends `logs -f`. */
  signal?: AbortSignal;
  /** Called by a command that ends cleanly on `signal` (Ctrl+C must not just exit). */
  onFollow?: () => void;
}

export interface CommandContext {
  io: Io;
  env: NodeJS.ProcessEnv;
  json: boolean;
  noStart: boolean;
  signal: AbortSignal;
  /** The command handles Ctrl+C through `signal` (long-running: `logs -f`). */
  following(): void;
  /** Resolved lazily: `--help` works without a valid WEBHUB_HOME. */
  paths(): Paths;
}

interface Command {
  summary: string;
  usage: string;
  run(args: string[], ctx: CommandContext): Promise<number>;
}

const COMMANDS: Record<string, Command> = {
  daemon: daemonCommand,
};

const HELP = `webhub — local hub for web projects

Usage:
  webhub [--json] [--no-start] <command> [options]
  webhub --version | --help
  webhub <command> --help

Commands:
${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`)
  .join("\n")}

Global options:
  --json       machine-readable output (one JSON line)
  --no-start   do not start the daemon automatically (also WEBHUB_NO_AUTOSTART=1)

Exit codes: 0 ok, 1 error, 2 bad usage / config, 3 daemon not running, 4 API port busy.`;

/** Runs the CLI and resolves to the process exit code. */
export async function run(argv: readonly string[], io: Io, opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  // global options come before the command; everything after it belongs to the command
  const firstCmd = argv.findIndex((a) => !a.startsWith("-"));
  const globalArgs = firstCmd === -1 ? [...argv] : argv.slice(0, firstCmd);
  const rest = firstCmd === -1 ? [] : argv.slice(firstCmd);
  let values: { help?: boolean; version?: boolean; json?: boolean; "no-start"?: boolean };
  try {
    ({ values } = parseArgs({
      args: globalArgs,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        json: { type: "boolean" },
        "no-start": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    io.err(`webhub: unknown command or option: ${sanitize(globalArgs.join(" "))}`);
    io.err("Run 'webhub --help' for usage.");
    return 1;
  }
  if (values.version === true) {
    io.out(readVersion());
    return 0;
  }
  const [name, ...args] = rest;
  if (values.help === true || name === undefined) {
    io.out(HELP);
    return 0;
  }
  const cmd = COMMANDS[name];
  if (cmd === undefined) {
    io.err(`webhub: unknown command or option: ${sanitize(name)}`);
    io.err("Run 'webhub --help' for usage.");
    return 1;
  }
  const json = values.json === true;
  let paths: Paths | undefined;
  const ctx: CommandContext = {
    io,
    env,
    json,
    noStart: values["no-start"] === true || env.WEBHUB_NO_AUTOSTART === "1",
    signal: opts.signal ?? new AbortController().signal,
    following: () => opts.onFollow?.(),
    paths: () => {
      paths ??= pathsFor(resolveHome(env, process.platform, homedir()));
      return paths;
    },
  };
  try {
    return await cmd.run(args, ctx);
  } catch (err) {
    if (json) {
      io.err(errorJson(err));
    } else {
      for (const line of errorLines(err)) io.err(line);
    }
    return exitCodeOf(err);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    // `node dist/cli` (no extension) resolves to the same file
    return [entry, `${entry}.js`].some((p) => {
      try {
        return realpathSync(p) === self;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

if (isMain()) {
  const abort = new AbortController();
  // Ctrl+C: exits, except while `logs -f` runs — there the first one ends it cleanly
  let following = false;
  process.on("SIGINT", () => {
    if (!following || abort.signal.aborted) {
      abandonStart(); // keep a start's stderr as daemon.err, no temp file left (review C11)
      process.exit(130);
    }
    abort.abort();
  });
  // `webhub daemon logs -f | head`: the reader went away — end quietly, not with a stack
  for (const stream of [process.stdout, process.stderr]) {
    // any other write error (closed console …): stop too, `logs -f` must not poll forever
    stream.on("error", (err: NodeJS.ErrnoException) => {
      process.exit(err.code === "EPIPE" ? (process.exitCode ?? 0) : 1);
    });
  }
  run(
    process.argv.slice(2),
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    {
      signal: abort.signal,
      onFollow: () => {
        following = true;
      },
    },
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // run() reports its own errors; this is only a last resort (never a stack)
      process.stderr.write(`${errorLines(err).join("\n")}\n`);
      process.exitCode = 1;
    },
  );
}
