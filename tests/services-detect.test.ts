import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectWebService, devCommand } from "../src/services/detect";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function project(files: Record<string, string>, dirs: string[] = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-detect-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return root;
}
const pkg = (scripts: Record<string, string>, deps: Record<string, string>) => JSON.stringify({ scripts, dependencies: deps });

test("a Vite dev script gets Casper's port flags and loses --open", async () => {
  const root = await project({ "package.json": pkg({ dev: "vite --open" }, { vite: "5", react: "18" }), "bun.lock": "" }, ["node_modules"]);
  const found = await detectWebService(root, { platform: "linux" });
  expect(found).toMatchObject({ name: "web", source: "package.json", label: "bun run dev", portFlags: true,
    spec: { command: "vite --port $PORT --strictPort --host 127.0.0.1", port: "auto", ready: { http: "/" }, timeoutMs: 45_000 } });
  expect((found as { frameworks: string[] }).frameworks).toEqual(["react", "vite"]);
});

test("port flags per dev runner; only the last command of a chain changes", () => {
  expect(devCommand("vite dev --port 3000 --host", "linux").command).toBe("vite dev --port $PORT --strictPort --host 127.0.0.1");
  expect(devCommand("prisma generate && next dev -p 4000", "linux").command).toBe("prisma generate && next dev");
  expect(devCommand("astro dev", "linux").command).toBe("astro dev --port $PORT --host 127.0.0.1");
  expect(devCommand("nuxi dev --open", "linux").command).toBe("nuxi dev --port $PORT --host 127.0.0.1");
  expect(devCommand("ng serve --open", "win32").command).toBe("ng serve --port %PORT% --host 127.0.0.1");
  expect(devCommand("react-scripts start", "linux")).toEqual({ command: "react-scripts start", env: { BROWSER: "none" }, portFlags: true });
  expect(devCommand("NODE_ENV=development vite", "linux").command).toBe("NODE_ENV=development vite --port $PORT --strictPort --host 127.0.0.1");
  // Casper does not guess about shell features: the script runs as written, relying on PORT.
  expect(devCommand("vite | tee log.txt", "linux")).toEqual({ command: "vite | tee log.txt", portFlags: false });
});

test("Next reads PORT itself, so its script runs unchanged", async () => {
  const root = await project({ "package.json": pkg({ dev: "next dev", build: "next build" }, { next: "15", react: "19" }), "package-lock.json": "{}" }, ["node_modules"]);
  expect(await detectWebService(root, { platform: "linux" })).toMatchObject({ label: "npm run dev", spec: { command: "next dev", ready: { http: "/" } } });
});

test("a Streamlit app with a .venv runs through the project's interpreter, ready at /_stcore/health", async () => {
  const root = await project({ "requirements.txt": "pandas\nstreamlit==1.40\n", "app.py": "import streamlit as st\nst.title('AOS8')\n", "uv.lock": "" }, [".venv/bin"]);
  const found = await detectWebService(root, { platform: "linux" });
  expect(found).toMatchObject({ name: "web", source: "streamlit", label: "streamlit run app.py", frameworks: ["streamlit"],
    spec: { ready: { http: "/_stcore/health" }, port: "auto" } });
  expect((found as { spec: { command: string } }).spec.command).toStartWith(".venv/bin/python -m streamlit run app.py --server.port $PORT --server.address 127.0.0.1 --server.headless true");
  expect((found as { spec: { command: string } }).spec.command).toContain("--browser.gatherUsageStats false");
});

