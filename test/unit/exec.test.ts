import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFile, systemExe } from "../../src/proc/exec.js";

describe("execFile", () => {
  it("child exiting before reading a large stdin → exit code, no crash", async () => {
    const res = await execFile(process.execPath, ["-e", "process.exit(3)"], {
      input: "x".repeat(2_000_000),
    });
    expect(res.code).toBe(3);
  });

  it("passes stdin and collects stdout", async () => {
    const res = await execFile(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      input: "héllo",
    });
    expect(res).toMatchObject({ code: 0, stdout: "héllo" });
  });

  it("systemExe returns an absolute OS path, never a PATH lookup", () => {
    const p = process.platform === "win32" ? systemExe("whoami.exe") : systemExe("ps");
    expect(isAbsolute(p)).toBe(true);
    if (process.platform === "win32") {
      expect(p.toLowerCase().endsWith(join("system32", "whoami.exe"))).toBe(true);
    }
  });
});
