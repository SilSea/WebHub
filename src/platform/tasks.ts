import { z } from "zod";
import { decodeToken, TOKEN_MAX_AGE_MS } from "./elevated.mjs";
import { PlatformError } from "./types.js";

export { TOKEN_MAX_AGE_MS };

/**
 * The ONLY things webhub may do with administrator rights (spec F-002 §3.3). Every kind is a
 * fixed operation with strictly validated data; there is no "run this command" kind.
 * MVP-2 adds `hosts.writeBlock`. The elevated entry (elevated.mts) validates the same
 * allowlist by hand (it may not import zod — security-2 T3); a parity test keeps them equal.
 */
export const ElevatedTaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("noop") }),
]);
export type ElevatedTask = z.infer<typeof ElevatedTaskSchema>;

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

/** Task → single argv token (base64url JSON: no spaces/quotes, safe on a command line). */
export function encodeTask(task: ElevatedTask, now: number = Date.now()): string {
  return Buffer.from(JSON.stringify({ v: 1, iat: now, task }), "utf8").toString("base64url");
}

/** Same decoding the elevated process does, as PlatformErrors (user side / tests). */
export function decodeTask(token: string, now: number = Date.now()): ElevatedTask {
  const res = decodeToken(token, now);
  if (res.ok) return res.task;
  if (res.reason === "expired") {
    throw new PlatformError("ELEVATION_EXPIRED", "the elevation request has expired");
  }
  throw new PlatformError("ELEVATION_INVALID", "malformed or not allowed task token");
}
