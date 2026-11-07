import { type Platform, PlatformError } from "./types.js";
import { win32Platform } from "./win32.js";

export { describeTask, type ElevatedTask } from "./tasks.js";
export * from "./types.js";

const unsupportedError = (name: NodeJS.Platform) =>
  new PlatformError("PLATFORM_UNSUPPORTED", `${name} is not supported yet`, {
    hint: "webhub currently supports Windows only (macOS/Linux are planned).",
  });

/**
 * Stub for OSes without an implementation yet: every call fails with PLATFORM_UNSUPPORTED.
 * Async methods reject (never throw synchronously), so `.catch()` works as on Windows.
 */
export function unsupportedPlatform(name: NodeJS.Platform): Platform {
  const reject = async (): Promise<never> => {
    throw unsupportedError(name);
  };
  return {
    name,
    ports: { listening: reject, reserved: reject, canBind: reject, findFree: reject },
    process: { info: reject, killTree: reject, usage: reject },
    elevate: reject,
    notify: async () => false,
    capabilities: () => {
      throw unsupportedError(name);
    },
  };
}

export function getPlatform(platform: NodeJS.Platform = process.platform): Platform {
  return platform === "win32" ? win32Platform : unsupportedPlatform(platform);
}
