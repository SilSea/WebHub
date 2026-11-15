/**
 * `webhub scan [--last] [--json]` (F-006 §3.5): starts a scan in the daemon, waits for it
 * (progress on stderr) and prints the candidates. `--last` prints the last result without
 * scanning. Ctrl+C cancels the scan. Exit 0, or 2 when the result was truncated / has problems.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { CommandContext } from "../cli.js";
import { ScanResult } from "../scanner/schema.js";
import { isServerError } from "../server/errors.js";
import { explainImpostor } from "./daemon-command.js";
import { ensureDaemon } from "./daemon-control.js";
import { CliError, EXIT, sanitize, usageError } from "./output.js";

const USAGE = `Usage:
  webhub scan           scan the scan roots for web projects (read-only) and list them
  webhub scan --last    show the last scan result without scanning

Options: --json, -h / --help`;

export const POLL_MS = 500;

/** The daemon was proven (HMAC), still: never trust a shape blindly. */
const State = z.object({
  running: z
    .object({
      scanId: z.string(),
      startedAt: z.string(),
      folders: z.number(),
      candidates: z.number(),
    })
    .nullable(),
  last: ScanResult.nullable(),
  lastError: z.object({ scanId: z.string(), code: z.string(), message: z.string() }).nullable(),
});
type State = z.infer<typeof State>;

const Started = z.object({ scanId: z.string() });

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

const bad = () =>
  new CliError(EXIT.error, "DAEMON_BAD_ANSWER", "the daemon sent an unexpected answer");

function print(result: ScanResult, json: boolean, ctx: CommandContext): number {
  const failed = result.truncated !== false || result.problems.length > 0;
  if (json) {
    // project names / paths may hold characters JSON does not escape (C1, bidi)
    ctx.io.out(
      JSON.stringify(result, (_k, v: unknown) => (typeof v === "string" ? sanitize(v) : v)),
    );
    return failed ? EXIT.usage : EXIT.ok;
  }
  const rows = [
    ["NAME", "KIND", "PROFILE", "RUNNER", "PORT", "PATH"],
    ...result.candidates.map((c) => {
      const ports = Object.values(c.services)
        .map((s) => (s.port === undefined ? undefined : `${s.port.value} (${s.port.via})`))
        .filter((p) => p !== undefined);
      return [
        sanitize(c.name),
        c.kind === "duplicate" ? "duplicate" : c.kind,
        sanitize(c.profile ?? "-"),
        c.runner ?? "-",
        ports.length === 0 ? "-" : ports.join(", "),
        sanitize(c.path),
      ];
    }),
  ];
  for (const line of table(rows)) ctx.io.out(line);
  const sites = result.candidates.filter((c) => c.kind === "site").length;
  ctx.io.err(
    `webhub: ${sites} site(s), ${result.candidates.length - sites} other folder(s) found in ${result.roots.length} scan root(s)`,
  );
  for (const r of result.roots.filter((x) => x.status !== "ok")) {
    ctx.io.err(`  scan root ${sanitize(r.path)}: ${r.status}`);
  }
  if (result.roots.length === 0) {
    ctx.io.err("  no scan roots configured (scanRoots in webhub.config.json)");
  }
  if (result.truncated !== false) {
    ctx.io.err(
      `webhub: the scan stopped early (limit: ${result.truncated.reason}${
        result.truncated.root === undefined ? "" : ` in ${sanitize(result.truncated.root)}`
      }); results are partial`,
    );
  }
  for (const p of result.problems) ctx.io.err(`  ${sanitize(p.file)}: ${sanitize(p.message)}`);
  if (result.skipped.length > 0) {
    ctx.io.err(`webhub: ${result.skipped.length} folder(s) skipped (links, unreadable, odd names)`);
  }
  return failed ? EXIT.usage : EXIT.ok;
}

export const scanCommand = {
  summary: "find web projects in the scan roots (read-only)",
  usage: USAGE,
  async run(argv: string[], ctx: CommandContext): Promise<number> {
    let values: { help?: boolean; json?: boolean; last?: boolean };
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          help: { type: "boolean", short: "h" },
          json: { type: "boolean" },
          last: { type: "boolean" },
        },
        strict: true,
        allowPositionals: false,
      }));
    } catch (err) {
      throw usageError(err instanceof Error ? err.message : "invalid options");
    }
    if (values.help === true) {
      ctx.io.out(USAGE);
      return EXIT.ok;
    }
    const json = ctx.json || values.json === true;
    const client = await ensureDaemon(ctx.paths(), {
      env: ctx.env,
      noStart: ctx.noStart,
      onStart: () => ctx.io.err("webhub: starting the daemon…"),
    }).catch((e: unknown) => explainImpostor(e, ctx));
    const state = async (): Promise<State> => {
      const parsed = State.safeParse(await client.request("GET", "/api/v1/scan"));
      if (!parsed.success) throw bad();
      return parsed.data;
    };
    if (values.last === true) {
      const s = await state();
      if (s.last === null) {
        throw new CliError(EXIT.error, "NO_SCAN", "there is no scan result yet", {
          hint: "Run 'webhub scan'.",
        });
      }
      return print(s.last, json, ctx);
    }
    let scanId: string;
    try {
      const started = Started.safeParse(await client.request("POST", "/api/v1/scan"));
      if (!started.success) throw bad();
      scanId = started.data.scanId;
    } catch (err) {
      if (!(isServerError(err, "API_ERROR") && err.apiCode === "SCAN_RUNNING")) throw err;
      const s = await state();
      if (s.running === null) throw err;
      scanId = s.running.scanId; // join the scan that is running
      ctx.io.err("webhub: a scan is already running; waiting for it");
    }
    ctx.following();
    let shown = 0;
    for (;;) {
      if (ctx.signal.aborted) {
        await client.request("DELETE", "/api/v1/scan").catch(() => {});
        ctx.io.err("webhub: scan cancelled");
        return EXIT.error;
      }
      const s = await state();
      if (s.running?.scanId === scanId) {
        if (!json && Date.now() - shown >= 2_000) {
          shown = Date.now();
          ctx.io.err(
            `webhub: scanning… ${s.running.folders} folders, ${s.running.candidates} candidates`,
          );
        }
        await sleep(POLL_MS, undefined, { signal: ctx.signal }).catch(() => {});
        continue;
      }
      if (s.last?.scanId === scanId) return print(s.last, json, ctx);
      if (s.lastError?.scanId === scanId) {
        throw new CliError(EXIT.error, s.lastError.code, sanitize(s.lastError.message));
      }
      throw new CliError(EXIT.error, "SCAN_LOST", "the scan ended without a result (cancelled?)");
    }
  },
};
