import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { z } from "zod";
import { WebhubError } from "../errors.js";
import { powershell } from "../proc/exec.js";
import { type DocSpec, readDoc, writeDoc } from "./json-store.js";
import { assertLock, type Lock } from "./lock.js";

/** Encrypts/decrypts secret bytes for the current user (DESIGN §21.6). */
export interface SecretBackend {
  readonly name: string;
  protect(items: readonly Buffer[]): Promise<Buffer[]>;
  unprotect(items: readonly Buffer[]): Promise<Buffer[]>;
}

const ENTROPY_B64 = Buffer.from("webhub-secrets-v1").toString("base64");

/**
 * Windows DPAPI (CurrentUser) via PowerShell. One process per batch; data travels over stdin
 * (one base64 item per line), never argv.
 */
export const dpapiBackend: SecretBackend = {
  name: "dpapi",
  protect: (items) => runDpapi("Protect", items),
  unprotect: (items) => runDpapi("Unprotect", items),
};

async function runDpapi(op: "Protect" | "Unprotect", items: readonly Buffer[]): Promise<Buffer[]> {
  if (items.length === 0) return [];
  if (process.platform !== "win32") {
    throw new WebhubError("SECRET_BACKEND", "DPAPI is only available on Windows");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    `$entropy = [Convert]::FromBase64String('${ENTROPY_B64}')`,
    "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
    // every item travels as "b:<base64>" so an empty secret is still exactly one line
    "$lines = [Console]::In.ReadToEnd() -split \"`n\" | Where-Object { $_.StartsWith('b:') }",
    "foreach ($l in $lines) {",
    `  $out = [System.Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($l.Substring(2).Trim()), $entropy, $scope)`,
    "  [Console]::Out.WriteLine('b:' + [Convert]::ToBase64String($out))",
    "}",
  ].join("\n");
  const input = `${items.map((b) => `b:${b.toString("base64")}`).join("\n")}\n`;
  const res = await powershell(script, input);
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.startsWith("b:"));
  if (res.code !== 0 || lines.length !== items.length) {
    // stderr from DPAPI never contains the secret (input is only on stdin)
    throw new WebhubError("SECRET_BACKEND", `DPAPI ${op.toLowerCase()} failed`, {
      details: [res.stderr.split(/\r?\n/)[0] ?? ""],
    });
  }
  return lines.map((l) => Buffer.from(l.slice(2).trim(), "base64"));
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const SecretsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  backend: z.string().min(1),
  entries: z.record(z.string().regex(KEY_RE), z.string().min(1)),
});
type SecretsFile = z.infer<typeof SecretsFileSchema>;

export const secretsSpec: DocSpec<SecretsFile> = {
  version: 1,
  schema: SecretsFileSchema,
  migrations: [],
};

/** Random secret (CSPRNG), base64url. */
export function generateSecret(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) throw new RangeError("secret must be >= 16 bytes");
  return randomBytes(bytes).toString("base64url");
}

function checkKey(key: string): void {
  if (!KEY_RE.test(key)) throw new RangeError(`invalid secret key: ${key}`);
}

/**
 * Secrets in data/secrets.json, encrypted per value. Decrypted values live only in memory.
 * Never prints values: inspect/toJSON show the key count only.
 */
export class SecretStore {
  #values = new Map<string, string>();
  #cipher = new Map<string, string>();
  /** Mutations run one at a time so concurrent set/delete never lose an update. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly home: string,
    private readonly backend: SecretBackend,
  ) {}

  static async open(file: string, home: string, backend: SecretBackend): Promise<SecretStore> {
    const store = new SecretStore(file, home, backend);
    const res = await readDoc(file, secretsSpec, { home });
    if (res !== undefined) {
      if (res.value.backend !== backend.name) {
        throw new WebhubError(
          "SECRET_BACKEND",
          `secrets were written with backend "${res.value.backend}", current is "${backend.name}"`,
          { file },
        );
      }
      const keys = Object.keys(res.value.entries);
      const plain = await backend.unprotect(
        keys.map((k) => Buffer.from(res.value.entries[k] ?? "", "base64")),
      );
      keys.forEach((k, i) => {
        store.#cipher.set(k, res.value.entries[k] ?? "");
        store.#values.set(k, plain[i]?.toString("utf8") ?? "");
      });
    }
    return store;
  }

  get size(): number {
    return this.#values.size;
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  get(key: string): string | undefined {
    checkKey(key);
    return this.#values.get(key);
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async set(lock: Lock, key: string, value: string): Promise<void> {
    checkKey(key);
    assertLock(lock, this.home);
    return this.#serial(() => this.#set(lock, key, value));
  }

  async #set(lock: Lock, key: string, value: string): Promise<void> {
    const [enc] = await this.backend.protect([Buffer.from(value, "utf8")]);
    if (enc === undefined) throw new WebhubError("SECRET_BACKEND", "protect returned nothing");
    const cipher = new Map(this.#cipher).set(key, enc.toString("base64"));
    await this.#persist(lock, cipher);
    this.#cipher = cipher;
    this.#values.set(key, value);
  }

  async delete(lock: Lock, key: string): Promise<void> {
    checkKey(key);
    assertLock(lock, this.home);
    return this.#serial(() => this.#delete(lock, key));
  }

  async #delete(lock: Lock, key: string): Promise<void> {
    if (!this.#cipher.has(key)) return;
    const cipher = new Map(this.#cipher);
    cipher.delete(key);
    await this.#persist(lock, cipher);
    this.#cipher = cipher;
    this.#values.delete(key);
  }

  async #persist(lock: Lock, cipher: Map<string, string>): Promise<void> {
    const doc: SecretsFile = {
      schemaVersion: 1,
      backend: this.backend.name,
      entries: Object.fromEntries([...cipher].sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    await writeDoc(lock, this.file, doc);
  }

  toJSON(): string {
    return `[SecretStore: ${this.size} secrets]`;
  }

  [inspect.custom](): string {
    return this.toJSON();
  }
}
