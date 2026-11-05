import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserRequested } from "../src/app/capabilities";
import { planPageCheck } from "../src/services/page-checks";
import { planAppSmoke } from "../src/services/detect";
import { removeTempDir } from "./support/temp-dir";

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
  cleanups.push(() => removeTempDir(root));
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

test("a framework-less Bun site built in an empty folder plans a page check for /", async () => {
  // The shape every tool built in the subnet-calculator benchmark: Bun.serve, an HTML page, no dependencies.
  const root = await project({ "package.json": JSON.stringify({ scripts: { dev: "bun --watch src/server.ts", test: "bun test" } }),
    "public/index.html": "<main></main>", "public/styles.css": "", "src/server.ts": "Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: () => new Response('') });",
    "src/subnet.ts": "export {};" });
  expect(await planPageCheck(root, { frameworks: [] }, ["public/index.html", "src/server.ts", "src/subnet.ts"]))
    .toMatchObject({ service: { label: "bun run dev", spec: { command: "bun --watch src/server.ts" } }, pages: { open: ["/"] } });
  expect(await planPageCheck(root, { frameworks: [] }, ["README.md"])).toBeUndefined();
});

// A homepage build (2026-11-05): an Express server that writes its three pages itself, with no index.html, so Casper
// saw no web project: no page check ran, the checks never passed, and the build's requirements review was skipped.
const RENDERED = `const express = require('express');
const app = express();
const layout = (body) => \`<!DOCTYPE html>
<html lang="en"><body>\${body}</body></html>\`;
app.get('/', (_, res) => res.send(layout('<main>Dashboard</main>')));
app.listen(process.env.PORT || 3000);
`;

test("a Node site whose server file writes its own pages, with no index.html, plans a page check for / as a guess", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "^4.21.0" } }),
    "server.js": RENDERED, "public/css/style.css": "", "public/js/app.js": "", "node_modules/express/package.json": "{}" });
  expect(await planPageCheck(root, { frameworks: [] }, ["server.js", "public/css/style.css", "public/js/app.js", "README.md"]))
    .toMatchObject({ service: { label: "npm run start", spec: { command: "node server.js" }, pageSource: "server.js" }, pages: { open: ["/"], rootGuess: true } });
  // The pages are in the server file: a change to it alone opens / too.
  expect(await planPageCheck(root, { frameworks: [] }, ["server.js"])).toMatchObject({ pages: { open: ["/"], rootGuess: true } });
  expect(await planPageCheck(root, { frameworks: [] }, ["README.md"])).toBeUndefined();
  // The app smoke keeps / a guess too: a JSON 404 there is the API answering, as before.
  expect(await planAppSmoke(root, { frameworks: [] }, ["server.js"])).toMatchObject({ path: "/", rootGuess: true });
  // A / the user listed under pages: is theirs to have checked, never a guess.
  const listed = await planPageCheck(root, { frameworks: [] }, ["server.js"], ["/"]);
  expect(listed).toMatchObject({ pages: { open: ["/"] } });
  expect(listed && "pages" in listed ? listed.pages.rootGuess : "no plan").toBeUndefined();
  expect((await planAppSmoke(root, { frameworks: [] }, ["server.js"], ["/"]) as { rootGuess?: true } | undefined)?.rootGuess).toBeUndefined();
});

test("a site with an index.html opens / as a page, never as a guess", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { dev: "bun --watch src/server.ts" } }),
    "public/index.html": "<main></main>", "src/server.ts": "Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: () => new Response('') });" });
  const plan = await planPageCheck(root, { frameworks: [] }, ["public/index.html"]);
  expect(plan).toMatchObject({ pages: { open: ["/"] } });
  expect(plan && "pages" in plan ? plan.pages.rootGuess : "no plan").toBeUndefined();
});

test("Bun's default-export server and Hono's node serve() write their own pages too; an Express dev script of nodemon runs the same file", async () => {
  const page = `"<!DOCTYPE html><html><body>Home</body></html>"`;
  const bun = await project({ "package.json": JSON.stringify({ scripts: { dev: "bun --watch server.ts" } }),
    "server.ts": `export default {\n  fetch(req: Request) { return new Response(${page}, { headers: { "content-type": "text/html" } }); },\n};\n` });
  expect(await planPageCheck(bun, { frameworks: [] }, ["server.ts"]))
    .toMatchObject({ service: { label: "bun run dev", spec: { command: "bun --watch server.ts" }, pageSource: "server.ts" }, pages: { open: ["/"] } });
  const hono = await project({ "package.json": JSON.stringify({ scripts: { start: "node server.mjs" }, dependencies: { hono: "^4.6.0", "@hono/node-server": "^1.13.0" } }),
    "node_modules/hono/package.json": "{}", "server.mjs": `import { serve } from '@hono/node-server';\nimport { Hono } from 'hono';\nconst app = new Hono();\napp.get('/', (c) => c.html(${page}));\nserve({ fetch: app.fetch, port: Number(process.env.PORT) });\n` });
  expect(await planPageCheck(hono, { frameworks: [] }, ["server.mjs"])).toMatchObject({ service: { pageSource: "server.mjs" }, pages: { open: ["/"] } });
  // `dev` runs nodemon over the same file `start` runs: the start script is the site.
  const nodemon = await project({ "package.json": JSON.stringify({ scripts: { dev: "nodemon server.js", start: "node server.js" }, dependencies: { express: "^4.21.0" } }),
    "server.js": RENDERED, "node_modules/express/package.json": "{}" });
  expect(await planPageCheck(nodemon, { frameworks: [] }, ["server.js"]))
    .toMatchObject({ service: { label: "npm run start", spec: { command: "node server.js" } }, pages: { open: ["/"] } });
});

test("what is not a site stays as it was: an API server file, HTML outside it, a Bun default export run by node, a start of built code", async () => {
  const api = `const http = require('node:http');\nhttp.createServer((_, res) => res.end(JSON.stringify({ ok: true }))).listen(process.env.PORT);\n`;
  const root = await project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": api, "public/css/style.css": "" });
  expect(await planPageCheck(root, { frameworks: [] }, ["server.js", "public/css/style.css"])).toBeUndefined();
  // HTML in a file the start script does not run (a fixture, a template another program uses) does not make it a site.
  const other = await project({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": api,
    "tests/fixture.js": RENDERED, "public/css/style.css": "" });
  expect(await planPageCheck(other, { frameworks: [] }, ["server.js", "tests/fixture.js", "public/css/style.css"])).toBeUndefined();
  // Only bun serves a default export: under node nothing listens.
  const node = await project({ "package.json": JSON.stringify({ scripts: { start: "node server.mjs" } }),
    "server.mjs": `export default { fetch() { return new Response("<!DOCTYPE html><html></html>"); } };\n` });
  expect(await planPageCheck(node, { frameworks: [] }, ["server.mjs"])).toBeUndefined();
  // A TypeScript dev server beside a start of the built output: the start script runs an old build, not the change.
  const built = await project({ "package.json": JSON.stringify({ scripts: { dev: "tsx watch src/server.ts", start: "node dist/server.js" } }),
    "public/index.html": "<main></main>", "src/server.ts": "", "dist/server.js": RENDERED });
  expect(await planPageCheck(built, { frameworks: [] }, ["src/server.ts", "public/index.html"])).toBeUndefined();
});
