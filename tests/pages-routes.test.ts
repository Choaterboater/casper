import { expect, test } from "bun:test";
import { changedPages, parsePagesSetting } from "../src/services/pages";

test("Next app and pages routers map changed page files to their addresses", () => {
  const next = ["next", "react"];
  expect(changedPages(next, ["app/dashboard/page.tsx"])).toEqual({ open: ["/dashboard"], skipped: [] });
  expect(changedPages(next, ["app/(admin)/users/page.tsx"]).open).toEqual(["/users"]);
  expect(changedPages(next, ["src/app/page.tsx"]).open).toEqual(["/"]);
  expect(changedPages(next, ["pages/index.tsx"]).open).toEqual(["/"]);
  expect(changedPages(next, ["pages/devices/list.tsx"]).open).toEqual(["/devices/list"]);
  // API routes are not pages, and nothing else changed.
  expect(changedPages(next, ["pages/api/x.ts"])).toEqual({ open: [], skipped: [] });
  expect(changedPages(next, ["app/api/devices/route.ts"])).toEqual({ open: [], skipped: [] });
  // A file whose name merely ends in "page" is not a page file.
  expect(changedPages(next, ["app/dashboard/homepage.tsx"]).open).toEqual(["/"]);
});

test("dynamic routes are skipped with the value they need; groups and optional segments are dropped", () => {
  expect(changedPages(["next"], ["app/devices/[id]/page.tsx"])).toEqual({ open: [], skipped: [{ path: "/devices/[id]", why: "it needs a value for [id]" }] });
  expect(changedPages(["next"], ["pages/docs/[...slug].tsx"]).skipped).toEqual([{ path: "/docs/[...slug]", why: "it needs a value for [...slug]" }]);
  expect(changedPages(["sveltekit"], ["src/routes/[[lang]]/about/+page.svelte"]).open).toEqual(["/about"]);
});

test("SvelteKit, Nuxt and Astro file routes", () => {
  expect(changedPages(["sveltekit", "vite"], ["src/routes/devices/+page.svelte"]).open).toEqual(["/devices"]);
  expect(changedPages(["sveltekit"], ["src/routes/+page.server.ts"]).open).toEqual(["/"]);
  expect(changedPages(["sveltekit"], ["src/routes/api/+server.ts"]).open).toEqual([]);
  expect(changedPages(["nuxt", "vue"], ["pages/sites/index.vue"]).open).toEqual(["/sites"]);
  expect(changedPages(["astro"], ["src/pages/about.astro"]).open).toEqual(["/about"]);
  expect(changedPages(["astro"], ["src/pages/rss.xml.ts"]).open).toEqual([]);
});

test("other front-end files open /; tests, docs and build caches open nothing", () => {
  expect(changedPages(["next"], ["src/components/Nav.tsx"]).open).toEqual(["/"]);
  expect(changedPages(["vite", "react"], ["src/pages/Settings.tsx", "src/styles.css"]).open).toEqual(["/"]);
  expect(changedPages(["vite", "react"], ["src/Nav.test.tsx", "README.md", ".next/cache/x.js", "node_modules/a/index.js"]).open).toEqual([]);
  expect(changedPages(["streamlit"], ["app.py"]).open).toEqual(["/"]);
  expect(changedPages(["streamlit"], ["tests/test_app.py", "README.md"]).open).toEqual([]);
  expect(changedPages(["next"], ["app\\dashboard\\page.tsx"]).open).toEqual(["/dashboard"]);
});

test("at most five pages open; the rest are listed as skipped", () => {
  const files = ["a", "b", "c", "d", "e", "f", "g"].map(name => `app/${name}/page.tsx`);
  const plan = changedPages(["next"], files);
  expect(plan.open).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  expect(plan.skipped).toEqual([{ path: "/f", why: "only 5 pages are opened per check" }, { path: "/g", why: "only 5 pages are opened per check" }]);
});

test("configured pages are always added after a code change, and pages: off opens nothing", () => {
  expect(changedPages(["next"], ["app/dashboard/page.tsx"], ["/", "/status"]).open).toEqual(["/", "/status", "/dashboard"]);
  // An API edit can break a listed page too.
  expect(changedPages(["next"], ["pages/api/x.ts"], ["/status"]).open).toEqual(["/status"]);
  expect(changedPages(["next"], ["README.md"], ["/status"]).open).toEqual([]);
  expect(changedPages(["next"], ["app/dashboard/page.tsx"], "off")).toEqual({ open: [], skipped: [] });
});

test("the pages setting accepts off or up to eight site paths, and names the bad entry", () => {
  expect(parsePagesSetting(undefined)).toBeUndefined();
  expect(parsePagesSetting("off")).toBe("off");
  expect(parsePagesSetting(["/", "/dashboard", "/dashboard"])).toEqual(["/", "/dashboard"]);
  expect(() => parsePagesSetting(["/ok", "//evil.example"])).toThrow("Invalid .casper/project.yaml: pages[1] must be a path");
  expect(() => parsePagesSetting(["dashboard"])).toThrow("pages[0]");
  expect(() => parsePagesSetting(["/a\\b"])).toThrow("pages[0]");
  expect(() => parsePagesSetting("on")).toThrow("pages must be off or a list");
  expect(() => parsePagesSetting(Array.from({ length: 9 }, (_, index) => `/p${index}`))).toThrow("at most 8");
});
