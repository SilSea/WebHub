import { readFileSync } from "node:fs";

/** Version from the package's own package.json (works from both src/ and dist/). */
export function readVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const pkg: unknown = JSON.parse(raw);
  if (
    typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
  ) {
    return pkg.version;
  }
  throw new Error("webhub: package.json has no valid version");
}
