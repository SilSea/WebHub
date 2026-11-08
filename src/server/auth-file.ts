/**
 * `data/auth.json` (F-003 §3.1, Q2): written by the daemon at start with a NEW random token,
 * removed on clean shutdown. Read by the CLI client. Lives under `$WEBHUB_HOME`, whose ACL
 * F-001 restricts to the current user.
 */
import { z } from "zod";
import type { DocSpec } from "../store/json-store.js";

export const AUTH_FILE_VERSION = 1;

export const AuthFileSchema = z.strictObject({
  schemaVersion: z.literal(AUTH_FILE_VERSION),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  startedAt: z.string().min(1),
});

export type AuthFile = z.infer<typeof AuthFileSchema>;

export const authFileSpec: DocSpec<AuthFile> = {
  version: AUTH_FILE_VERSION,
  schema: AuthFileSchema,
  migrations: [],
  sensitive: true,
};
