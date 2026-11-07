import { chmod, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { WebhubError } from "../errors.js";
import { assertSafePath } from "../fs/safe-path.js";
import { execFile, powershell, systemExe } from "../proc/exec.js";

export interface Paths {
  home: string;
  config: string;
  data: string;
  sites: string;
  compose: string;
  profiles: string;
  backups: string;
  venvs: string;
  ports: string;
  infra: string;
  state: string;
  secrets: string;
  auth: string;
  lock: string;
  logs: string;
  runtimes: string;
  nginx: string;
  docker: string;
}

/** `$WEBHUB_HOME`: env WEBHUB_HOME (absolute) → per-OS default (DESIGN §21.4). */
export function resolveHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homedir: string,
): string {
  const fromEnv = env.WEBHUB_HOME;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isAbsolute(fromEnv)) {
      throw new WebhubError("HOME_INVALID", `WEBHUB_HOME must be an absolute path: ${fromEnv}`, {
        hint: "Set WEBHUB_HOME to a full path, e.g. C:\\Users\\me\\AppData\\Roaming\\webhub-dev",
      });
    }
    return checkNotDriveRoot(resolve(fromEnv));
  }
  let home: string;
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData === undefined || !isAbsolute(appData)) {
      throw new WebhubError("HOME_INVALID", "APPDATA is not set; set WEBHUB_HOME instead");
    }
    home = join(appData, "webhub");
  } else if (platform === "darwin") {
    home = join(homedir, "Library", "Application Support", "webhub");
  } else {
    const xdg = env.XDG_DATA_HOME;
    home =
      xdg !== undefined && isAbsolute(xdg)
        ? join(xdg, "webhub")
        : join(homedir, ".local", "share", "webhub");
  }
  return checkNotDriveRoot(resolve(home));
}

function checkNotDriveRoot(home: string): string {
  if (parse(home).root === home) {
    throw new WebhubError(
      "HOME_INVALID",
      `WEBHUB_HOME must not be a drive/filesystem root: ${home}`,
    );
  }
  return home;
}

export function pathsFor(home: string): Paths {
  const data = join(home, "data");
  return {
    home,
    config: join(home, "webhub.config.json"),
    data,
    sites: join(data, "sites"),
    compose: join(data, "compose"),
    profiles: join(data, "profiles"),
    backups: join(data, "backups"),
    venvs: join(data, "venvs"),
    ports: join(data, "ports.json"),
    infra: join(data, "infra.json"),
    state: join(data, "state.json"),
    secrets: join(data, "secrets.json"),
    auth: join(data, "auth.json"),
    lock: join(data, ".lock"),
    logs: join(home, "logs"),
    runtimes: join(home, "runtimes"),
    nginx: join(home, "nginx"),
    docker: join(home, "docker"),
  };
}

const DIRS: readonly (keyof Paths)[] = [
  "data",
  "sites",
  "compose",
  "profiles",
  "backups",
  "venvs",
  "logs",
  "runtimes",
  "nginx",
  "docker",
];

/**
 * Creates the home layout and restricts access to the current user
 * (Windows: ACL current user + SYSTEM only; POSIX: 0700). Refuses a symlinked home, a home
 * owned by someone else, a home whose parent another user controls, and any entry inside the
 * home that is a junction/reparse point or owned by another user (DESIGN §21.6).
 */
export async function ensureHome(paths: Paths): Promise<void> {
  const st = await lstat(paths.home).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (st?.isSymbolicLink()) {
    throw new WebhubError("SYMLINK_REFUSED", `WEBHUB_HOME must not be a symlink/junction`, {
      file: paths.home,
    });
  }
  if (st !== null && !st.isDirectory()) {
    throw new WebhubError("HOME_INVALID", `WEBHUB_HOME is not a directory`, { file: paths.home });
  }
  if (process.platform === "win32") await currentUserSid(); // resolve before the dir exists
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  // lock the home down BEFORE auditing it: afterwards nobody else can add entries, so the
  // audit sees everything that will ever be inside (review-3 F1). New home: at once.
  if (st === null || !(await homeIsExact(paths.home))) await restrictToCurrentUser(paths.home);
  await assertTrustedOwner(paths.home);
  await secureTree(paths.home);
  for (const key of DIRS) {
    await assertSafePath(paths.home, paths[key]);
    await mkdir(paths[key], { recursive: true, mode: 0o700 });
  }
}

const SYSTEM_SID = "S-1-5-18";
const ADMINS_SID = "S-1-5-32-544";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/** Written after a full audit of the tree succeeded; absent → audit again. */
const SECURED_MARKER = ".webhub-secured";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

interface AclInfo {
  owner: string;
  protected: boolean;
  /** "<sid>|<inherited True/False>|<Allow/Deny>" */
  rules: string[];
}

