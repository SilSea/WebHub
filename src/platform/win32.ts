import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { powershell } from "../proc/exec.js";
import { encodeTask, parseTask, TOKEN_MAX_AGE_MS } from "./tasks.js";
import {
  type Platform,
  PlatformError,
  type PortOwner,
  type PortRange,
  type ProcInfo,
  platformLog,
  type Usage,
} from "./types.js";
import { fields, jsonLine, PS_READ_FIELDS, type PsRunner, runExe, runPs } from "./win32-shell.js";
import {
  elevationFiles,
  nodeEnvProblems,
  pathTrustProblems,
  persistentEnvNames,
  trustTargets,
} from "./win32-trust.js";

const LISTEN_CACHE_MS = 2_000;
const KILL_WAIT_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function checkPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    throw new PlatformError("PID_INVALID", `invalid PID: ${String(pid)}`);
  }
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PlatformError("PORT_INVALID", `invalid port: ${String(port)}`);
  }
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

const LISTEN_PS = [
  "$ErrorActionPreference = 'Stop'",
  // CIM state 2 = Listen; numeric → independent of the Windows display language
  "$r = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State=2' | ForEach-Object { @{ a = [string]$_.LocalAddress; p = [int]$_.LocalPort; o = [int64]$_.OwningProcess } })",
  "'JSON:' + (ConvertTo-Json -InputObject $r -Compress)",
].join("\n");

let listenCache: { at: number; value: readonly PortOwner[] } | undefined;
let listenInFlight: { at: number; promise: Promise<readonly PortOwner[]> } | undefined;

async function queryListening(): Promise<readonly PortOwner[]> {
  const res = await runPs("listening ports", LISTEN_PS);
  if (res.code !== 0) throw new PlatformError("PLATFORM_TOOL", "could not list listening ports");
  const value = parseListening(res.stdout);
  listenCache = { at: Date.now(), value };
  return value;
}

/**
 * Cached 2 s. `fresh` skips the cache; concurrent callers share one query, but a `fresh`
 * caller only joins a query that started at/after its own call (review-2 D11).
 * Each query costs ~1 s (PowerShell + CIM): check many ports in parallel, or use findFree.
 */
async function listening(opts: { fresh?: boolean } = {}): Promise<PortOwner[]> {
  const calledAt = Date.now();
  let value: readonly PortOwner[];
  if (!opts.fresh && listenCache !== undefined && calledAt - listenCache.at < LISTEN_CACHE_MS) {
    value = listenCache.value;
  } else {
    let q = listenInFlight;
    if (q === undefined || (opts.fresh && q.at < calledAt)) {
      const promise = queryListening().finally(() => {
        if (listenInFlight?.promise === promise) listenInFlight = undefined;
      });
      q = { at: calledAt, promise };
      listenInFlight = q;
    }
    value = await q.promise;
  }
  return value.map((o) => ({ ...o })); // callers cannot corrupt the cache
}

async function reserved(): Promise<PortRange[]> {
  const all: PortRange[] = [];
  for (const family of ["ipv4", "ipv6"]) {
    const res = await runExe("excluded ports", "netsh.exe", [
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

function tryBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      // no IPv6 stack → that family cannot conflict
      resolvePromise(
        host.includes(":") && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT"),
      );
    });
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolvePromise(true)));
  });
}

/**
 * Loopback bind test for both families. Loopback only: binding 0.0.0.0 can raise a Windows
 * Firewall prompt. Wildcard listeners (0.0.0.0 / ::) do not block a loopback bind on Windows,
 * so callers also check `listening()` (review-1 C1).
 */
async function bindsOnLoopback(port: number): Promise<boolean> {
  return (await tryBind(port, "127.0.0.1")) && (await tryBind(port, "::1"));
}

