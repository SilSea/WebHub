import { isAbsolute } from "node:path";
import { z } from "zod";

export const CONFIG_VERSION = 1;

const port = z.number().int().min(1).max(65535);
const range = z
  .tuple([port, port])
  .refine(([a, b]) => a <= b, { message: "range start must be <= end" });
const absPath = z.string().min(1).refine(isAbsolute, { message: "must be an absolute path" });
const relOrAbsPath = z.string().min(1);
const hostLabel = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, { message: "must be a lowercase DNS label" });
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: "invalid env var name" });

const engine = (def: string, policy: "latest" | "pin") =>
  z.strictObject({
    default: z.string().min(1).default(def),
    policy: z.enum(["latest", "pin"]).default(policy),
    images: z.record(z.string(), z.string().min(1)).optional(),
  });

export const ConfigSchema = z.strictObject({
  schemaVersion: z.literal(CONFIG_VERSION),
  mode: z.enum(["auto", "full", "lite"]).default("auto"),
  locale: z.enum(["th", "en"]).default("th"),
  scanRoots: z.array(absPath).default([]),
  maxDepth: z.number().int().min(1).max(10).default(3),
  ignore: z
    .array(z.string().min(1))
    .default([
      "node_modules",
      ".git",
      "dist",
      "build",
      "venv",
      ".venv",
      "target",
      "Library",
      "Intermediate",
      "DerivedDataCache",
    ]),
  domainSuffix: hostLabel.default("localhost"),
  reservedNames: z
    .array(hostLabel)
    .default([
      "hub",
      "db",
      "sql",
      "redis",
      "mongo",
      "mail",
      "s3",
      "api",
      "http",
      "webhub",
      "system",
      "free",
      "all",
    ]),
  ports: z
    .strictObject({
      web: range.default([4100, 4999]),
      isolatedInfra: range.default([14100, 14999]),
      pinnedInfra: range.default([15000, 15999]),
    })
    .prefault({}),
  infra: z
    .strictObject({
      postgres: engine("17", "latest").prefault({}),
      mysql: engine("8.4", "pin").prefault({}),
      mariadb: engine("11", "pin").prefault({}),
      mongo: engine("7", "pin").prefault({}),
      redis: z
        .strictObject({
          default: z.string().min(1).default("7"),
          policy: z.enum(["latest", "pin"]).default("latest"),
          flavor: z.enum(["redis", "valkey"]).default("redis"),
        })
        .prefault({}),
      optional: z
        .strictObject({
          mailpit: z.boolean().default(false),
          minio: z.boolean().default(false),
          cloudbeaver: z.boolean().default(false),
          redisinsight: z.boolean().default(false),
          mongoExpress: z.boolean().default(false),
          hoppscotch: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),
  runtimes: z
    .strictObject({
      dir: relOrAbsPath.default("./runtimes"),
      policy: z.enum(["range", "exact", "ignore"]).default("range"),
      verifyChecksum: z.boolean().default(true),
    })
    .prefault({}),
  daemon: z
    .strictObject({
      autostart: z.boolean().default(true),
      tray: z.boolean().default(true),
    })
    .prefault({}),
  backups: z
    .strictObject({
      schedule: z.string().min(1).default("daily 03:00"),
      keep: z.number().int().min(1).max(365).default(7),
    })
    .prefault({}),
  defaultEnv: z.record(envName, z.string()).default({ NODE_ENV: "development" }),
  onDemand: z
    .strictObject({
      idleStopMinutes: z.number().int().min(1).max(1440).default(30),
    })
    .prefault({}),
  profilesDir: z.array(relOrAbsPath).default(["./data/profiles"]),
});

export type Config = z.infer<typeof ConfigSchema>;

/** JSON Schema of webhub.config.json (for editor autocomplete; DESIGN §21.5). */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: "input" }) as Record<string, unknown>;
}
