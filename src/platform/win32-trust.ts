/**
 * Pre-elevation checks (security-1 S1). The elevated process runs node.exe + webhub's code
 * from disk. If a non-administrator can change any of that code, or set a NODE_* variable
 * that node reads at startup, then a program running as the user could get its own code run
 * as administrator the next time the user accepts a UAC prompt. In that case webhub refuses
 * to elevate (ELEVATION_UNSAFE) instead of asking.
 *
 * Known limits (documented in spec §6): files inside a checked folder that carry their own
 * explicit ACL are not walked one by one; there is a short window between check and use.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Everything the elevated node loads, plus every ancestor folder (renaming an ancestor would
 * swap the whole tree).
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

/** Paths the elevated process depends on: node.exe, the package's dist/platform code, zod. */
export function elevationFiles(exe: string, root: string): string[] {
  const dist = join(root, "dist");
  const plat = join(dist, "platform");
  const out = [
    exe,
    dirname(exe),
    root,
    join(root, "package.json"),
    dist,
    plat,
    join(plat, "elevated.js"),
    join(plat, "tasks.js"),
    join(plat, "types.js"),
    join(root, "node_modules"),
  ];
  try {
    // real location (pnpm links into node_modules/.pnpm); its ancestors are checked too
    const entry = realpathSync(fileURLToPath(import.meta.resolve("zod")));
    out.push(entry);
    let d = dirname(entry);
    while (dirname(d) !== d && basename(d) !== "zod") d = dirname(d);
    out.push(d, join(d, "package.json"));
  } catch {
    // zod not resolvable → the elevated process will fail anyway; nothing extra to check
  }
  return out;
}

const NODE_ENV_ALLOWED = new Set(["NODE_ENV"]);

/** NODE_* variables that change how node starts (NODE_OPTIONS --import, NODE_PATH …). */
export function nodeEnvProblems(names: readonly string[]): string[] {
  return names
    .filter((n) => /^NODE_/i.test(n) && !NODE_ENV_ALLOWED.has(n.toUpperCase()))
    .map((n) => `environment variable ${n} is set (node reads it at startup)`);
}

const TRUST_PS = [
  "$ErrorActionPreference = 'Stop'",
  PS_READ_FIELDS,
  `$trusted = @(${TRUSTED_SIDS.map((s) => `'${s}'`).join(",")})`,
  // WriteData|AppendData|DeleteChild|Delete|WriteDac|WriteOwner|GenericAll|GenericWrite
  "$full = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000",
  // DeleteChild|Delete|WriteDac|WriteOwner|GenericAll
  "$anc = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000",
  "$out = @()",
  "foreach ($item in $f) {",
  "  $mode = $item.Substring(0, 1); $path = $item.Substring(2)",
  "  $mask = if ($mode -eq 'F') { $full } else { $anc }",
  "  if (-not (Test-Path -LiteralPath $path)) { if ($mode -eq 'F') { $out += @{ p = $path; r = 'missing' } }; continue }",
  "  try {",
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

const ENV_PS = [
  "$ErrorActionPreference = 'Stop'",
  "$n = @()",
  "foreach ($k in @('HKCU:\\Environment', 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')) {",
  "  if (Test-Path -LiteralPath $k) { $n += @((Get-Item -LiteralPath $k).GetValueNames()) }",
  "}",
  "'JSON:' + (ConvertTo-Json -InputObject @($n) -Compress)",
].join("\n");

/** Names of persistent user + machine environment variables (what an elevated process gets). */
export async function persistentEnvNames(): Promise<string[]> {
  const res = await runPs("environment", ENV_PS);
  return jsonLine(res.stdout, z.array(z.string()), "environment");
}