async function canBind(port: number): Promise<boolean> {
  checkPort(port);
  const lis = await listening({ fresh: true });
  if (lis.some((l) => l.port === port)) return false;
  return bindsOnLoopback(port);
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
  const [res, lis] = await Promise.all([reserved(), listening({ fresh: true })]);
  const used = new Set(lis.map((l) => l.port));
  const taken = (p: number) =>
    avoid.has(p) || used.has(p) || res.some((r) => p >= r.start && p <= r.end);
  return pickFree(range, taken, bindsOnLoopback);
}

// ---------- process ----------

/** CreationDate as UTC ISO 'o' (same format as F-001 processState); '' when not reported. */
const PS_CREATED =
  "c = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }";

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
  const res = await runPs(
    "process info",
    [
      "$ErrorActionPreference = 'Stop'",
      `$r = @(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | ForEach-Object { @{ n = [string]$_.Name; e = $_.ExecutablePath; ${PS_CREATED}; pp = [int64]$_.ParentProcessId } })`,
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
    startedAt: r.c === "" ? undefined : r.c,
    parentPid: r.pp === null || r.pp === 0 ? undefined : r.pp,
  };
}

export interface ProcRow {
  i: number;
  p: number;
  c: string;
}

const ProcRowsSchema = z.array(
  z.object({ i: z.number().int(), p: z.number().int(), c: z.string() }),
);

async function processTable(): Promise<ProcRow[]> {
  const res = await runPs(
    "process list",
    [
      "$ErrorActionPreference = 'Stop'",
      `$r = @(Get-CimInstance Win32_Process | ForEach-Object { @{ i = [int64]$_.ProcessId; p = [int64]$_.ParentProcessId; ${PS_CREATED} } })`,
      "'JSON:' + (ConvertTo-Json -InputObject $r -Compress)",
    ].join("\n"),
  );
  if (res.code !== 0) throw new PlatformError("PLATFORM_TOOL", "could not list processes");
  return jsonLine(res.stdout, ProcRowsSchema, "process list");
}

/**
 * `root` first, then its descendants (parents before children, so a supervisor cannot
 * respawn a child after its children were killed — review-2 D5). A child counts only if it
 * started at/after its parent: a process whose ParentProcessId points at an earlier holder
 * of a reused PID is not ours (security-1 S5). ISO 'o' UTC strings compare chronologically.
 */
export function descendants(table: readonly ProcRow[], root: ProcRow): ProcRow[] {
  const out: ProcRow[] = [root];
  const seen = new Set<number>([root.i]);
  const walk = (parent: ProcRow): void => {
    for (const r of table) {
      if (r.p !== parent.i || seen.has(r.i) || r.c === "" || r.c < parent.c) continue;
      seen.add(r.i);
      out.push(r);
      walk(r);
    }
  };
  walk(root);
  return out;
}

