import { closeSync, openSync, writeSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isOutside } from "../../src/platform/inside";
import { runOwned, spawnOwned } from "./proc";

/** How to start one finished app. The same rules for every side, so no tool gets its own launcher. */
export type StartPlan =
  | { kind: "static"; root: string }
  | { kind: "command"; dir: string; install: string[][]; command: string[] }
  | { kind: "none"; reason: string };

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", "coverage", "projects", "starter"]);
/** Folder names that usually hold the part you open in a browser, looked at first. */
const FRONT = ["frontend", "client", "web", "app", "ui", "site"];
const NODE_SCRIPTS = ["dev", "start", "serve", "preview"];

const isFile = (file: string) => stat(file).then((info) => info.isFile(), () => false);
const isDir = (dir: string) => stat(dir).then((info) => info.isDirectory(), () => false);

/** The app folder, then its subfolders (front-end names first), then one level further. */
async function candidateDirs(appDir: string): Promise<string[]> {
  const children = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (FRONT.indexOf(a) + 1 || 99) - (FRONT.indexOf(b) + 1 || 99) || a.localeCompare(b))
    .map((name) => path.join(dir, name));
  const first = await children(appDir);
  const second = (await Promise.all(first.map(children))).flat();
  return [appDir, ...first, ...second];
}

async function nodePlan(dir: string): Promise<StartPlan | undefined> {
  let scripts: Record<string, unknown>;
  try { scripts = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))?.scripts ?? {}; } catch { return undefined; }
  const script = NODE_SCRIPTS.find((name) => typeof scripts[name] === "string");
  if (!script) return undefined;
  const has = (file: string) => isFile(path.join(dir, file));
  const tool = await has("bun.lock") || await has("bun.lockb") ? process.execPath
    : await has("pnpm-lock.yaml") && Bun.which("pnpm") ? "pnpm"
      : await has("yarn.lock") && Bun.which("yarn") ? "yarn" : "npm";
  const install = await isDir(path.join(dir, "node_modules")) ? [] : [[tool, "install"]];
  // A preview serves a build, so it needs one first.
  if (script === "preview" && typeof scripts.build === "string") install.push([tool, "run", "build"]);
  return { kind: "command", dir, install, command: [tool, "run", script] };
}

