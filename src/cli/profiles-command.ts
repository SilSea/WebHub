/**
 * `webhub profiles [--check]` (F-005 §3.2): the runtime profiles the daemon loaded and the
 * files it could not load. `--check` exits 2 when any file has a problem (for profile authors).
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import type { CommandContext } from "../cli.js";
import { explainImpostor } from "./daemon-command.js";
import { ensureDaemon } from "./daemon-control.js";
import { CliError, EXIT, sanitize, usageError } from "./output.js";

const USAGE = `Usage:
  webhub profiles [--check]   runtime profiles (built-in + data/profiles) and files that failed

Options: --check (exit 2 when a profile file has a problem), --json, -h / --help`;

/** The daemon was proven (HMAC), still: never trust a shape blindly. */
const Body = z.object({
  profiles: z
    .array(
      z.object({
        id: z.string(),
        language: z.string(),
        source: z.enum(["builtin", "user"]),
        file: z.string(),
        overrides: z.string().optional(),
      }),
    )
    .max(1000),
  problems: z
    .array(
      z.object({ file: z.string(), message: z.string(), details: z.array(z.string()).max(100) }),
    )
    .max(1000),
});

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

export const profilesCommand = {
  summary: "runtime profiles (built-in + your own) and broken profile files",
  usage: USAGE,
  async run(argv: string[], ctx: CommandContext): Promise<number> {
    let values: { help?: boolean; json?: boolean; check?: boolean };
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          help: { type: "boolean", short: "h" },
          json: { type: "boolean" },
          check: { type: "boolean" },
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
    const parsed = Body.safeParse(await client.request("GET", "/api/v1/profiles"));
    if (!parsed.success) {
      throw new CliError(EXIT.error, "DAEMON_BAD_ANSWER", "the daemon sent an unexpected answer");
    }
    const { profiles, problems } = parsed.data;
    const failed = values.check === true && problems.length > 0;
    if (json) {
      // daemon text may hold C1 / bidi characters JSON does not escape (security-1 S7)
      ctx.io.out(
        JSON.stringify({ profiles, problems }, (_k, v: unknown) =>
          typeof v === "string" ? sanitize(v) : v,
        ),
      );
      return failed ? EXIT.usage : EXIT.ok;
    }
    const rows = [
      ["ID", "LANGUAGE", "SOURCE"],
      ...profiles.map((p) => [
        sanitize(p.id),
        sanitize(p.language),
        p.source === "builtin"
          ? "built-in"
          : p.overrides === undefined
            ? `user (${sanitize(p.file)})`
            : `user (${sanitize(p.file)}, replaces built-in)`,
      ]),
    ];
    for (const line of table(rows)) ctx.io.out(line);
    if (problems.length > 0) {
      ctx.io.err(`webhub: ${problems.length} profile file(s) could not be loaded:`);
      for (const pr of problems) {
        ctx.io.err(`  ${sanitize(pr.file)}: ${sanitize(pr.message)}`);
        for (const d of pr.details) ctx.io.err(`    - ${sanitize(d)}`);
      }
    } else if (values.check === true) {
      ctx.io.out("all profile files are valid");
    }
    return failed ? EXIT.usage : EXIT.ok;
  },
};
