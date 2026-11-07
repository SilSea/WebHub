/**
 * Pre-elevation checks (security-1 S1, security-2 T1–T5). The elevated process runs node.exe
 * and webhub's self-contained `elevated.mjs` from disk. If a non-administrator can change
 * either of them (or a folder above them), or has set an environment variable that node acts
 * on at startup, then a program running as another user / with the user's rights could get
 * its own code run as administrator the next time the user accepts a UAC prompt. In that case
 * webhub refuses to elevate (ELEVATION_UNSAFE) instead of asking.
 *
 * Paths are real paths (links resolved) and the SAME real paths are launched (T4).
 * Known limits (spec §6): check→use window (TOCTOU); a program already running as the same
 * user can show its own UAC prompt or tamper with this check — the real fix is the planned
 * Program Files helper (CR).
 */
import { readdirSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { z } from "zod";
import { fields, jsonLine, PS_READ_FIELDS, runPs } from "./win32-shell.js";

/** SYSTEM, Administrators, TrustedInstaller. */
export const TRUSTED_SIDS = [
  "S-1-5-18",
  "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
] as const;

/** `F` = nobody else may write/delete/re-permission it; `A` (ancestor) = nobody else may rename/delete/re-permission it. */
export type TrustMode = "F" | "A";

/**
 * The given paths (full check) plus every ancestor folder (renaming an ancestor would swap the
 * whole tree).
 */
export function trustTargets(files: readonly string[]): [TrustMode, string][] {
  const full = new Set<string>();
  for (const f of files) full.add(f);
  const anc = new Set<string>();
  for (const f of full) {
    let d = dirname(f);
    while (true) {
      if (!full.has(d)) anc.add(d);
      const up = dirname(d);
      if (up === d || d === parse(d).root) break;
      d = up;
    }
  }
  return [
    ...[...full].map((p): [TrustMode, string] => ["F", p]),
    ...[...anc].map((p): [TrustMode, string] => ["A", p]),
  ];
}

/**
 * Everything the elevated process loads from disk: node.exe, its folder (DLL search order
 * starts there), every DLL / manifest / `.local` redirection entry already in that folder
 * (security-3 U3), the self-contained elevated.mjs and its folder. Paths must be real paths.
 */
export function elevationFiles(
  exe: string,
  script: string,
  nodeDirEntries: readonly string[] = [],
): string[] {
  const loaderFiles = nodeDirEntries
    .filter((n) => /\.(dll|manifest|local)$/i.test(n))
    .map((n) => join(dirname(exe), n));
  return [exe, dirname(exe), ...loaderFiles, script, dirname(script)];
}

/** Names in node.exe's folder (for `elevationFiles`); unreadable folder → reported by the ACL check. */
export function nodeDirEntries(exe: string): string[] {
  try {
    return readdirSync(dirname(exe));
  } catch {
    return [];
  }
}

/**
 * Environment variables node (or its OpenSSL / libuv) acts on at startup, before any JS:
 * NODE_OPTIONS (--import/--require), NODE_PATH, NODE_ICU_DATA, NODE_COMPILE_CACHE …,
 * OPENSSL_CONF / OPENSSL_MODULES (provider DLL load — T1), SSL_CERT_*, UV_*, ICU_* (ICU data
 * files — security-3 U2).
 * Denylist by prefix, not an allowlist: unrelated variables (JAVA_HOME, GOPATH …) are common
 * on dev machines and do not affect node.exe (decision recorded in spec §3.3).
 *
 * Any name with a non-ASCII character is refused too (security-3 U1): OpenSSL reads its
 * variables through the narrow CRT `getenv`, where Windows "best-fit" maps look-alikes
 * (fullwidth Ｏ, Ś, Ō, ＿ …) onto ASCII — `ＯPENSSL_CONF` acts as `OPENSSL_CONF`.
 */
const RISKY_ENV = /^(NODE_|OPENSSL_|SSL_CERT_|UV_|ICU_)/i;
const NON_ASCII = /[^\x20-\x7e]/;
const ENV_ALLOWED = new Set(["NODE_ENV"]);

export function nodeEnvProblems(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = n.toUpperCase();
    if (seen.has(key)) continue;
    if (NON_ASCII.test(n)) {
      seen.add(key);
      out.push(
        `environment variable ${JSON.stringify(n)} has non-ASCII characters (Windows may map it to a variable node reads)`,
      );
      continue;
    }
    if (!RISKY_ENV.test(n) || ENV_ALLOWED.has(key)) continue;
    seen.add(key);
    out.push(`environment variable ${n} is set (node reads it at startup)`);
  }
  return out;
}

