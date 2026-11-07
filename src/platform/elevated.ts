#!/usr/bin/env node
/**
 * Entry point run WITH administrator rights (via UAC) by `elevate()`.
 * Takes exactly one argument: a base64url task token. Reads no files and no environment to
 * decide what to do — everything comes from the validated token (spec F-002 §3.3, §6).
 * Exit codes: 0 done, 2 invalid task, 3 expired token (nothing done), 1 task failed.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeTask, runTask } from "./tasks.js";
import { isPlatformError } from "./types.js";

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1 || argv[0] === undefined) return 2;
  let task: ReturnType<typeof decodeTask>;
  try {
    task = decodeTask(argv[0]);
  } catch (err) {
    if (isPlatformError(err, "ELEVATION_EXPIRED")) return 3;
    return isPlatformError(err, "ELEVATION_INVALID") ? 2 : 1;
  }
  try {
    await runTask(task);
    return 0;
  } catch {
    return 1;
  }
}

function isMain(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
