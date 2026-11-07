import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
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
 * owned by someone else, and a home whose parent another user controls (DESIGN §21.6).
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
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
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
  const input = `${targets.map((t) => `b:${Buffer.from(t, "utf8").toString("base64")}`).join("\n")}\n`;
  const res = await powershell(script, input);
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
      hint: "Use a folder under your own user profile (the default %APPDATA%webhub is safe).",
    });
  }
}

/**
 * Ensures only the current user (+ SYSTEM on Windows) can access the home and everything in it.
 * Windows: if the home ACL is not exactly ours, reset the whole tree to inherited ACLs, then
 * protect the home (children inherit). POSIX: if group/other bits are set anywhere, strip them.
 */
async function secureTree(home: string): Promise<void> {
  if (process.platform !== "win32") {
    if (((await lstat(home)).mode & 0o077) !== 0) await stripGroupOther(home);
    return;
  }
  const me = await currentUserSid();
  const [acl] = await readAcls([home]);
  const exact =
    acl?.protected === true &&
    acl.rules.length > 0 &&
    acl.rules.every((r) => {
      const [sid, inherited, type] = r.split("|");
      return (sid === me || sid === SYSTEM_SID) && inherited === "False" && type === "Allow";
    });
  if (exact) return;
  await icacls([home, "/reset", "/T", "/C", "/Q"]);
  await restrictToCurrentUser(home);
}

async function stripGroupOther(dir: string): Promise<void> {
  await chmod(dir, (await lstat(dir)).mode & 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await stripGroupOther(p);
    else await chmod(p, (await lstat(p)).mode & 0o700);
  }
}

async function icacls(args: string[]): Promise<void> {
  const res = await execFile(systemExe("icacls.exe"), args, { timeoutMs: 300_000 });
  if (res.code !== 0) {
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