async function killTree(pid: number, expectStartedAt: string): Promise<void> {
  checkPid(pid);
  const table = await processTable();
  const root = table.find((r) => r.i === pid);
  if (root === undefined) return; // already gone
  if (root.c === "") {
    throw new PlatformError("PLATFORM_TOOL", `cannot read the start time of PID ${pid}`);
  }
  if (root.c !== expectStartedAt) {
    // PID reused by another program: never kill it
    throw new PlatformError("PROCESS_MISMATCH", `PID ${pid} is not the process webhub started`);
  }
  const tree = descendants(table, root);
  const res = await runExe("kill", "taskkill.exe", [
    "/F",
    ...tree.flatMap((r) => ["/PID", String(r.i)]),
  ]);
  const deadline = Date.now() + KILL_WAIT_MS;
  for (let poll = 0; ; poll++) {
    const now = await processTable();
    const alive = tree.filter((t) => now.some((r) => r.i === t.i && r.c === t.c));
    if (alive.length === 0) return;
    const rootAlive = alive.some((r) => r.i === pid);
    // taskkill reported an error (exit 128 also covers "some PID already gone") and the root
    // is still there on the 2nd look (~1 s later) → refused (e.g. access denied): fail now
    if ((poll >= 1 && res.code !== 0 && rootAlive) || Date.now() >= deadline) {
      throw new PlatformError("PROCESS_KILL_FAILED", `could not stop PID ${pid}`, {
        // taskkill text is localized in the OEM codepage → report the exit code only (D14)
        details: [
          `still running: ${alive.map((r) => r.i).join(", ")}`,
          `taskkill exit ${res.code}`,
        ],
      });
    }
    await sleep(100);
  }
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
    const res = await runPs(
      "process usage",
      [
        "$ErrorActionPreference = 'Stop'",
        `$r = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { @{ i = [int64]$_.ProcessId; k = [double]$_.KernelModeTime; u = [double]$_.UserModeTime; w = [double]$_.WorkingSetSize } })`,
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

const realPath = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p; // missing → reported by the existence check
  }
};

/**
 * Absolute REAL paths (links resolved — security-2 T4) of node and of the BUILT,
 * self-contained elevated entry. The same paths are checked and launched; nothing is looked
 * up through PATH. Always `<package>/dist/platform/elevated.mjs`, also when webhub runs from
 * source: node cannot run the .mts source directly (review-1 C6).
 */
export function elevatedCommand(): { exe: string; script: string } {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return {
    exe: realPath(process.execPath),
    script: realPath(join(root, "dist", "platform", "elevated.mjs")),
  };
}

/** Fixed script; exe, script path and token arrive as stdin fields. */
export const ELEVATE_PS = [
  "$ErrorActionPreference = 'Stop'",
  PS_READ_FIELDS,
  "if ($f.Count -ne 3) { [Console]::Out.WriteLine('FAIL:input'); exit 0 }",
  "try {",
  "  $si = New-Object Diagnostics.ProcessStartInfo",
  "  $si.FileName = $f[0]",
  "  $si.Arguments = '\"' + $f[1] + '\" ' + $f[2]",
  "  $si.Verb = 'runas'",
  "  $si.UseShellExecute = $true",
  "  $si.WorkingDirectory = [Environment]::SystemDirectory",
  "  $si.WindowStyle = 'Hidden'",
  "  $p = [Diagnostics.Process]::Start($si)",
  "  $p.WaitForExit()",
  "  [Console]::Out.WriteLine('EXIT:' + $p.ExitCode)",
  "} catch {",
  "  $e = $_.Exception",
  "  while ($e -ne $null -and -not ($e -is [ComponentModel.Win32Exception])) { $e = $e.InnerException }",
  // 1223 = ERROR_CANCELLED: the user answered No. Anything else is a real failure (C3 / S4).
  "  if ($e -ne $null -and $e.NativeErrorCode -eq 1223) { [Console]::Out.WriteLine('DENIED') }",
  "  else { [Console]::Out.WriteLine('FAIL:' + $_.Exception.GetType().Name + ' ' + $(if ($e) { $e.NativeErrorCode } else { '' })) }",
  "}",
].join("\n");

/** Waits a little longer than a token lives, so a late "Yes" can only hit an expired token. */
const ELEVATE_TIMEOUT_MS = TOKEN_MAX_AGE_MS + 30_000;

/** Maps the PowerShell result of ELEVATE_PS to success or a PlatformError (exported for tests). */
export function elevateOutcome(stdout: string, code: number): void {
  const line = stdout.split(/\r?\n/).find((l) => /^(EXIT:|DENIED|FAIL:)/.test(l)) ?? "";
  if (line === "EXIT:0") return;
  if (line === "DENIED") {
    throw new PlatformError("ELEVATION_DENIED", "administrator permission was not granted");
  }
  if (line === "EXIT:3") {
    throw new PlatformError("ELEVATION_EXPIRED", "the request expired before it was approved", {
      hint: "Nothing was changed. Try again and answer the Windows prompt within 5 minutes.",
    });
  }
  if (line === "" && code === -1) {
    throw new PlatformError("ELEVATION_FAILED", "timed out waiting for the Windows prompt", {
      hint: "Nothing was changed. If the prompt is still open, answering it now does nothing.",
    });
  }
  throw new PlatformError("ELEVATION_FAILED", "the elevated task failed", {
    details: [line === "" ? `PowerShell exited with code ${code}` : line],
  });
}

/**
 * Everything that would let a non-administrator change what runs elevated (S1 / T1–T4):
 * registry environment (incl. volatile keys) + this process's environment as a backstop
 * in case it is inherited, and owner/ACL of node.exe, elevated.mjs, their folders and every
 * ancestor folder.
 */
export async function elevationProblems(exe: string, script: string): Promise<string[]> {
  return [
    ...nodeEnvProblems([...(await persistentEnvNames()), ...Object.keys(process.env)]),
    ...(await pathTrustProblems(trustTargets(elevationFiles(exe, script)))),
  ];
}

async function elevate(input: unknown): Promise<void> {
  const task = parseTask(input); // refuse before any UAC prompt
  const { exe, script } = elevatedCommand();
  if (!existsSync(exe) || !existsSync(script)) {
    throw new PlatformError("ELEVATION_FAILED", "webhub's elevated helper was not found", {
      details: [script],
      hint: "Reinstall webhub (or run `pnpm build` when working from source).",
    });
  }
  const problems = await elevationProblems(exe, script);
  if (problems.length > 0) {
    throw new PlatformError(
      "ELEVATION_UNSAFE",
      "refusing to ask for administrator rights: a non-administrator could change what would run",
      {
        details: problems.slice(0, 20),
        hint: "Install Node.js and webhub in a folder only administrators can change (e.g. C:\\Program Files) and remove NODE_* (except NODE_ENV), OPENSSL_*, SSL_CERT_* and UV_* variables from the user/system environment and from the shell that starts webhub.",
      },
    );
  }
  const res = await runPs(
    "elevate",
    ELEVATE_PS,
    fields([exe, script, encodeTask(task)]),
    ELEVATE_TIMEOUT_MS,
  );
  elevateOutcome(res.stdout, res.code);
}

// ---------- notify ----------

const TOAST_AUMID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Strips control characters, characters XML forbids (U+FFFE/U+FFFF, lone surrogates) and
 * caps the length in code points (never splits a surrogate pair).
 */
export function cleanText(s: string, max: number): string {
  const t = s
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters on purpose
    .replace(/[\u0000-\u001f\u007f\ufffe\uffff]/g, " ")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, " ")
    .trim();
  const cps = Array.from(t);
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : t;
}

