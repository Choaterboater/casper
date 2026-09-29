import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ServiceSpec } from "./config";

/** Front-end frameworks whose dev server Casper knows how to start on a port it picks. */
export const WEB_FRAMEWORKS = ["next", "nuxt", "sveltekit", "astro", "angular", "vite", "vue", "react"] as const;

/** A dev server Casper found for page checks. `name` is the service slot it runs in. */
export interface DetectedWebService {
  name: string;
  spec: ServiceSpec;
  /** Where the command came from: a declared service, the package.json script, or a Streamlit app. */
  source: "declared" | "package.json" | "streamlit";
  /** What the user sees in the banner and receipts: "bun run dev", "streamlit run app.py" or the declared command. */
  label: string;
  /** Frameworks this project uses for routing pages (includes "streamlit" for a Streamlit app). */
  frameworks: string[];
  /** False when Casper could not add its port flags to the script and relies on the PORT variable alone. */
  portFlags: boolean;
}

/** Why a web project has no startable dev server (a missing install). Plain words for the user. */
export interface WebServiceUnavailable { reason: string; /** The frameworks found, so callers can tell whether a change reaches a page. */ frameworks: string[] }

export interface DetectInput {
  /** The project model's frameworks (package dependencies and config files). */
  frameworks?: readonly string[];
  packageManager?: string | null;
  /** Services declared in .casper/project.yaml. */
  services?: Record<string, ServiceSpec>;
  /** A test seam for the Windows shell; the host platform by default. */
  platform?: NodeJS.Platform;
}

const READY_TIMEOUT_MS = 45_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

async function readSmall(file: string, limit: number): Promise<string | undefined> {
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.size > limit) return undefined;
    return await readFile(file, "utf8");
  } catch { return undefined; }
}
async function isDirectory(file: string): Promise<boolean> {
  try { return (await lstat(file)).isDirectory(); } catch { return false; }
}

/** Dependencies that decide the framework, beyond what the project model lists (it has no astro). */
const DEPENDENCY_FRAMEWORKS: Record<string, string> = {
  next: "next", nuxt: "nuxt", "@sveltejs/kit": "sveltekit", astro: "astro", "@angular/core": "angular",
  vite: "vite", vue: "vue", react: "react", "react-scripts": "react",
};

/** The dev-server programs Casper can point at a port. Each maps to how the port is passed. */
type Runner = "vite" | "astro" | "nuxi" | "ng" | "next" | "react-scripts";
const RUNNERS: Record<string, Runner> = { vite: "vite", astro: "astro", nuxi: "nuxi", nuxt: "nuxi", ng: "ng", next: "next", "react-scripts": "react-scripts" };

/** Splits a script body at its last `&&` or `;` so only the final command gets port flags. Returns
 * undefined when the last command uses shell features Casper would have to guess about (pipes, `||`,
 * backgrounding, subshells, quotes or variable expansion). */
