/**
 * `GET /api/v1/profiles` (F-005 §3.2): the loaded profiles and the files that failed to load.
 * Default access of the API (bearer or browser session). Re-reads the files on each call (a
 * profile being written shows up at once); concurrent calls share one load.
 */
import type { Paths } from "../config/home.js";
import type { RouteRegistrar } from "../server/api.js";
import { type LoadResult, loadProfiles } from "./loader.js";

export interface ProfilesBody {
  profiles: {
    id: string;
    language: string;
    source: "builtin" | "user";
    file: string;
    overrides?: string;
  }[];
  problems: { file: string; message: string; details: string[] }[];
}

export function toBody(r: LoadResult): ProfilesBody {
  return {
    profiles: r.profiles.map((p) => ({
      id: p.profile.id,
      language: p.profile.language,
      source: p.source,
      file: p.file,
      ...(p.overrides === undefined ? {} : { overrides: p.overrides }),
    })),
    problems: r.problems,
  };
}

export function profileRoutes(paths: Paths, opts: { builtinDir?: string } = {}): RouteRegistrar {
  let inFlight: Promise<LoadResult> | undefined;
  return (app) => {
    app.get("/api/v1/profiles", async () => {
      inFlight ??= loadProfiles(paths, opts).finally(() => {
        inFlight = undefined;
      });
      return toBody(await inFlight);
    });
  };
}
