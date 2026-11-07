#!/usr/bin/env node
/**
 * Entry point run WITH administrator rights (via UAC) by `elevate()`.
 *
 * SELF-CONTAINED ON PURPOSE (security-2 T3): imports only `node:*` built-ins and is an .mjs
 * file, so the administrator process loads exactly two things from disk — node.exe and this
 * file. No zod, no package.json lookup, no other webhub module. That keeps the
 * pre-elevation trust check (win32-trust.ts) small and complete. Validation of the task
 * allowlist is therefore written by hand here; `tasks.ts` holds the zod version used on the
 * user side, and a unit test checks both accept/reject the same inputs.
 *
 * Takes exactly one argument: a base64url token `{v:1, iat, task}`. Reads no files and no
 * environment to decide what to do (spec F-002 §3.3, §6).
 * Exit codes: see `EXIT` (10 done, 2 invalid task, 3 expired token — nothing done, 1 failed).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A token is only valid this long after it was issued (security-1 S3). */
export const TOKEN_MAX_AGE_MS = 300_000;
const CLOCK_SKEW_MS = 60_000;

/** Allowlist — keep in sync with `ElevatedTaskSchema` in tasks.ts (parity test). */
export type ElevatedTaskData = { kind: "noop" };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const hasExactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};

/** Strict validation of one task: known kind, exactly its fields, nothing else. */
export function validateTask(v: unknown): ElevatedTaskData | undefined {
  if (!isPlainObject(v) || !Object.hasOwn(v, "kind")) return undefined;
  switch (v.kind) {
    case "noop":
      return hasExactKeys(v, ["kind"]) ? { kind: "noop" } : undefined;
    default:
      return undefined;
  }
}

export type DecodeResult =
  | { ok: true; task: ElevatedTaskData }
  | { ok: false; reason: "invalid" | "expired" };

/** Longest accepted token (checked on the user side too, before any UAC prompt). */
export const TOKEN_MAX_LENGTH = 8192;

/**
 * Exit codes. Success is NOT 0: 0 is also what node returns when this file is loaded but
 * `main` never ran, which must never be reported as success (review-3 E4).
 */
export const EXIT = { ok: 10, failed: 1, invalid: 2, expired: 3 } as const;

export function decodeToken(token: string, now: number = Date.now()): DecodeResult {
  if (token.length > TOKEN_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, reason: "invalid" };
  }
  let env: unknown;
  try {
    env = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    !isPlainObject(env) ||
    !hasExactKeys(env, ["v", "iat", "task"]) ||
    env.v !== 1 ||
    typeof env.iat !== "number" ||
    !Number.isSafeInteger(env.iat) ||
    env.iat < 0
  ) {
    return { ok: false, reason: "invalid" };
  }
  const task = validateTask(env.task);
  if (task === undefined) return { ok: false, reason: "invalid" };
  const age = now - env.iat;
  if (age > TOKEN_MAX_AGE_MS || age < -CLOCK_SKEW_MS) return { ok: false, reason: "expired" };
  return { ok: true, task };
}

/** Runs a validated task. Executed inside the elevated process only. */
export async function runTask(task: ElevatedTaskData): Promise<void> {
  switch (task.kind) {
    case "noop":
      return;
  }
}

export async function main(argv: readonly string[], now: number = Date.now()): Promise<number> {
  if (argv.length !== 1 || argv[0] === undefined) return EXIT.invalid;
  const res = decodeToken(argv[0], now);
  if (!res.ok) return res.reason === "expired" ? EXIT.expired : EXIT.invalid;
  try {
    await runTask(res.task);
    return EXIT.ok;
  } catch {
    return EXIT.failed;
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

// no top-level await: importing this module must not make the graph async (review-3 E9)
if (isMain()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT.failed;
    },
  );
}