function lastCommand(script: string): { prefix: string; words: string[] } | undefined {
  const match = /^(.*(?:&&|;))?\s*([^;&]*)$/s.exec(script.trim());
  if (!match) return undefined;
  const prefix = match[1] ?? "", last = match[2]!.trim();
  if (!last || /[|&<>()`$"'\\]/.test(last)) return undefined;
  return { prefix: prefix ? `${prefix} ` : "", words: last.split(/\s+/) };
}

/** Removes a flag and, for flags that take a value, the value after it (`--port 3000` or `--port=3000`). */
function dropFlag(words: string[], names: string[], takesValue: boolean): string[] {
  const out: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (names.includes(word)) { if (takesValue && index + 1 < words.length && !words[index + 1]!.startsWith("-")) index++; continue; }
    if (takesValue && names.some(name => name.startsWith("--") && word.startsWith(`${name}=`))) continue;
    out.push(word);
  }
  return out;
}

/** Removes `--open`/`-o` and a path it opens (`--open /docs`): a page check never opens the user's browser. */
function dropOpen(words: string[]): string[] {
  return words.filter((word, index) => !["--open", "-o"].includes(word) && !/^--open=/.test(word)
    && !(["--open", "-o"].includes(words[index - 1] ?? "") && word.startsWith("/")));
}

/**
 * The dev command with Casper's port on it. The script body runs directly (node_modules/.bin is on PATH in
 * the managed process), so no package manager's argument passing is involved. Vite, SvelteKit, Astro, Nuxt and
 * Angular ignore the PORT variable, so they get explicit flags; Next and react-scripts read PORT themselves.
 */
export function devCommand(script: string, platform: NodeJS.Platform = process.platform): { command: string; env?: Record<string, string>; portFlags: boolean } {
  const port = platform === "win32" ? "%PORT%" : "$PORT";
  const parsed = lastCommand(script);
  // Leading VAR=value assignments stay in front of the program.
  const assignments = parsed ? parsed.words.slice(0, parsed.words.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) : [];
  const program = parsed?.words[assignments.length];
  const runner = program ? RUNNERS[program] : undefined;
  if (!parsed || !runner) return { command: script.trim(), portFlags: false };
  let words = parsed.words.slice(assignments.length);
  const join = (items: string[]) => `${parsed.prefix}${[...assignments, ...items].join(" ")}`;
  switch (runner) {
    case "vite":
      words = dropFlag(dropOpen(words), ["--strictPort"], false);
      words = dropFlag(words, ["--port", "--host"], true);
      return { command: join([...words, "--port", port, "--strictPort", "--host", "127.0.0.1"]), portFlags: true };
    case "astro":
    case "nuxi":
    case "ng":
      words = dropFlag(dropOpen(words), ["--port", "--host", "--hostname"], true);
      return { command: join([...words, "--port", port, "--host", "127.0.0.1"]), portFlags: true };
    case "next":
      return { command: join(dropFlag(words, ["--port", "-p"], true)), portFlags: true };
    case "react-scripts":
      return { command: join(words), env: { BROWSER: "none" }, portFlags: true };
  }
}

function packageFrameworks(manifest: Mapping | undefined): Set<string> {
  const found = new Set<string>();
  for (const section of ["dependencies", "devDependencies"]) {
    const dependencies = manifest?.[section];
    if (!isMapping(dependencies)) continue;
    for (const name of Object.keys(dependencies)) if (DEPENDENCY_FRAMEWORKS[name]) found.add(DEPENDENCY_FRAMEWORKS[name]!);
  }
  return found;
}

async function lockfileManager(root: string): Promise<string> {
  let names: string[] = [];
  try { names = await readdir(root); } catch { /* an unreadable root has no lockfile */ }
  if (names.includes("bun.lock") || names.includes("bun.lockb")) return "bun";
  if (names.includes("pnpm-lock.yaml")) return "pnpm";
  if (names.includes("yarn.lock")) return "yarn";
  return "npm";
}

const STREAMLIT_ENTRIES = ["streamlit_app.py", "app.py", "main.py", "Home.py"];
const IMPORTS_STREAMLIT = /^\s*(?:import\s+streamlit\b|from\s+streamlit\b)/m;
const REQUIREMENTS = /^requirements[\w.-]*\.txt$/i;
const VIRTUALENVS = [".venv", "venv"];

async function detectStreamlit(root: string, platform: NodeJS.Platform): Promise<DetectedWebService | WebServiceUnavailable | undefined> {
  let names: string[] = [];
  try { names = await readdir(root); } catch { return undefined; }
  const declared = [await readSmall(path.join(root, "pyproject.toml"), MAX_MANIFEST_BYTES) ?? "",
    ...(await Promise.all(names.filter(name => REQUIREMENTS.test(name)).map(name => readSmall(path.join(root, name), MAX_MANIFEST_BYTES)))).map(text => text ?? "")].join("\n");
  if (!/(^|[\s"'\[,])streamlit\b/im.test(declared)) return undefined;
  let entry: string | undefined;
  for (const candidate of STREAMLIT_ENTRIES) {
    if (!names.includes(candidate)) continue;
    const source = await readSmall(path.join(root, candidate), MAX_ENTRY_BYTES);
    if (source && IMPORTS_STREAMLIT.test(source)) { entry = candidate; break; }
  }
  if (!entry) return undefined;
  const venv = (await Promise.all(VIRTUALENVS.map(async name => await isDirectory(path.join(root, name)) ? name : undefined))).find(Boolean);
  // The dev server runs with an isolated HOME, where `uv run` or `poetry run` would refetch everything,
  // so the project's own interpreter is used. Without it, a uv or poetry project is not installed yet.
  if (!venv && (names.includes("uv.lock") || names.includes("poetry.lock"))) {
    const tool = names.includes("uv.lock") ? "uv sync" : "poetry install";
    return { reason: `the .venv folder is missing. Run ${tool} first (Casper doesn't install packages)`, frameworks: ["streamlit"] };
  }
  const python = venv ? platform === "win32" ? `${venv}\\Scripts\\python.exe` : `${venv}/bin/python` : platform === "win32" ? "python" : "python3";
  const port = platform === "win32" ? "%PORT%" : "$PORT";
  // Usage statistics off: a page check never phones home on the user's behalf.
  const command = `${python} -m streamlit run ${entry} --server.port ${port} --server.address 127.0.0.1 --server.headless true --browser.gatherUsageStats false`;
  return { name: "web", source: "streamlit", label: `streamlit run ${entry}`, frameworks: ["streamlit"], portFlags: true,
    spec: { command, port: "auto", ready: { http: "/_stcore/health" }, timeoutMs: READY_TIMEOUT_MS } };
}

/**
 * The dev server for page checks, decided by project facts only (never by the prompt). In order:
 * a declared `services.web` (or the only declared service); the package.json `dev` (else `start`) script in a
 * project with a front-end framework and a known dev runner; a Streamlit app. Undefined when the project is
 * not a web project; a reason when it is one but is not installed. It never installs anything.
 */
export async function detectWebService(root: string, input: DetectInput = {}): Promise<DetectedWebService | WebServiceUnavailable | undefined> {
  const platform = input.platform ?? process.platform;
  const services = input.services ?? {};
  const declaredNames = Object.keys(services);
  const manifestText = await readSmall(path.join(root, "package.json"), MAX_MANIFEST_BYTES);
  let manifest: Mapping | undefined;
  try { const parsed: unknown = manifestText ? JSON.parse(manifestText) : undefined; if (isMapping(parsed)) manifest = parsed; } catch { /* not a usable manifest */ }
  const frameworks = new Set([...(input.frameworks ?? []), ...packageFrameworks(manifest)].filter(name => (WEB_FRAMEWORKS as readonly string[]).includes(name)));
  if (frameworks.has("vite") && manifest && isMapping(manifest.devDependencies) && "@sveltejs/kit" in manifest.devDependencies) frameworks.add("sveltekit");

  // A declared services.web always makes this a web project. The only declared service counts when the
  // project has pages to open (a front-end framework or a Streamlit app); a lone API service does not.
  const streamlit = frameworks.size ? undefined : await detectStreamlit(root, platform);
  const streamlitApp = streamlit !== undefined && "spec" in streamlit;
  const declared = services.web ? "web" : declaredNames.length === 1 && (frameworks.size || streamlitApp) ? declaredNames[0]! : undefined;
  if (declared) {
    return { name: declared, spec: services[declared]!, source: "declared", label: services[declared]!.command,
      frameworks: streamlitApp ? streamlit.frameworks : [...frameworks].sort(), portFlags: true };
  }

  const scripts = isMapping(manifest?.scripts) ? manifest.scripts : {};
  const scriptName = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : undefined;
  if (frameworks.size && scriptName) {
    const body = scripts[scriptName] as string;
    const words = lastCommand(body)?.words ?? [];
    const program = words.find(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    // A script that runs something Casper does not know (an Express server, a custom script) is not a page server it can start honestly.
    if (program && RUNNERS[program]) {
      const manager = input.packageManager ?? await lockfileManager(root);
      if (!await isDirectory(path.join(root, "node_modules"))) {
        return { reason: `node_modules is missing. Run ${manager} install first (Casper doesn't install packages)`, frameworks: [...frameworks].sort() };
      }
      const dev = devCommand(body, platform);
      return { name: "web", source: "package.json", label: `${manager} run ${scriptName}`, frameworks: [...frameworks].sort(), portFlags: dev.portFlags,
        spec: { command: dev.command, port: "auto", ready: { http: "/" }, timeoutMs: READY_TIMEOUT_MS, ...(dev.env ? { env: dev.env } : {}) } };
    }
  }
  return frameworks.size ? detectStreamlit(root, platform) : streamlit;
}

/** A found dev server, as opposed to a reason it is unavailable. */
export function isDetectedWebService(value: DetectedWebService | WebServiceUnavailable | undefined): value is DetectedWebService {
  return value !== undefined && "spec" in value;
}
