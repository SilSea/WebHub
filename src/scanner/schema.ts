/**
 * `data/scan.json` (F-006 §3.4, schemaVersion 1): the result of the last scan. Written by the
 * daemon only (F-001 store: atomic, lock). Holds no `.env` values other than port numbers and
 * no compose environment values.
 */
import { z } from "zod";
import type { DocSpec } from "../store/json-store.js";

export const SCAN_SCHEMA_VERSION = 1;

const str = (max: number) => z.string().max(max);
const port = z.number().int().min(1).max(65535);

const Service = z.strictObject({
  cwd: str(400),
  profile: str(40),
  port: z
    .strictObject({
      value: port,
      via: z.enum(["arg", "env", "fixed"]),
      env: str(64).optional(),
      source: str(300),
    })
    .optional(),
  publicDir: str(20).optional(),
  runtime: z
    .array(z.strictObject({ lang: str(20), hint: str(200), source: str(100) }))
    .max(20)
    .optional(),
});

export const Candidate = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{16}$/),
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
  path: str(4096),
  kind: z.enum(["site", "not-web", "unknown", "duplicate"]),
  score: z.number().int().min(0).max(1000),
  profile: str(40).optional(),
  alternatives: z.array(z.strictObject({ profile: str(40), score: z.number().int() })).max(50),
  reasons: z.array(str(400)).max(100),
  notWeb: z.array(str(200)).max(20),
  runner: z.enum(["static", "native", "compose", "hybrid"]).optional(),
  compose: z
    .strictObject({
      files: z.array(str(400)).max(32),
      app: z.array(str(63)).max(200),
      infra: z.array(str(63)).max(200),
      mountsSource: z.boolean(),
    })
    .optional(),
  services: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), Service),
  duplicateOf: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  fingerprint: z.string().regex(/^([0-9a-f]{64})?$/),
});
export type Candidate = z.infer<typeof Candidate>;

export const ScanResult = z.strictObject({
  schemaVersion: z.literal(SCAN_SCHEMA_VERSION),
  scanId: z.string().regex(/^[0-9a-f]{16}$/),
  startedAt: z.string().max(40),
  finishedAt: z.string().max(40),
  truncated: z.union([
    z.literal(false),
    z.strictObject({ reason: z.enum(["time", "folders", "bytes", "candidates"]) }),
  ]),
  roots: z
    .array(
      z.strictObject({
        path: str(4096),
        status: z.enum([
          "ok",
          "missing",
          "not-a-folder",
          "link",
          "no-access",
          "inside-home",
          "inside-root",
        ]),
      }),
    )
    .max(100),
  candidates: z.array(Candidate).max(2000),
  skipped: z
    .array(
      z.strictObject({
        path: str(4096),
        reason: z.enum(["link", "too-many-entries", "changed", "bad-name", "no-access"]),
      }),
    )
    .max(500),
  problems: z.array(z.strictObject({ file: str(4096), message: str(400) })).max(500),
});
export type ScanResult = z.infer<typeof ScanResult>;

export const scanSpec: DocSpec<ScanResult> = {
  version: SCAN_SCHEMA_VERSION,
  schema: ScanResult,
  migrations: [],
};
