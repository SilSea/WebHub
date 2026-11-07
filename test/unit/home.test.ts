import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pathsFor, resolveHome } from "../../src/config/home.js";
import { isWebhubError } from "../../src/errors.js";

const abs = (p: string) => resolve(p);

describe("resolveHome", () => {
  it("WEBHUB_HOME wins when absolute", () => {
    const h = abs("/tmp/wh-test-home");
    expect(resolveHome({ WEBHUB_HOME: h, APPDATA: abs("/x") }, "win32", abs("/u"))).toBe(h);
  });

  it("relative WEBHUB_HOME is rejected", () => {
    expect(() => resolveHome({ WEBHUB_HOME: "rel/home" }, "linux", abs("/u"))).toThrow(/absolute/);
  });

  it("drive / filesystem root is rejected", () => {
    const root = resolve("/");
    try {
      resolveHome({ WEBHUB_HOME: root }, process.platform, abs("/u"));
      expect.unreachable();
    } catch (err) {
      expect(isWebhubError(err, "HOME_INVALID")).toBe(true);
    }
  });

  it("windows default is %APPDATA%\\webhub", () => {
    const appData = abs("/Users/me/AppData/Roaming");
    expect(resolveHome({ APPDATA: appData }, "win32", abs("/u"))).toBe(join(appData, "webhub"));
  });

  it("windows without APPDATA asks for WEBHUB_HOME", () => {
    expect(() => resolveHome({}, "win32", abs("/u"))).toThrow(/WEBHUB_HOME/);
  });

  it("macOS default", () => {
    expect(resolveHome({}, "darwin", abs("/Users/me"))).toBe(
      join(abs("/Users/me"), "Library", "Application Support", "webhub"),
    );
  });

  it("linux uses XDG_DATA_HOME, else ~/.local/share", () => {
    expect(resolveHome({ XDG_DATA_HOME: abs("/xdg") }, "linux", abs("/home/me"))).toBe(
      join(abs("/xdg"), "webhub"),
    );
    expect(resolveHome({ XDG_DATA_HOME: "relative" }, "linux", abs("/home/me"))).toBe(
      join(abs("/home/me"), ".local", "share", "webhub"),
    );
  });
});

describe("pathsFor", () => {
  it("lays out data/ files under home", () => {
    const home = abs("/h");
    const p = pathsFor(home);
    expect(p.config).toBe(join(home, "webhub.config.json"));
    expect(p.secrets).toBe(join(home, "data", "secrets.json"));
    expect(p.lock).toBe(join(home, "data", ".lock"));
    expect(p.runtimes).toBe(join(home, "runtimes"));
  });
});