/** Owner + access rules (as SIDs) of each path, via Get-Acl. Paths travel over stdin. */
async function readAcls(targets: readonly string[]): Promise<AclInfo[]> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = [System.Security.Principal.SecurityIdentifier]",
    "$lines = [Console]::In.ReadToEnd() -split \"`n\" | Where-Object { $_.StartsWith('b:') }",
    "foreach ($l in $lines) {",
    "  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l.Substring(2).Trim()))",
    "  $a = Get-Acl -LiteralPath $p",
    "  $r = @($a.GetAccessRules($true, $true, $sid) | ForEach-Object { $_.IdentityReference.Value + '|' + $_.IsInherited + '|' + $_.AccessControlType })",
    "  [Console]::Out.WriteLine('ACL:' + (@{ owner = $a.GetOwner($sid).Value; protected = $a.AreAccessRulesProtected; rules = $r } | ConvertTo-Json -Compress))",
    "}",
  ].join("\n");
  const res = await powershell(script, `${targets.map((t) => `b:${b64(t)}`).join("\n")}\n`);
  const out = res.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("ACL:"))
    .map((l) => JSON.parse(l.slice(4)) as AclInfo);
  if (res.code !== 0 || out.length !== targets.length) {
    throw new WebhubError("HOME_INVALID", "could not read permissions of WEBHUB_HOME", {
      file: targets[0] ?? "",
    });
  }
  return out.map((a) => ({ ...a, rules: Array.isArray(a.rules) ? a.rules : [a.rules] }));
}

/**
 * Another local user must not own the home (owner keeps WRITE_DAC and could re-open it) nor
 * its parent (could rename/replace the home). POSIX: uid of home = us; parent = us or root.
 */
async function assertTrustedOwner(home: string): Promise<void> {
  const parent = dirname(home);
  if (process.platform !== "win32") {
    const uid = process.getuid?.() ?? -1;
    const [h, p] = [await lstat(home), await lstat(parent)];
    if (h.uid !== uid || !(p.uid === uid || p.uid === 0)) {
      throw new WebhubError("HOME_INVALID", "WEBHUB_HOME or its parent is owned by another user", {
        file: home,
        hint: "Use a folder under your own user profile (the default location is safe).",
      });
    }
    return;
  }
  const me = await currentUserSid();
  const [h, p] = await readAcls([home, parent]);
  const okHome = h !== undefined && (h.owner === me || h.owner === ADMINS_SID);
  const okParent =
    p !== undefined && [me, SYSTEM_SID, ADMINS_SID, TRUSTED_INSTALLER_SID].includes(p.owner);
  if (!okHome || !okParent) {
    throw new WebhubError("HOME_INVALID", "WEBHUB_HOME or its parent is owned by another user", {
      file: home,
      details: [`home owner: ${h?.owner ?? "?"}`, `parent owner: ${p?.owner ?? "?"}`],
      hint: "Use a folder under your own user profile (the default %APPDATA%\\webhub is safe).",
    });
  }
}

/** Problems found by a tree audit (paths are absolute). */
interface Audit {
  reparse: string[];
  foreignOwner: string[];
  unreadable: string[];
  /** Windows: entries with their own (explicit or protected) ACL → reset to inherited. */
  reset: string[];
}

/**
 * Ensures only the current user (+ SYSTEM on Windows) can access the home and everything in it.
 * Fast path: home ACL/mode already exact and a previous full audit succeeded (marker).
 * Otherwise: audit the whole tree without following junctions/symlinks, refuse reparse points
 * (Windows) and entries owned by others, reset entries with their own ACL one by one, then
 * protect the home (children inherit) and write the marker.
 */
async function secureTree(home: string): Promise<void> {
  const marker = join(home, SECURED_MARKER);
  const hasMarker = await lstat(marker).then(
    (s) => s.isFile(),
    () => false,
  );
  if (hasMarker && (await homeIsExact(home))) return;
  const audit = process.platform === "win32" ? await auditWindows(home) : await auditPosix(home);
  if (audit.reparse.length > 0) {
    throw new WebhubError("SYMLINK_REFUSED", "WEBHUB_HOME contains junctions/symlinks", {
      file: home,
      details: audit.reparse,
      hint: "Remove the listed links (webhub never follows links inside its home).",
    });
  }
  if (audit.foreignOwner.length > 0) {
    throw new WebhubError("HOME_INVALID", "WEBHUB_HOME contains entries owned by another user", {
      file: home,
      details: audit.foreignOwner,
      hint: "Delete the listed entries (or the whole home) and start webhub again.",
    });
  }
  if (audit.unreadable.length > 0) {
    throw new WebhubError("HOME_INVALID", "could not read some entries inside WEBHUB_HOME", {
      file: home,
      details: audit.unreadable,
      hint: "Check the permissions of the listed entries, or delete them, then start again.",
    });
  }
  if (process.platform === "win32") {
    // /L: act on a link itself, never its target (defence in depth; links were refused above)
    for (const p of audit.reset) await icacls([p, "/reset", "/L", "/Q"]);
    if (!(await homeIsExact(home))) await restrictToCurrentUser(home);
  } else {
    await chmod(home, 0o700);
  }
  await writeFile(marker, "1\n", { mode: 0o600 });
}

