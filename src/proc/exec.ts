import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { WebhubError } from "../errors.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with an args array (never through a shell — WORKFLOW §8 Input).
 * `input` is written to stdin, so sensitive data never appears in argv.
 */
export function execFile(
  file: string,
  args: readonly string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: "pipe" });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 30_000);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    // child may exit before reading stdin (EPIPE/EOF): the exit code reports the failure
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/**
 * Absolute path of an OS tool, so a same-named program earlier in PATH (e.g. Git's
 * coreutils `whoami`, or a planted binary) is never run. Windows: %SystemRoot%\System32.
 */
export function systemExe(name: string): string {
  if (process.platform === "win32") {
    // only a full drive path (C:\...) is accepted; "C:Windows" or "\\Windows" would resolve
    // against a current directory → refuse instead of guessing
    const root = [process.env.SystemRoot, process.env.windir].find(
      (v): v is string => v !== undefined && /^[A-Za-z]:[\\/]/.test(v) && isAbsolute(v),
    );
    if (root === undefined) {
      throw new WebhubError("SYSTEM_TOOL", "SystemRoot is not set to an absolute path", {
        hint: "Start webhub from a normal Windows session (SystemRoot / windir must be like C:\\Windows).",
      });
    }
    return join(root, "System32", name);
  }
  for (const dir of ["/bin", "/usr/bin", "/usr/sbin", "/sbin"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  throw new WebhubError("SYSTEM_TOOL", `system tool not found: ${name}`);
}

/** Runs a PowerShell script passed via -EncodedCommand (no quoting, no user data in the script). */
export function powershell(
  script: string,
  input?: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execFile(
    systemExe(join("WindowsPowerShell", "v1.0", "powershell.exe")),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      ...(input === undefined ? {} : { input }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  );
}