async function pythonPlan(dir: string): Promise<StartPlan | undefined> {
  for (const file of ["main.py", "app.py", "server.py"]) {
    const text = await readFile(path.join(dir, file), "utf8").catch(() => "");
    const kind = /\bFastAPI\(/.test(text) ? "fastapi" : /\bFlask\(/.test(text) ? "flask" : undefined;
    if (!kind) continue;
    const module = file.slice(0, -3);
    const python = path.join(".venv", process.platform === "win32" ? "Scripts" : "bin", "python");
    const install: string[][] = [];
    if (!await isFile(path.join(dir, python))) {
      install.push(["python3", "-m", "venv", ".venv"]);
      install.push(await isFile(path.join(dir, "requirements.txt"))
        ? [python, "-m", "pip", "install", "-r", "requirements.txt"]
        : [python, "-m", "pip", "install", ...(kind === "fastapi" ? ["fastapi", "uvicorn"] : ["flask"])]);
    }
    const command = kind === "fastapi"
      ? [python, "-m", "uvicorn", `${module}:app`, "--port", "{port}"]
      : [python, "-m", "flask", "--app", module, "run", "--port", "{port}"];
    return { kind: "command", dir, install, command };
  }
  return undefined;
}

async function staticRoot(dir: string): Promise<string | undefined> {
  for (const root of [dir, path.join(dir, "public"), path.join(dir, "dist")]) if (await isFile(path.join(root, "index.html"))) return root;
  return undefined;
}

/** Looks for, in each folder from the top down: a package.json with a dev/start/serve/preview script, a FastAPI or
 * Flask app, then a plain index.html. */
export async function planStart(appDir: string | null): Promise<StartPlan> {
  if (!appDir || !await isDir(appDir)) return { kind: "none", reason: "This side left no app folder." };
  for (const dir of await candidateDirs(appDir)) {
    const plan = await nodePlan(dir) ?? await pythonPlan(dir);
    if (plan) return plan;
    const root = await staticRoot(dir);
    if (root) return { kind: "static", root };
  }
  return { kind: "none", reason: "No way to start it was found: no package.json script, Python web app or index.html." };
}

/** The first local address a dev server prints (colors removed: Vite colors the port). */
export function localUrlIn(text: string): string | undefined {
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const match = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'"<>)\]]*)?/.exec(plain);
  return match?.[0].replace("0.0.0.0", "localhost").replace(/\[::1?\]/, "localhost");
}

export interface RunningApp {
  url: string | null;
  error?: string;
  /** What installing and starting printed, last part only. */
  log: string;
  stop(): Promise<void>;
}

const LOG_LIMIT = 24 * 1024;
/** The apps run their own install and dev scripts, outside any sandbox, so they get no keys, tokens or passwords. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;
export function appEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SECRET_NAME.test(entry[0])));
}
const freePort = () => { const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const port = probe.port!; void probe.stop(true); return port; };
const answers = async (url: string) => { try { await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" }); return true; } catch { return false; } };

/** Serves a folder of plain files. Nothing outside the folder is ever sent. */
export function serveStatic(root: string, port = 0): { url: string; stop(): Promise<void> } {
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      let relative: string;
      try { relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, ""); } catch { return new Response("Bad path", { status: 400 }); }
      let file = path.resolve(root, relative);
      if (isOutside(path.relative(root, file))) return new Response("Not found", { status: 404 });
      if (await isDir(file)) file = path.join(file, "index.html");
      return await isFile(file) ? new Response(Bun.file(file)) : new Response("Not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}/`, stop: () => server.stop(true) };
}

/** Starts a side's app and waits until it answers. Never throws: a broken app is shown as broken. Install
 * output goes to `logFile`; the end of everything printed comes back as `log`. */
export async function startApp(appDir: string | null, logFile: string, signal?: AbortSignal): Promise<RunningApp> {
  const plan = await planStart(appDir);
  const none = async () => {};
  if (plan.kind === "none") return { url: null, error: plan.reason, log: "", stop: none };
  if (plan.kind === "static") return { ...serveStatic(plan.root), log: "" };
  const port = freePort();
  const env = { ...appEnvironment(), PORT: String(port), BROWSER: "none", NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  const fd = openSync(logFile, "a");
  try {
    for (const step of plan.install) {
      writeSync(fd, `$ ${step.join(" ")}\n`);
      const run = await runOwned(step, { cwd: plan.dir, env, stdout: fd, stderr: fd, timeoutMs: 10 * 60_000, signal });
      if (run.exitCode !== 0) {
        const log = (await readFile(logFile, "utf8").catch(() => "")).slice(-LOG_LIMIT);
        return { url: null, error: `"${step.join(" ")}" ${run.timedOut ? "took over 10 minutes" : `failed (exit ${run.exitCode})`}.`, log, stop: none };
      }
    }
  } finally { closeSync(fd); }
  const command = plan.command.map((part) => part.replace("{port}", String(port)));
  let log = `$ ${command.join(" ")}\n`;
  const owned = spawnOwned(command, { cwd: plan.dir, env, stdout: "pipe", stderr: "pipe" });
  let printed: string | undefined;
  const read = async (stream: ReadableStream<Uint8Array> | number | undefined) => {
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      log = (log + decoder.decode(chunk, { stream: true })).slice(-LOG_LIMIT);
      printed ??= localUrlIn(log);
    }
  };
  void read(owned.child.stdout);
  void read(owned.child.stderr);
  let exited = false;
  void owned.child.exited.then(() => { exited = true; });
  const begin = performance.now();
  while (performance.now() - begin < 120_000 && !exited && !signal?.aborted) {
    // An app that prints no address is tried on the PORT it was given.
    const url = printed ?? (performance.now() - begin > 20_000 ? `http://localhost:${port}/` : undefined);
    if (url && await answers(url)) return { url, log, stop: owned.stop };
    await Bun.sleep(1000);
  }
  await owned.stop();
  return { url: null, error: exited ? "Its start command ended before the app answered." : "The app did not answer within 2 minutes.", log, stop: none };
}
