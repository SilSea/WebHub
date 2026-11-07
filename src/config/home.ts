import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { WebhubError } from "../errors.js";
import { assertSafePath } from "../fs/safe-path.js";
import { execFile, systemExe } from "../proc/exec.js";

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
 * (Windows: ACL current user + SYSTEM only; POSIX: 0700). Refuses a symlinked home.
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
  await restrictToCurrentUser(paths.home);
  for (const key of DIRS) {
    await assertSafePath(paths.home, paths[key]);
    await mkdir(paths[key], { recursive: true, mode: 0o700 });
  }
}

/** Windows: replace inherited ACL with current user + SYSTEM (inheritable). POSIX: chmod 700. */
export async function restrictToCurrentUser(dir: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
    return;
  }
  const sid = await currentUserSid();
  const res = await execFile(systemExe("icacls.exe"), [
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "/grant:r",
    "*S-1-5-18:(OI)(CI)F",
  ]);
  if (res.code !== 0) {
    throw new WebhubError("HOME_INVALID", `could not restrict permissions on ${dir}`, {
      file: dir,
      details: [res.stderr.trim() || res.stdout.trim()],
    });
  }
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