test("a uv Streamlit project without its .venv gives the plain reason; plain requirements use python3", async () => {
  const uv = await project({ "pyproject.toml": "[project]\ndependencies = [\"streamlit\"]\n", "streamlit_app.py": "from streamlit import title\n", "uv.lock": "" });
  expect(await detectWebService(uv, { platform: "linux" })).toEqual({ reason: "the .venv folder is missing. Run uv sync first (Casper doesn't install packages)", frameworks: ["streamlit"] });
  const plain = await project({ "requirements.txt": "streamlit\n", "app.py": "import streamlit as st\n" });
  expect(await detectWebService(plain, { platform: "linux" })).toMatchObject({ spec: { command: expect.stringMatching(/^python3 -m streamlit run app\.py /) } });
  // Streamlit listed but no entry file importing it: not a Streamlit app Casper can start.
  const library = await project({ "requirements.txt": "streamlit\n", "app.py": "print('cli')\n" });
  expect(await detectWebService(library, { platform: "linux" })).toBeUndefined();
});

test("a declared services.web always wins over the script", async () => {
  const root = await project({ "package.json": pkg({ dev: "vite" }, { vite: "5" }) }, ["node_modules"]);
  const web = { command: "bun run serve", port: "auto" as const, ready: { http: "/health" }, timeoutMs: 20_000 };
  expect(await detectWebService(root, { services: { api: { ...web, command: "api" }, web } })).toMatchObject({ name: "web", source: "declared", label: "bun run serve", spec: web });
  // The only declared service counts in a front-end project, not in an API-only one.
  expect(await detectWebService(root, { services: { site: web } })).toMatchObject({ name: "site", source: "declared" });
  const api = await project({ "package.json": pkg({ dev: "node server.js" }, { express: "4" }) }, ["node_modules"]);
  expect(await detectWebService(api, { services: { api: web } })).toBeUndefined();
});

test("a plain Bun or Node site with a page is a web project: its own server, started with PORT", async () => {
  const site = await project({ "package.json": pkg({ dev: "bun --watch src/server.ts", test: "bun test" }, {}), "public/index.html": "<h1>hi</h1>" });
  expect(await detectWebService(site)).toMatchObject({ name: "web", source: "package.json", label: "bun run dev", frameworks: [], portFlags: false,
    spec: { command: "bun --watch src/server.ts", port: "auto", ready: { http: "/" } } });
  const root = await project({ "package.json": pkg({ start: "node server.js" }, {}), "index.html": "<h1>hi</h1>" });
  expect(await detectWebService(root)).toMatchObject({ label: "npm run start", spec: { command: "node server.js" } });
  // No page to open (an API), or a script Casper does not know: not a web project.
  const api = await project({ "package.json": pkg({ dev: "bun --watch src/server.ts" }, {}) });
  expect(await detectWebService(api)).toBeUndefined();
  const custom = await project({ "package.json": pkg({ dev: "./scripts/serve.sh" }, {}), "index.html": "" });
  expect(await detectWebService(custom)).toBeUndefined();
  // Dependencies not installed yet are a reason, like a framework project's.
  const deps = await project({ "package.json": pkg({ dev: "node server.js" }, { ws: "8" }), "public/index.html": "" });
  expect(await detectWebService(deps)).toEqual({ reason: "node_modules is missing. Run npm install first (Casper doesn't install packages)", frameworks: [] });
});

test("an Express-only API or a Python CLI is not a web project; a missing node_modules is a reason", async () => {
  const api = await project({ "package.json": pkg({ dev: "node server.js" }, { express: "4" }) }, ["node_modules"]);
  expect(await detectWebService(api, { frameworks: ["express"] })).toBeUndefined();
  const cli = await project({ "pyproject.toml": "[project]\nname = 'tool'\ndependencies = ['click']\n", "main.py": "import click\n" });
  expect(await detectWebService(cli)).toBeUndefined();
  const bare = await project({ "package.json": pkg({ dev: "vite" }, { vite: "5", react: "18" }), "pnpm-lock.yaml": "" });
  expect(await detectWebService(bare)).toEqual({ reason: "node_modules is missing. Run pnpm install first (Casper doesn't install packages)", frameworks: ["react", "vite"] });
  // A front-end dependency whose script runs something Casper does not know is not started by guesswork.
  const custom = await project({ "package.json": pkg({ dev: "node scripts/dev.js" }, { react: "18" }) }, ["node_modules"]);
  expect(await detectWebService(custom)).toBeUndefined();
});