const TRUST_PS = [
  "$ErrorActionPreference = 'Stop'",
  PS_READ_FIELDS,
  `$trusted = @(${TRUSTED_SIDS.map((s) => `'${s}'`).join(",")})`,
  // WriteData|AppendData|WriteEA|DeleteChild|WriteAttributes|Delete|WriteDac|WriteOwner|GenericAll|GenericWrite
  "$full = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000",
  // DeleteChild|Delete|WriteDac|WriteOwner|GenericAll
  "$anc = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000",
  "$out = @()",
  "foreach ($item in $f) {",
  "  $mode = $item.Substring(0, 1); $path = $item.Substring(2)",
  "  $mask = if ($mode -eq 'F') { $full } else { $anc }",
  "  try {",
  // inside try: an unreadable ancestor makes Test-Path throw → 'unreadable', not a tool error (U6)
  "    if (-not (Test-Path -LiteralPath $path)) { if ($mode -eq 'F') { $out += @{ p = $path; r = 'missing' } }; continue }",
  "    $acl = Get-Acl -LiteralPath $path",
  "    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value",
  "    if ($trusted -notcontains $owner) { $out += @{ p = $path; r = ('owner ' + $owner) } }",
  "    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {",
  "      if ($ace.AccessControlType -ne 'Allow') { continue }",
  "      if (($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }",
  "      $sid = $ace.IdentityReference.Value",
  "      if ($trusted -contains $sid -or $sid -eq 'S-1-3-0') { continue }",
  "      if (([int64]$ace.FileSystemRights -band $mask) -ne 0) { $out += @{ p = $path; r = ('writable by ' + $sid) } }",
  "    }",
  "  } catch { $out += @{ p = $path; r = 'unreadable' } }",
  "}",
  "'JSON:' + (ConvertTo-Json -InputObject @($out) -Compress)",
].join("\n");

const TrustSchema = z.array(z.object({ p: z.string(), r: z.string() }));

/** Problems ("<path>: <reason>") for paths a non-administrator could change. */
export async function pathTrustProblems(
  targets: readonly [TrustMode, string][],
): Promise<string[]> {
  const res = await runPs(
    "path trust",
    TRUST_PS,
    fields(targets.map(([m, p]) => `${m}:${p}`)),
    60_000,
  );
  const rows = jsonLine(res.stdout, TrustSchema, "path trust");
  return rows.map((r) => `${r.p}: ${r.r}`);
}

/**
 * Every registry source CreateEnvironmentBlock merges into a new logon environment (T2):
 * machine, user, and the user's volatile keys incl. per-session subkeys.
 */
export const ENV_PS = [
  "$ErrorActionPreference = 'Stop'",
  "$n = @()",
  "$keys = @('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU:\\Environment', 'HKCU:\\Volatile Environment')",
  "if (Test-Path -LiteralPath 'HKCU:\\Volatile Environment') { $keys += @(Get-ChildItem -LiteralPath 'HKCU:\\Volatile Environment' | ForEach-Object { $_.PSPath }) }",
  "foreach ($k in $keys) {",
  "  if (Test-Path -LiteralPath $k) { $n += @((Get-Item -LiteralPath $k).GetValueNames()) }",
  "}",
  "'JSON:' + (ConvertTo-Json -InputObject @($n) -Compress)",
].join("\n");

/** Names of persistent + volatile user/machine environment variables (what an elevated process gets). */
export async function persistentEnvNames(): Promise<string[]> {
  const res = await runPs("environment", ENV_PS);
  return jsonLine(res.stdout, z.array(z.string()), "environment");
}
