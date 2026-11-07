import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { z } from "zod";
import { WebhubError } from "../errors.js";
import { jsonErrorIndex, lineCol } from "../fs/json-position.js";
import { assertSafePath } from "../fs/safe-path.js";
import { assertLock, type Lock } from "./lock.js";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** One step: turns a document of version `from` into version `from + 1`. Must not mutate input. */
export interface Migration {
  from: number;
  migrate(doc: Record<string, unknown>): Record<string, unknown>;
}

export interface DocSpec<T> {
  /** Current schemaVersion. */
  version: number;
  schema: z.ZodType<T>;
  migrations: readonly Migration[];
  /** Values may be credentials: never echoed in errors, no `.bak` copies (secrets.json). */
  sensitive?: boolean;
}

export interface ReadResult<T> {
  value: T;
  /** Set when the file was older and migrated. */
  migratedFrom?: number;
}

export interface ReadOptions {
  home: string;
  /** With a lock, migrated documents are backed up and written back. */
  lock?: Lock;
  backupsDir?: string;
}

/** Reads, migrates and validates a JSON document. Returns undefined when the file does not exist. */
export async function readDoc<T>(
  file: string,
  spec: DocSpec<T>,
  opts: ReadOptions,
): Promise<ReadResult<T> | undefined> {
  const raw = await readJsonFile(file, opts.home, { sensitive: spec.sensitive === true });
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WebhubError("CONFIG_INVALID", "document must be a JSON object", { file });
  }
  const doc = raw as Record<string, unknown>;
  const version = doc.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new WebhubError("CONFIG_INVALID", "missing or invalid schemaVersion", { file });
  }
  if (version > spec.version) {
    throw new WebhubError(
      "CONFIG_FROM_NEWER_VERSION",
      `file was written by a newer webhub (schemaVersion ${version} > ${spec.version}); it was not changed`,
      { file, hint: "Update webhub, or restore an older backup of this file." },
    );
  }
  let current = doc;
  for (let v = version; v < spec.version; v++) {
    const step = spec.migrations.find((m) => m.from === v);
    if (step === undefined) {
      throw new WebhubError("CONFIG_INVALID", `no migration from schemaVersion ${v}`, { file });
    }
    current = { ...step.migrate(structuredClone(current)), schemaVersion: v + 1 };
  }
  const sensitive = spec.sensitive === true;
  const value = validate(spec.schema, current, file, { sensitive });
  if (version === spec.version) return { value };
  if (opts.lock !== undefined) {
    // migration backups are kept even for sensitive docs (values there are encrypted at rest)
    const backups = opts.backupsDir ?? join(opts.home, "data", "backups");
    await backupFile(file, opts.home, backups);
    await writeDoc(opts.lock, file, value, { keepBackup: !sensitive });
  }
  return { value, migratedFrom: version };
}

/** Keys whose values may hold credentials: never echoed in errors. */
const SENSITIVE_KEYS = new Set(["defaultEnv", "entries", "password", "token", "secret"]);

/** Short, non-sensitive received value for an error line ("" when it must not be shown). */
function received(value: unknown, path: readonly PropertyKey[], sensitive: boolean): string {
  if (sensitive || path.some((k) => SENSITIVE_KEYS.has(String(k)))) return "";
  let cur: unknown = value;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return "";
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  if (typeof cur === "number" || typeof cur === "boolean") return ` (got ${String(cur)})`;
  if (typeof cur === "string" && cur.length <= 40) return ` (got ${JSON.stringify(cur)})`;
  return "";
}

export function validate<T>(
  schema: z.ZodType<T>,
  value: unknown,
  file?: string,
  opts: { sensitive?: boolean } = {},
): T {
  const res = schema.safeParse(value);
  if (res.success) return res.data;
  const details = res.error.issues.map((i) => {
    const path = i.path.length === 0 ? "(root)" : i.path.map(String).join(".");
    return `${path}: ${i.message}${received(value, i.path, opts.sensitive === true)}`;
  });
  throw new WebhubError(
    "CONFIG_INVALID",
    `invalid ${file === undefined ? "document" : basename(file)}:\n  ${details.join("\n  ")}`,
    file === undefined ? { details } : { file, details },
  );
}

/** Reads a JSON file inside home safely (no symlinks, size limit). Undefined if missing. */
export async function readJsonFile(
  file: string,
  home: string,
  opts: { sensitive?: boolean } = {},
): Promise<unknown> {
  await assertSafePath(home, file);
  const st = await lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (st === null) return undefined;
  if (st.size > MAX_FILE_BYTES) {
    throw new WebhubError("FILE_TOO_LARGE", `file exceeds ${MAX_FILE_BYTES} bytes`, { file });
  }
  let text = await readFile(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM (PowerShell 5.1 "utf8")
  try {
    return JSON.parse(text);
  } catch {
    // never echo V8's message: it quotes file content, which may contain credentials
    const pos = jsonErrorIndex(text);
    const at = pos < 0 ? "" : ` at ${lineCol(text, pos)}`;
    throw new WebhubError("JSON_PARSE", `invalid JSON${at}`, {
      file,
      hint:
        opts.sensitive === true
          ? "Restore the file from a webhub backup (data/backups), or remove it and set the secrets again."
          : "Fix the file by hand or restore it from the .bak next to it.",
    });
  }
}

/** Atomically writes `value` as JSON: tmp + fsync + rename; keeps the previous version as .bak. */
export async function writeDoc(
  lock: Lock,
  file: string,
  value: unknown,
  opts: { keepBackup?: boolean } = {},
): Promise<void> {
  const keepBackup = opts.keepBackup !== false;
  assertLock(lock, lock.home);
  await lock.verify();
  await assertSafePath(lock.home, file);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
    throw new WebhubError("FILE_TOO_LARGE", `refusing to write more than ${MAX_FILE_BYTES} bytes`, {
      file,
    });
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    const exists = await lstat(file).then(
      () => true,
      () => false,
    );
    if (exists && keepBackup) await copyFile(file, `${file}.bak`);
    await renameWithRetry(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  if (!keepBackup) await rm(`${file}.bak`, { force: true }); // no stale copy of old values
  if (process.platform !== "win32") {
    const dh = await open(dirname(file), "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }
}

/** Windows AV/indexers can briefly hold files open → retry rename on EPERM/EBUSY/EACCES. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
}

/** Copies `file` to <backups>/migrate/<timestamp>/<name> before a migration. */
export async function backupFile(file: string, home: string, backupsDir: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(backupsDir, "migrate", stamp);
  await assertSafePath(home, dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, basename(file));
  await copyFile(file, dest);
  return dest;
}