async function homeIsExact(home: string): Promise<boolean> {
  if (process.platform !== "win32") return ((await lstat(home)).mode & 0o077) === 0;
  const me = await currentUserSid();
  const [acl] = await readAcls([home]);
  return (
    acl?.protected === true &&
    acl.rules.length > 0 &&
    acl.rules.every((r) => {
      const [sid, inherited, type] = r.split("|");
      return (sid === me || sid === SYSTEM_SID) && inherited === "False" && type === "Allow";
    })
  );
}

/** Walks the tree in one PowerShell process; never descends into reparse points. */
async function auditWindows(home: string): Promise<Audit> {
  const me = await currentUserSid(); // validated S-1-… string, safe to embed
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = [System.Security.Principal.SecurityIdentifier]",
    `$ok = @('${me}', '${SYSTEM_SID}', '${ADMINS_SID}')`,
    "function B($s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }",
    "function W($s) { [Console]::Out.WriteLine($s) }",
    "$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim().Substring(2)))",
    "$stack = New-Object System.Collections.Stack",
    "$stack.Push($root)",
    "while ($stack.Count -gt 0) {",
    "  $dir = $stack.Pop()",
    "  try { $entries = [System.IO.Directory]::GetFileSystemEntries($dir) } catch { W ('ERR:' + (B $dir)); continue }",
    "  foreach ($e in $entries) {",
    "    try {",
    "      $attr = [System.IO.File]::GetAttributes($e)",
    "      if ($attr -band [System.IO.FileAttributes]::ReparsePoint) { W ('REPARSE:' + (B $e)); continue }",
    "      $a = Get-Acl -LiteralPath $e",
    "      if ($ok -notcontains $a.GetOwner($sid).Value) { W ('OWNER:' + (B $e)) }",
    "      $explicit = @($a.GetAccessRules($true, $false, $sid))",
    "      if ($a.AreAccessRulesProtected -or $explicit.Count -gt 0) { W ('RESET:' + (B $e)) }",
    "      if ($attr -band [System.IO.FileAttributes]::Directory) { $stack.Push($e) }",
    // an entry deleted between listing and inspection (e.g. a temp file) is not a problem
    "    } catch { if (Test-Path -LiteralPath $e) { W ('ERR:' + (B $e)) } }",
    "  }",
    "}",
    "W 'DONE'",
  ].join("\n");
  const res = await powershell(script, `b:${b64(home)}\n`, 600_000);
  const lines = res.stdout.split(/\r?\n/);
  if (res.code !== 0 || !lines.includes("DONE")) {
    throw new WebhubError("HOME_INVALID", "could not audit permissions of WEBHUB_HOME", {
      file: home,
    });
  }
  const pick = (tag: string) =>
    lines.filter((l) => l.startsWith(`${tag}:`)).map((l) => unb64(l.slice(tag.length + 1)));
  return {
    reparse: pick("REPARSE"),
    foreignOwner: pick("OWNER"),
    unreadable: pick("ERR"),
    reset: pick("RESET"),
  };
}

/** POSIX: symlinks are not followed (left as is); foreign owners refused; group/other stripped. */
async function auditPosix(home: string): Promise<Audit> {
  const uid = process.getuid?.() ?? -1;
  const audit: Audit = { reparse: [], foreignOwner: [], unreadable: [], reset: [] };
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      const st = await lstat(p);
      if (st.uid !== uid) {
        audit.foreignOwner.push(p);
        continue;
      }
      if ((st.mode & 0o077) !== 0) await chmod(p, st.mode & 0o700);
      if (entry.isDirectory()) await walk(p);
    }
  };
  await walk(home);
  return audit;
}

/** Runs icacls; any failed entry (icacls can exit 0 with failures) is an error. */
async function icacls(args: string[]): Promise<void> {
  const res = await execFile(systemExe("icacls.exe"), args, { timeoutMs: 300_000 });
  const failed = /Failed processing (\d+)/i.exec(res.stdout);
  if (res.code !== 0 || (failed !== null && failed[1] !== "0")) {
    throw new WebhubError("HOME_INVALID", `could not set permissions on ${args[0] ?? ""}`, {
      file: args[0] ?? "",
      details: [res.stderr.trim() || res.stdout.trim()],
    });
  }
}

/** Windows: replace inherited ACL with current user + SYSTEM (inheritable). POSIX: chmod 700. */
export async function restrictToCurrentUser(dir: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
    return;
  }
  const sid = await currentUserSid();
  await icacls([
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "/grant:r",
    `*${SYSTEM_SID}:(OI)(CI)F`,
  ]);
}

let cachedSid: string | undefined;

/** SID of the current Windows user (from `whoami /user`). */
export async function currentUserSid(): Promise<string> {
  if (cachedSid !== undefined) return cachedSid;
  const res = await execFile(systemExe("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const match = /"(S-1-[0-9-]+)"/.exec(res.stdout);
  if (res.code !== 0 || match?.[1] === undefined) {
    throw new WebhubError("HOME_INVALID", "could not determine current user SID");
  }
  cachedSid = match[1];
  return cachedSid;
}
