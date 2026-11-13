/**
 * `webhub daemon start | stop [--force] | status | logs [-n N] [-f]` (F-004 §3.1).
 */
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { CommandContext } from "../cli.js";
import { getPlatform } from "../platform/index.js";
import { isServerError } from "../server/errors.js";
import { daemonStatus, portOwners, startDaemonProcess, stopDaemon } from "./daemon-control.js";
import { followLogs, tailLogs } from "./daemon-logs.js";
import { CliError, EXIT, sanitize, usageError } from "./output.js";

const USAGE = `Usage:
  webhub daemon start             start the daemon in the background (no-op if running)
  webhub daemon stop [--force]    stop it; --force kills it if it does not stop in 10 s
  webhub daemon status            running or not (exit 3 = not running)
  webhub daemon logs [-n N] [-f]  last N lines of the daemon log (default 50); -f follows

Options: --json (start / stop / status), -h / --help`;

const LOG_LINES_DEFAULT = 50;
const LOG_LINES_MAX = 10_000;

type Sub = "start" | "stop" | "status" | "logs";

function parse(sub: Sub, args: string[]) {
  const options: ParseArgsOptionsConfig = {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  };
  if (sub === "stop") options.force = { type: "boolean" };
  if (sub === "logs") {
    options.lines = { type: "string", short: "n" };
    options.follow = { type: "boolean", short: "f" };
  }
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values as {
      help?: boolean;
      json?: boolean;
      force?: boolean;
      lines?: string;
      follow?: boolean;
    };
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : "invalid options");
  }
}

function emit(ctx: CommandContext, json: boolean, value: Record<string, unknown>, text: string) {
  ctx.io.out(json ? JSON.stringify(value) : text);
}

/** An impostor on the API port: say who listens there; the token was never sent. */
async function explainImpostor(err: unknown, ctx: CommandContext): Promise<never> {
  if (isServerError(err, "DAEMON_IMPOSTOR")) {
    let port: number | undefined;
    try {
      const { readFileSync } = await import("node:fs");
      port = (JSON.parse(readFileSync(ctx.paths().auth, "utf8")) as { port?: number }).port;
    } catch {
      // unknown port
    }
    const owners = port === undefined ? [] : await portOwners(getPlatform(), port);
    throw new CliError(EXIT.error, "DAEMON_IMPOSTOR", err.message, {
      details: owners,
      ...(err.hint === undefined ? {} : { hint: err.hint }),
    });
  }
  throw err;
}

export const daemonCommand = {
  summary: "start / stop / status / logs of the webhub daemon",
  usage: USAGE,
  async run(argv: string[], ctx: CommandContext): Promise<number> {
    const [sub, ...args] = argv;
    // `webhub --json daemon`: a JSON error, not text usage (review C12)
    if (sub === undefined && ctx.json) throw usageError("missing daemon command");
    if (sub === undefined || sub === "--help" || sub === "-h") {
      ctx.io.out(USAGE);
      return sub === undefined ? EXIT.usage : EXIT.ok;
    }
    if (sub !== "start" && sub !== "stop" && sub !== "status" && sub !== "logs") {
      throw usageError(`unknown daemon command: ${sanitize(sub)}`);
    }
    const opts = parse(sub, args);
    if (opts.help === true) {
      ctx.io.out(USAGE);
      return EXIT.ok;
    }
    const json = ctx.json || opts.json === true;
    const paths = ctx.paths();

    if (sub === "start") {
      const r = await startDaemonProcess(paths, { env: ctx.env }).catch((e: unknown) =>
        explainImpostor(e, ctx),
      );
      emit(
        ctx,
        json,
        { running: true, pid: r.pid, port: r.port, alreadyRunning: r.alreadyRunning },
        r.alreadyRunning
          ? `webhub daemon already running (PID ${r.pid}, port ${r.port})`
          : `webhub daemon started (PID ${r.pid}, port ${r.port})`,
      );
      return EXIT.ok;
    }

    if (sub === "stop") {
      const r = await stopDaemon(paths, { force: opts.force === true }).catch((e: unknown) =>
        explainImpostor(e, ctx),
      );
      emit(
        ctx,
        json,
        { running: false, wasRunning: r.wasRunning, forced: r.forced },
        !r.wasRunning
          ? "webhub daemon is not running"
          : r.forced
            ? "webhub daemon killed (--force)"
            : "webhub daemon stopped",
      );
      return EXIT.ok;
    }

    if (sub === "status") {
      const s = await daemonStatus(paths).catch((e: unknown) => explainImpostor(e, ctx));
      if (s === undefined) {
        emit(ctx, json, { running: false }, "webhub daemon is not running");
        return EXIT.notRunning;
      }
      const started = Date.parse(s.startedAt);
      const uptime = Number.isNaN(started)
        ? "?"
        : String(Math.max(0, Math.round((Date.now() - started) / 1000)));
      emit(
        ctx,
        json,
        {
          running: true,
          pid: s.pid,
          port: s.port,
          version: s.version,
          startedAt: s.startedAt,
          home: s.home,
        },
        [
          `webhub daemon running`,
          `  PID      ${s.pid}`,
          `  port     ${s.port}`,
          `  version  ${sanitize(String(s.version))}`,
          `  started  ${sanitize(String(s.startedAt))} (${uptime} s ago)`,
          `  home     ${sanitize(String(s.home))}`,
        ].join("\n"),
      );
      return EXIT.ok;
    }

    // logs
    let n = LOG_LINES_DEFAULT;
    if (opts.lines !== undefined) {
      if (!/^[0-9]+$/.test(opts.lines)) throw usageError("-n must be a number");
      n = Number(opts.lines);
      if (n < 1 || n > LOG_LINES_MAX) throw usageError(`-n must be 1–${LOG_LINES_MAX}`);
    }
    for (const line of tailLogs(paths, n)) ctx.io.out(line);
    if (opts.follow === true) {
      ctx.following();
      await followLogs(paths, (l) => ctx.io.out(l), ctx.signal);
    }
    return EXIT.ok;
  },
};
