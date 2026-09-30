import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserRequested } from "../src/app/capabilities";
import { planPageCheck } from "../src/services/page-checks";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Realistic front-end requests; the old word trigger offers the browser tool for only one of them. */
const PROMPTS = [
  "Add a dashboard page that lists the switches from the Central API",
  "The /dashboard page is blank after my last change, fix it",
  "Make the sidebar collapse on small screens",
  "Add a dark mode toggle to the settings page",
  "Build a NOC portal that shows AP status in a table with a search box",
  "Fix the frontend so the chart renders on the home page",
  "Add a login form component with validation",
  "The React app throws 'cannot read properties of undefined' when I click Save",
  "Add a new route /devices that shows a device list",
  "Style the header like the Aruba brand colors",
];

async function project(files: Record<string, string>, dirs: string[] = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-trigger-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return root;
}

test("a Vite + React project plans a page check for every front-end prompt, decided by the project and the changed files alone", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "18", vite: "5" } }), "bun.lock": "",
    "src/pages/Settings.tsx": "export default function Settings() { return null; }" }, ["node_modules"]);
  expect(PROMPTS.filter(prompt => browserRequested(prompt, false)).length).toBeLessThanOrEqual(1);
  const plans = [];
  // The planner takes no prompt at all: the same facts give the same plan for every request.
  for (const _prompt of PROMPTS) plans.push(await planPageCheck(root, {}, ["src/pages/Settings.tsx"]));
  for (const plan of plans) expect(plan).toMatchObject({ service: { label: "bun run dev", source: "package.json" }, pages: { open: ["/"], skipped: [] } });
  // Without a change a page shows, nothing is planned; pages: off turns it off.
  expect(await planPageCheck(root, {}, ["README.md"])).toBeUndefined();
  expect(await planPageCheck(root, {}, ["src/pages/Settings.tsx"], "off")).toBeUndefined();
});

test("a Python CLI project plans no page check for the same prompts and changes", async () => {
  const root = await project({ "pyproject.toml": "[project]\nname = 'netcli'\ndependencies = ['click']\n", "netcli/main.py": "import click\n" });
  for (const _prompt of PROMPTS) expect(await planPageCheck(root, { frameworks: [] }, ["netcli/main.py", "src/pages/Settings.tsx"])).toBeUndefined();
});

test("a web project that is not installed says so instead of starting anything", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "18", vite: "5" } }), "bun.lock": "" });
  expect(await planPageCheck(root, {}, ["src/App.tsx"])).toEqual({ reason: "node_modules is missing. Run bun install first (Casper doesn't install packages)" });
  expect(await planPageCheck(root, {}, ["README.md"])).toBeUndefined();
});
