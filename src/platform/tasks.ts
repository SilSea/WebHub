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

/** Task → single argv token (base64url JSON: no spaces/quotes, safe on a command line). */
export function encodeTask(task: ElevatedTask): string {
  return Buffer.from(JSON.stringify(task), "utf8").toString("base64url");
}

export function decodeTask(token: string): ElevatedTask {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(token)) {
    throw new PlatformError("ELEVATION_INVALID", "malformed task token");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new PlatformError("ELEVATION_INVALID", "malformed task token");
  }
  return parseTask(parsed);
}
