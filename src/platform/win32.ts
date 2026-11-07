import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { execFile, powershell, systemExe } from "../proc/exec.js";
import { processState } from "../store/lock.js";
import { encodeTask, parseTask } from "./tasks.js";
import {
  type BindHost,
  type Platform,
  PlatformError,
  type PortOwner,
  type PortRange,
  type ProcInfo,
  type Usage,
} from "./types.js";

const LISTEN_CACHE_MS = 2_000;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function checkPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    throw new PlatformError("PROCESS_MISMATCH", `invalid PID: ${String(pid)}`);
  }
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PlatformError("PORT_INVALID", `invalid port: ${String(port)}`);
  }
}

/** Last line starting with `JSON:` → parsed + validated; anything else is a tool failure. */
function jsonLine<T>(stdout: string, schema: z.ZodType<T>, what: string): T {
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

// ---------- ports ----------

const ListeningSchema = z.array(
  z.object({ a: z.string(), p: z.number().int().min(0).max(65535), o: z.number().int().min(0) }),
);

/** Parses the `JSON:` line of the CIM listener query (exported for fixture tests). */
export function parseListening(stdout: string): PortOwner[] {
  return jsonLine(stdout, ListeningSchema, "listening ports").map((r) => ({
    port: r.p,
    address: r.a,
    pid: r.o,
    family: r.a.includes(":") ? 6 : 4,
  }));
}

/** Parses `netsh int ipvX show excludedportrange` (numbers only — the text is localized). */
export function parseExcluded(stdout: string): PortRange[] {
  const out: PortRange[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d{1,5})\s+(\d{1,5})\s*(\*)?\s*$/.exec(line);
    if (m === null) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start < 1 || end > 65535 || start > end) continue;
    out.push({ start, end, administered: m[3] === "*" });
  }
  return out;
}

let listenCache: { at: number; value: PortOwner[] } | undefined;

async function listening(): Promise<PortOwner[]> {
  if (listenCache !== undefined && Date.now() - listenCache.at < LISTEN_CACHE_MS) {
    return listenCache.value;
  }
  // CIM state 2 = Listen; numeric → independent of the Windows display language
  const res = await powershell(
    [
      "$ErrorActionPreference = 'Stop'",
      "$r = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State=2' | ForEach-Object { @{ a = [string]$_.LocalAddress; p = [int]$_.LocalPort; o = [int]$_.OwningProcess } })",
      "'JSON:' + (ConvertTo-Json -InputObject $r -Compress)",
    ].join("\n"),
  );
  if (res.code !== 0) throw new PlatformError("PLATFORM_TOOL", "could not list listening ports");
  const value = parseListening(res.stdout);
  listenCache = { at: Date.now(), value };
  return value;
}

