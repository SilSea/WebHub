import { z } from "zod";
import { PlatformError } from "./types.js";

/**
 * The ONLY things webhub may do with administrator rights (spec F-002 §3.3). Every kind is a
 * fixed operation with strictly validated data; there is no "run this command" kind.
 * MVP-2 adds `hosts.writeBlock`.
 */
export const ElevatedTaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("noop") }),
]);
export type ElevatedTask = z.infer<typeof ElevatedTaskSchema>;

/**
 * A token is only valid this long after it was issued. A UAC prompt left open past the
 * caller's timeout (webhub already reported failure) then runs nothing (security-1 S3).
 */
export const TOKEN_MAX_AGE_MS = 300_000;
const CLOCK_SKEW_MS = 60_000;

/** Validates untrusted input into a task, or throws ELEVATION_INVALID listing the problems. */
export function parseTask(input: unknown): ElevatedTask {
  const res = ElevatedTaskSchema.safeParse(input);
  if (res.success) return res.data;
  throw new PlatformError("ELEVATION_INVALID", "not an allowed elevated task", {
    details: res.error.issues.map(
      (i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
    ),
  });
}

/** Human-readable description shown to the user before the UAC prompt. */
export function describeTask(task: ElevatedTask): string {
  switch (task.kind) {
    case "noop":
      return "Test elevation (does nothing).";
  }
}

/** Runs a validated task. Executed inside the elevated process only. */
export async function runTask(task: ElevatedTask): Promise<void> {
  switch (task.kind) {
    case "noop":
      return;
  }
}

const EnvelopeSchema = z.strictObject({
  v: z.literal(1),
  iat: z.number().int().nonnegative(),
  task: z.unknown(),
});

/** Task → single argv token (base64url JSON: no spaces/quotes, safe on a command line). */
export function encodeTask(task: ElevatedTask, now: number = Date.now()): string {
  return Buffer.from(JSON.stringify({ v: 1, iat: now, task }), "utf8").toString("base64url");
}

export function decodeTask(token: string, now: number = Date.now()): ElevatedTask {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(token)) {
    throw new PlatformError("ELEVATION_INVALID", "malformed task token");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new PlatformError("ELEVATION_INVALID", "malformed task token");
  }
  const env = EnvelopeSchema.safeParse(parsed);
  if (!env.success) throw new PlatformError("ELEVATION_INVALID", "malformed task token");
  const task = parseTask(env.data.task);
  const age = now - env.data.iat;
  if (age > TOKEN_MAX_AGE_MS || age < -CLOCK_SKEW_MS) {
    throw new PlatformError("ELEVATION_EXPIRED", "the elevation request has expired");
  }
  return task;
}
