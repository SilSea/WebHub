// Removes dist/ before every build so stale files can never be published (security-1 #2).
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

rmSync(fileURLToPath(new URL("../dist/", import.meta.url)), { recursive: true, force: true });