async function reserved(): Promise<PortRange[]> {
  const all: PortRange[] = [];
  for (const family of ["ipv4", "ipv6"]) {
    const res = await execFile(systemExe("netsh.exe"), [
      "int",
      family,
      "show",
      "excludedportrange",
      "protocol=tcp",
    ]);
    if (res.code !== 0) {
      throw new PlatformError("PLATFORM_TOOL", "could not read excluded port ranges");
    }
    all.push(...parseExcluded(res.stdout));
  }
  const seen = new Set<string>();
  return all.filter((r) => {
    const k = `${r.start}-${r.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function canBind(port: number, host: BindHost = "127.0.0.1"): Promise<boolean> {
  checkPort(port);
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/** Lowest port in `range` that is not reserved, not listened on, not in `avoid`, and bindable. */
export async function pickFree(
  range: readonly [number, number],
  taken: (port: number) => boolean,
  bind: (port: number) => Promise<boolean>,
): Promise<number> {
  const [start, end] = range;
  checkPort(start);
  checkPort(end);
  if (start > end) throw new PlatformError("PORT_INVALID", `invalid range ${start}-${end}`);
  for (let p = start; p <= end; p++) {
    if (taken(p)) continue;
    if (await bind(p)) return p;
  }
  throw new PlatformError("PORT_EXHAUSTED", `no free port in ${start}-${end}`, {
    hint: "Widen the range in webhub.config.json (ports) or stop programs using these ports.",
  });
}

async function findFree(
  range: readonly [number, number],
  avoid: ReadonlySet<number> = new Set(),
): Promise<number> {
  const [res, lis] = await Promise.all([reserved(), listening()]);
  const used = new Set(lis.map((l) => l.port));
  const taken = (p: number) =>
    avoid.has(p) || used.has(p) || res.some((r) => p >= r.start && p <= r.end);
  return pickFree(range, taken, (p) => canBind(p));
}

// ---------- process ----------

const InfoSchema = z.array(
  z.object({
    n: z.string(),
    e: z.string().nullable(),
    c: z.string(),
    pp: z.number().int().nullable(),
  }),
);

async function info(pid: number): Promise<ProcInfo | undefined> {
  checkPid(pid);
  const res = await powershell(
    [
      "$ErrorActionPreference = 'Stop'",
      `$r = @(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | ForEach-Object { @{ n = [string]$_.Name; e = $_.ExecutablePath; c = $_.CreationDate.ToUniversalTime().ToString('o'); pp = [int]$_.ParentProcessId } })`,
      "'JSON:' + (ConvertTo-Json -InputObject $r -Compress)",
    ].join("\n"),
  );
  if (res.code !== 0) throw new PlatformError("PLATFORM_TOOL", "could not read process info");
  const [r] = jsonLine(res.stdout, InfoSchema, "process info");
  if (r === undefined) return undefined;
  return {
    pid,
    name: r.n,
    exe: r.e ?? undefined,
    startedAt: r.c,
    parentPid: r.pp ?? undefined,
  };
}

async function killTree(pid: number, expectStartedAt: string): Promise<void> {
  checkPid(pid);
  const before = await processState(pid);
  if (before.state === "dead") return;
  if (before.state !== "alive" || before.startedAt !== expectStartedAt) {
    // PID reused by another program (or cannot be verified): never kill it
    throw new PlatformError("PROCESS_MISMATCH", `PID ${pid} is not the process webhub started`);
  }
  const res = await execFile(systemExe("taskkill.exe"), ["/PID", String(pid), "/T", "/F"]);
  for (let i = 0; i < 50; i++) {
    const now = await processState(pid);
    if (now.state === "dead" || (now.state === "alive" && now.startedAt !== expectStartedAt)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new PlatformError("PROCESS_KILL_FAILED", `could not stop PID ${pid}`, {
    details: [res.stdout.trim().split(/\r?\n/)[0] ?? ""],
  });
}

const UsageSchema = z.array(
  z.object({ i: z.number().int(), k: z.number(), u: z.number(), w: z.number() }),
);

async function usage(pids: readonly number[]): Promise<Map<number, Usage>> {
  const out = new Map<number, Usage>();
  const unique = [...new Set(pids)];
  for (const p of unique) checkPid(p);
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const filter = batch.map((p) => `ProcessId=${p}`).join(" OR ");
    const res = await powershell(
      [
        "$ErrorActionPreference = 'Stop'",
        `$r = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { @{ i = [int]$_.ProcessId; k = [double]$_.KernelModeTime; u = [double]$_.UserModeTime; w = [double]$_.WorkingSetSize } })`,
        "'JSON:' + (ConvertTo-Json -InputObject $r -Compress)",
      ].join("\n"),
    );
    if (res.code !== 0) throw new PlatformError("PLATFORM_TOOL", "could not read process usage");
    for (const r of jsonLine(res.stdout, UsageSchema, "process usage")) {
      // CIM times are in 100 ns units
      out.set(r.i, { cpuSeconds: (r.k + r.u) / 1e7, workingSetBytes: r.w });
    }
  }
  return out;
}

// ---------- elevate ----------

/** Absolute paths of node and of the elevated entry (never looked up through PATH). */
export function elevatedCommand(): { exe: string; script: string } {
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith(".ts") ? ".ts" : ".js";
  return {
    exe: process.execPath,
    script: fileURLToPath(new URL(`./elevated${ext}`, import.meta.url)),
  };
}

async function elevate(input: unknown): Promise<void> {
  const task = parseTask(input); // refuse before any UAC prompt
  const { exe, script } = elevatedCommand();
  // data travels on stdin (base64): nothing user-controlled is spliced into the script
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$in = ([Console]::In.ReadToEnd()).Trim() -split "`n"',
    "$d = { param($s) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s.Trim())) }",
    "$exe = & $d $in[0]; $script = & $d $in[1]; $token = & $d $in[2]",
    "try {",
    "  $p = Start-Process -FilePath $exe -ArgumentList ('\"' + $script + '\" ' + $token) -Verb RunAs -Wait -PassThru -WindowStyle Hidden",
    "  [Console]::Out.WriteLine('EXIT:' + $p.ExitCode)",
    "} catch [System.InvalidOperationException] {",
    "  [Console]::Out.WriteLine('DENIED')",
    "} catch {",
    "  if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { [Console]::Out.WriteLine('DENIED') } else { [Console]::Out.WriteLine('FAIL:' + $_.Exception.GetType().Name) }",
    "}",
  ].join("\n");
  const res = await powershell(
    ps,
    `${b64(exe)}\n${b64(script)}\n${b64(encodeTask(task))}\n`,
    600_000,
  );
  const line = res.stdout.split(/\r?\n/).find((l) => /^(EXIT:|DENIED|FAIL:)/.test(l)) ?? "";
  if (line === "DENIED") {
    throw new PlatformError("ELEVATION_DENIED", "administrator permission was not granted");
  }
  if (line === "EXIT:0") return;
  throw new PlatformError("ELEVATION_FAILED", "the elevated task failed", {
    details: [line === "" ? `PowerShell exited with code ${res.code}` : line],
  });
}

// ---------- notify ----------

const TOAST_AUMID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** Strips control characters and caps the length (the text is also XML-escaped in PowerShell). */
export function cleanText(s: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters on purpose
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function notify(title: string, body: string): Promise<boolean> {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    '  $in = ([Console]::In.ReadToEnd()).Trim() -split "`n"',
    "  $t = [Security.SecurityElement]::Escape([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($in[0].Trim())))",
    "  $b = [Security.SecurityElement]::Escape([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($in[1].Trim())))",
    "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "  $x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "  $x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>' + $t + '</text><text>' + $b + '</text></binding></visual></toast>')",
    `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_AUMID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
    "  [Console]::Out.WriteLine('OK')",
    "} catch { [Console]::Out.WriteLine('FAIL') }",
  ].join("\n");
  try {
    const res = await powershell(
      ps,
      `${b64(cleanText(title, 100))}\n${b64(cleanText(body, 500))}\n`,
    );
    return res.stdout.split(/\r?\n/).includes("OK");
  } catch {
    return false;
  }
}

export const win32Platform: Platform = {
  name: "win32",
  ports: { listening, reserved, canBind, findFree },
  process: { info, killTree, usage },
  elevate,
  notify,
  capabilities: () => ({ resolvesLocalhostSubdomains: false, dockerTopology: "host-gateway" }),
};
