/**
 * Every built-in profile against the fixtures (DESIGN §21.5): the expected profile wins, with
 * the expected effective settings; fixtures stay untouched (Zero-touch).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Paths } from "../../src/config/home.js";
import { type LoadedProfile, loadProfiles } from "../../src/profiles/loader.js";
import { effectiveProfile, evaluateDetect } from "../../src/profiles/match.js";
import { assertUntouched, copyFixture, hashTree, removeFixtureCopy } from "../helpers/fixture.js";
import { tempHome } from "../helpers/home.js";
import { diskView, memView } from "../helpers/project-view.js";

const CASES: { fixture: string; profile: string; check?: (p: LoadedProfile["profile"]) => void }[] =
  [
    { fixture: "static-basic", profile: "static" },
    {
      fixture: "static-spa-basic",
      profile: "static-spa",
      check: (p) => expect(p.static?.spa).toBe(true),
    },
    {
      fixture: "vite-basic",
      profile: "vite",
      check: (p) => expect(p.devServer?.hostRewrite).toBe(true), // Vite 7
    },
    {
      fixture: "next-basic",
      profile: "next",
      check: (p) => {
        expect(p.devServer?.hostRewrite).toBe(true); // Next 15
        expect(p.start?.cmd).toBe("next dev --port {PORT} --hostname {HOST}");
      },
    },
    {
      fixture: "express-basic",
      profile: "express",
      check: (p) => expect(p.port?.env).toBe("PORT"),
    },
    { fixture: "bun-elysia-basic", profile: "bun-elysia" },
    {
      fixture: "fastapi-basic",
      profile: "fastapi",
      check: (p) => expect(p.health?.path).toBe("/docs"),
    },
  ];

let profiles: LoadedProfile[];
let h: { paths: Paths; cleanup(): Promise<void> };
beforeAll(async () => {
  h = await tempHome();
  profiles = (await loadProfiles(h.paths)).profiles;
});
afterAll(() => h.cleanup());

describe("built-in profiles × fixtures", () => {
  for (const c of CASES) {
    it(`${c.fixture} → ${c.profile}`, async () => {
      const dir = await copyFixture(c.fixture);
      try {
        const before = await hashTree(dir);
        const view = diskView(dir);
        const ranked = profiles
          .map((p) => ({ p, r: evaluateDetect(p.profile, view) }))
          .filter((x) => x.r.matched)
          .sort((a, b) => b.r.score - a.r.score);
        expect(ranked[0]?.p.profile.id).toBe(c.profile);
        // the winner is clear: no other profile with the same score
        expect(ranked[1]?.r.score ?? -1).toBeLessThan(ranked[0]?.r.score ?? 0);
        expect(ranked[0]?.r.score).toBeGreaterThanOrEqual(50); // web (DESIGN §9)
        const best = ranked[0];
        if (best === undefined) throw new Error("no profile matched");
        c.check?.(effectiveProfile(best.p.profile, view.deps()));
        assertUntouched(before, await hashTree(dir));
      } finally {
        await removeFixtureCopy(dir);
      }
    });
  }

  it("Next < 13 uses the old flags; Vite 5 keeps the Host header", () => {
    const byId = (id: string) => {
      const p = profiles.find((x) => x.profile.id === id);
      if (p === undefined) throw new Error(id);
      return p.profile;
    };
    const next = byId("next");
    expect(effectiveProfile(next, new Map([["next", "^12.3.0"]])).start?.cmd).toBe(
      "next dev -p {PORT} -H {HOST}",
    );
    const vite = byId("vite");
    expect(effectiveProfile(vite, new Map([["vite", "^5.4.0"]])).devServer?.hostRewrite).toBe(
      false,
    );
  });

  it("fastapi: not for pyproject-only projects (K2) or Django with uvicorn (K4)", () => {
    const fastapi = profiles.find((x) => x.profile.id === "fastapi")?.profile;
    if (fastapi === undefined) throw new Error("fastapi");
    expect(
      evaluateDetect(
        fastapi,
        memView({ "pyproject.toml": '[project]\ndependencies = ["fastapi"]' }),
      ).matched,
    ).toBe(false);
    expect(
      evaluateDetect(
        fastapi,
        memView({ "requirements.txt": "django\nuvicorn\n", "manage.py": "" }, { uvicorn: "*" }),
      ).matched,
    ).toBe(false);
    expect(
      evaluateDetect(fastapi, memView({ "requirements.txt": "uvicorn\n" }, { uvicorn: "*" }))
        .matched,
    ).toBe(false);
    expect(evaluateDetect(fastapi, memView({ "requirements.txt": "fastapi\n" })).matched).toBe(
      true,
    );
  });
});
