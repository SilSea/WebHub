import { type Platform, PlatformError } from "./types.js";
import { win32Platform } from "./win32.js";

export { describeTask, type ElevatedTask } from "./tasks.js";
export * from "./types.js";

const unsupported = (): never => {
  throw new PlatformError("PLATFORM_UNSUPPORTED", `${process.platform} is not supported yet`, {
    hint: "webhub currently supports Windows only (macOS/Linux are planned).",
  });
};

/** Stub for OSes without an implementation yet: every call fails with PLATFORM_UNSUPPORTED. */
export function unsupportedPlatform(name: NodeJS.Platform): Platform {
  return {
    name,
    ports: {
      listening: unsupported,
      reserved: unsupported,
      canBind: unsupported,
      findFree: unsupported,
    },
    process: { info: unsupported, killTree: unsupported, usage: unsupported },
    elevate: unsupported,
    notify: async () => false,
    capabilities: unsupported,
  };
}

export function getPlatform(platform: NodeJS.Platform = process.platform): Platform {
  return platform === "win32" ? win32Platform : unsupportedPlatform(platform);
}
