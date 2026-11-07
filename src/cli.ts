#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readVersion } from "./version.js";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const HELP = `webhub — local hub for web projects

Usage:
  webhub --version   Print version
  webhub --help      Print this help

Commands are not implemented yet (see docs/PLAN.md).`;

/** Runs the CLI and returns the process exit code. */
export function run(argv: readonly string[], io: Io): number {
  const [first] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    io.out(readVersion());
    return 0;
  }
  io.err(`webhub: unknown command or option: ${first}`);
  io.err("Run 'webhub --help' for usage.");
  return 1;
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
  process.exitCode = run(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