/** Fixed script; title/body arrive as stdin fields and are XML-escaped before use. */
export const NOTIFY_PS = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  `  ${PS_READ_FIELDS}`,
  "  if ($f.Count -ne 2) { throw 'input' }",
  "  $t = [Security.SecurityElement]::Escape($f[0])",
  "  $b = [Security.SecurityElement]::Escape($f[1])",
  "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
  "  $x = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "  $x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>' + $t + '</text><text>' + $b + '</text></binding></visual></toast>')",
  `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_AUMID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  "  [Console]::Out.WriteLine('OK')",
  "} catch { [Console]::Out.WriteLine('FAIL:' + $_.Exception.GetType().Name) }",
].join("\n");

/** notify with an injectable runner (tests check the script never contains the text). */
export async function notifyVia(run: PsRunner, title: string, body: string): Promise<boolean> {
  try {
    const res = await runPs(
      "notify",
      NOTIFY_PS,
      fields([cleanText(title, 100), cleanText(body, 500)]),
      undefined,
      run,
    );
    const lines = res.stdout.split(/\r?\n/);
    if (lines.includes("OK")) return true;
    platformLog(`notify failed: ${lines.find((l) => l.startsWith("FAIL")) ?? `exit ${res.code}`}`);
    return false;
  } catch (err) {
    platformLog(`notify failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export const win32Platform: Platform = {
  name: "win32",
  ports: { listening, reserved, canBind, findFree },
  process: { info, killTree, usage },
  elevate,
  notify: (title, body) => notifyVia(powershell, title, body),
  capabilities: () => ({ resolvesLocalhostSubdomains: false, dockerTopology: "host-gateway" }),
};
