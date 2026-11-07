import type { z } from "zod";
import { type ExecResult, execFile, powershell, systemExe } from "../proc/exec.js";
import { PlatformError } from "./types.js";

/** First line of every script: PowerShell 5.1 otherwise writes the OEM codepage to pipes. */
export const PS_UTF8 = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)";

/**
 * Reads the stdin fields sent by `fields()` into `$f` (array of decoded strings). Each line is
 * `f:<base64>` so empty values survive (security-1 S7 / review-1 C5).
 */
export const PS_READ_FIELDS =
  "$f = @([Console]::In.ReadToEnd() -split \"`n\" | ForEach-Object { $_.Trim() } | Where-Object { $_.StartsWith('f:') } | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_.Substring(2))) })";

export const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** stdin payload for `PS_READ_FIELDS`: data never becomes script text. */
export function fields(values: readonly string[]): string {
  return values.map((v) => `f:${b64(v)}\n`).join("");
}

export type PsRunner = (script: string, input?: string, timeoutMs?: number) => Promise<ExecResult>;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs PowerShell; failure to start becomes PLATFORM_TOOL (not a foreign error type). */
export async function runPs(
  what: string,
  script: string,
  input?: string,
  timeoutMs?: number,
  run: PsRunner = powershell,
): Promise<ExecResult> {
  try {
    return await run(`${PS_UTF8}\n${script}`, input, timeoutMs);
  } catch (err) {
    throw new PlatformError("PLATFORM_TOOL", `${what}: could not run PowerShell`, {
      details: [errText(err)],
    });
  }
}

/** Runs an OS tool by absolute path; failure to start becomes PLATFORM_TOOL. */
export async function runExe(what: string, name: string, args: readonly string[]) {
  try {
    return await execFile(systemExe(name), args);
  } catch (err) {
    throw new PlatformError("PLATFORM_TOOL", `${what}: could not run ${name}`, {
      details: [errText(err)],
    });
  }
}

/** Last line starting with `JSON:` → parsed + validated; anything else is a tool failure. */
export function jsonLine<T>(stdout: string, schema: z.ZodType<T>, what: string): T {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith("JSON:"));
  if (line === undefined) throw new PlatformError("PLATFORM_TOOL", `${what}: no output`);
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(5));
  } catch {
    throw new PlatformError("PLATFORM_TOOL", `${what}: malformed output`);
  }
  const res = schema.safeParse(raw);
  if (!res.success) throw new PlatformError("PLATFORM_TOOL", `${what}: unexpected output shape`);
  return res.data;
}
