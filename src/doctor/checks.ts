import { lstat, readFile, realpath, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfiguration, type LoadedConfiguration } from "../config/load";
import { isValidProfileName } from "../config/profile";
import { discoverLSPConfiguration } from "../lsp/config";
import { discoverMCPConfiguration, MissingEnvironmentError, resolveEnvironment, type MCPServerDefinition } from "../mcp/config";
import type { MCPStatus } from "../mcp/manager";
import { readLogins, PRODUCT_LABELS } from "../mcp/network/logins";
import { NETWORK_SERVER, NETWORK_SERVER_NAME, readSetupState } from "../mcp/network/server";
import { isCaspersEntry, isNetworkServer } from "../mcp/network/setup";
import { installHint } from "../mcp/server-output";
import { tildePath } from "../new/scaffold";
import { isModelProviderKeyName } from "../platform/environment";
import { ShellSandbox } from "../sandbox/manager";
import { detectProject, toolNeeds } from "../security/detect";
import { gitState } from "../security/git";
import { findTool, installedVersion, onPath } from "../security/install";
import { SECURITY_TOOLS } from "../security/tools";
import { SECURITY_TOOL_ORDER, type SecurityToolId } from "../security/types";
import { themeNote } from "../tui/theme";
import { compareVersions, defaultRunner, lookUpNewest, type Fetcher, type Install, type ProcessRunner } from "../update/command";
import { jsonErrorPosition } from "./json-position";

/**
 * `casper doctor` and /doctor: Casper looks over its own setup. No model and no tokens. Each check gives plain lines:
 * ok (✓), worth knowing (!) or something to fix (✗), each problem with the one thing to do. Only three problems
 * have a fix Casper can make itself, each behind its own numbered question: a newer Casper, missing security tools,
 * and the network server.
 */

export type DoctorStatus = "ok" | "note" | "fail";
export type DoctorFix = "update" | "security" | "network";

export interface DoctorLine {
  status: DoctorStatus;
  text: string;
  /** The one thing to do, when there is one. */
  next?: string;
  /** A fix Casper can make after a numbered question. */
  fix?: DoctorFix;
}

export interface DoctorContext {
  homeDir: string;
  /** The project to look at (its languages and security tools), or undefined outside a project. */
  projectRoot?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  currentVersion: string;
  install: Install;
  /** Casper's model sign-in folder (~/.casper/agent). */
  agentDir: string;
  fetch?: Fetcher;
  run?: ProcessRunner;
  now?: () => number;
  /** Free bytes where ~/.casper lives (test seam). */
  freeBytes?: (folder: string) => Promise<number | undefined>;
  /** Why the sandbox can't hold commands here (test seam); undefined means it can. */
  sandboxProblem?: () => string | undefined;
  /** In a session: the MCP servers as they are now (a failed start says why). */
  mcpStatus?: () => MCPStatus[];
  /** The security tools this project needs that are missing (filled by the security check, for the fix). */
  missingTools?: SecurityToolId[];
}

const ok = (text: string): DoctorLine => ({ status: "ok", text });
const note = (text: string, next?: string, fix?: DoctorFix): DoctorLine => ({ status: "note", text, ...(next ? { next } : {}), ...(fix ? { fix } : {}) });
const fail = (text: string, next?: string, fix?: DoctorFix): DoctorLine => ({ status: "fail", text, ...(next ? { next } : {}), ...(fix ? { fix } : {}) });

function shown(ctx: DoctorContext, file: string): string {
  return tildePath(file, ctx.homeDir);
}

// --- Casper itself ---

/** The running Casper against the newest published release (previews count). One GitHub lookup, no tokens. */
export async function checkVersion(ctx: DoctorContext): Promise<DoctorLine[]> {
  if (ctx.env.CASPER_OFFLINE === "1") return [note(`Casper ${ctx.currentVersion}; newest release not checked (CASPER_OFFLINE=1)`)];
  const newest = await lookUpNewest(ctx.fetch ?? fetch, ctx.env, AbortSignal.timeout(15_000));
  if (typeof newest === "string") return [note(`Casper ${ctx.currentVersion}; the newest release is not known: ${newest.replace(/ Nothing was changed\.$/, "")}`)];
  if (compareVersions(newest.version, ctx.currentVersion) <= 0) return [ok(`Casper ${ctx.currentVersion}, the newest release`)];
  return [note(`Casper ${newest.version} is out (you have ${ctx.currentVersion})`, "casper update", "update")];
}

/** The program Casper runs as: the release binary, or the checkout's src/cli.ts. */
function runningProgram(install: Install): string {
  return install.kind === "binary" ? install.executable : path.join(install.root, "src", "cli.ts");
}

const CASPER_NAMES: Record<string, string[]> = { win32: ["casper.exe", "casper.cmd", "casper.bat", "casper"] };

/** The `casper` your shell finds first, and any broken link before it. */
async function casperOnPath(ctx: DoctorContext): Promise<{ found?: string; broken?: string }> {
  const pathValue = ctx.env.PATH ?? ctx.env.Path ?? "";
  const names = CASPER_NAMES[ctx.platform] ?? ["casper"];
  let broken: string | undefined;
  for (const dir of pathValue.split(ctx.platform === "win32" ? ";" : ":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      const link = await lstat(candidate).catch(() => undefined);
      if (!link) continue;
      const target = await stat(candidate).catch(() => undefined);
      if (!target) { broken ??= candidate; continue; }
      if (target.isFile()) return { found: candidate, ...(broken ? { broken } : {}) };
    }
  }
  return broken ? { broken } : {};
}

/** A `casper` on PATH that is a broken link, or another (older) copy than this one. */
export async function checkPathLink(ctx: DoctorContext): Promise<DoctorLine[]> {
  const { found, broken } = await casperOnPath(ctx);
  const lines: DoctorLine[] = [];
  if (broken) lines.push(fail(`${shown(ctx, broken)} is a link to a Casper that is gone`, `remove it: rm ${broken}`));
  if (!found) {
    if (!broken) lines.push(note("casper is not on your PATH, so typing casper won't find it", "add its folder to PATH (docs/PLATFORM_SUPPORT.md)"));
    return lines;
  }
  const running = await realpath(runningProgram(ctx.install)).catch(() => runningProgram(ctx.install));
  const first = await realpath(found).catch(() => found);
  if (first === running) return [...lines, ok(`casper on PATH is this one (${shown(ctx, found)})`)];
  // A wrapper script: ask it which program it runs. Only --version, which prints one line and changes nothing.
  const answer = await (ctx.run ?? defaultRunner)([found, "--version"], { env: ctx.env, timeoutMs: 10_000 });
  const match = /^casper (\S+) \((.*)\)\s*$/m.exec(answer.stdout);
  if (match && await realpath(match[2]!).catch(() => match[2]) === running) return [...lines, ok(`casper on PATH is this one (${shown(ctx, found)})`)];
  const version = match?.[1];
  if (version && compareVersions(version, ctx.currentVersion) < 0) {
    return [...lines, fail(`casper on PATH is an older copy: ${version} at ${shown(ctx, found)} (this one is ${ctx.currentVersion})`, `remove or replace ${found}`)];
  }
  return [...lines, note(`casper on PATH is another copy${version ? ` (${version})` : ""} at ${shown(ctx, found)}, not this one`)];
}

// --- Config files ---

interface ConfigFile { file: string; kind: "yaml" | "json" }

function configFiles(ctx: DoctorContext, profile: string): ConfigFile[] {
  const casper = path.join(ctx.homeDir, ".casper");
  const files: ConfigFile[] = [
    { file: path.join(casper, "config.yaml"), kind: "yaml" },
    { file: path.join(casper, "mcp.json"), kind: "json" },
    { file: path.join(casper, "lsp.json"), kind: "json" },
    { file: path.join(ctx.agentDir, "settings.json"), kind: "json" },
    { file: path.join(ctx.agentDir, "auth.json"), kind: "json" },
  ];
  if (isValidProfileName(profile) && profile !== "default") {
    for (const name of ["config.yaml", "mcp.json", "lsp.json"]) files.push({ file: path.join(casper, "profiles", profile, name), kind: name.endsWith(".yaml") ? "yaml" : "json" });
  }
  if (ctx.projectRoot) {
    files.push({ file: path.join(ctx.projectRoot, ".casper", "project.yaml"), kind: "yaml" });
    for (const name of [".casper/mcp.json", ".casper/lsp.json", "mcp.json", ".mcp.json"]) files.push({ file: path.join(ctx.projectRoot, name), kind: "json" });
  }
  return files;
}

/** Where a file does not parse, as "line N: what" (no file text is quoted: a login file must not leak). */
async function syntaxProblem(entry: ConfigFile): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(entry.file, "utf8"); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? undefined : code === "EISDIR" ? "it is a folder, not a file" : "it can't be read";
  }
  if (entry.kind === "json") {
    if (!text.trim()) return undefined;
    const at = jsonErrorPosition(text);
    return at ? `line ${at.line}, column ${at.column}: not valid JSON` : undefined;
  }
  try { parseYaml(text); return undefined; } catch (error) {
    const position = (error as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
    const what = (error instanceof Error ? error.message : "not valid YAML").split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "");
    return position ? `line ${position.line}, column ${position.col}: ${what}` : what;
  }
}

/** Config files that don't load, by file and line; then Casper's own settings check. */
export async function checkConfig(ctx: DoctorContext): Promise<{ lines: DoctorLine[]; loaded?: LoadedConfiguration }> {
  const profile = ctx.env.CASPER_PROFILE || "default";
  const lines: DoctorLine[] = [];
  for (const entry of configFiles(ctx, profile)) {
    const problem = await syntaxProblem(entry);
    if (problem) lines.push(fail(`${shown(ctx, entry.file)} doesn't load: ${problem}`, "fix that line, or move the file away to start fresh"));
  }
  let loaded: LoadedConfiguration | undefined;
  try {
    loaded = await loadConfiguration({ projectRoot: ctx.projectRoot ?? ctx.homeDir, homeDir: ctx.homeDir });
  } catch (error) {
    // A syntax error is already named with its line.
    if (!lines.length) lines.push(fail(`Settings don't load: ${error instanceof Error ? error.message : String(error)}`, "fix that setting in the file it names"));
  }
  for (const warning of loaded?.warnings ?? []) lines.push(note(warning));
  const theme = themeNote(loaded?.theme);
  if (theme) lines.push(note(theme));
  if (!lines.length) lines.push(ok("Config files load"));
  return { lines, ...(loaded ? { loaded } : {}) };
}

// --- Model sign-in ---

/** Providers set up in models.json (Pi's provider catalog) with their own key or address, such as a local server
 * or a company gateway: these work with no /login. Names only; a key is never shown. */
async function customProviders(ctx: DoctorContext): Promise<string[]> {
  try {
    const parsed: unknown = Bun.JSONC.parse(await readFile(path.join(ctx.agentDir, "models.json"), "utf8"));
    const providers = parsed && typeof parsed === "object" ? (parsed as { providers?: unknown }).providers : undefined;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
    return Object.entries(providers as Record<string, unknown>)
      .filter(([, value]) => {
        const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
        return (typeof entry.apiKey === "string" && Boolean(entry.apiKey)) || (typeof entry.baseUrl === "string" && Boolean(entry.baseUrl));
      })
      .map(([name]) => name)
      .sort();
  } catch { return []; }
}

/** Each provider in Casper's sign-in file, and any provider key in the environment. Reads only which providers are
 * there and when a sign-in runs out; never a key, and nothing is sent anywhere. */
export async function checkSignIn(ctx: DoctorContext): Promise<DoctorLine[]> {
  const now = (ctx.now ?? Date.now)();
  const lines: DoctorLine[] = [];
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(ctx.agentDir, "auth.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch { /* none, or the config check names the broken file */ }
  const signedIn: string[] = [];
  for (const [provider, value] of Object.entries(saved)) {
    // The web search key lives in the same file; it is not a model sign-in.
    if (provider === "brave") continue;
    const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (entry.type === "oauth") {
      const expires = typeof entry.expires === "number" ? entry.expires : undefined;
      // A sign-in with a refresh token renews itself on the next request.
      const renews = typeof entry.refresh === "string" && Boolean(entry.refresh);
      if (!renews && expires !== undefined && expires <= now) lines.push(fail(`Sign-in: ${provider} expired`, `type /login ${provider} in Casper`));
      else signedIn.push(provider);
    } else if (entry.type === "api_key" || typeof entry.key === "string") signedIn.push(provider);
    else lines.push(note(`Sign-in: ${provider} is saved in a form Casper can't read`, `type /login ${provider} in Casper`));
  }
  const custom = await customProviders(ctx);
  if (custom.length) signedIn.push(`${custom.join(", ")} (models.json)`);
  const fromEnv = Object.keys(ctx.env).filter((name) => ctx.env[name] && isModelProviderKeyName(name)).sort();
  if (fromEnv.length) signedIn.push(...fromEnv.map((name) => `$${name}`));
  if (signedIn.length) lines.unshift(ok(`Sign-in: ${signedIn.join(", ")}`));
  if (!lines.length) return [fail("No model sign-in", "run casper and type /login")];
  return lines;
}

// --- MCP servers ---

/** Why this server's command can't start here, without starting it: a missing program, a ${VAR} not set, a missing
 * start folder. Starting a server is your call (/mcp connect), so the doctor never runs one. */
async function launchProblem(ctx: DoctorContext, definition: MCPServerDefinition): Promise<{ text: string; next?: string } | undefined> {
  const transport = definition.transport;
  try {
    if (transport.type === "http") { resolveEnvironment(transport.url); for (const value of Object.values(transport.headers)) resolveEnvironment(value); return undefined; }
    for (const value of [transport.command, ...transport.args, ...Object.values(transport.env)]) resolveEnvironment(value);
  } catch (error) {
    if (error instanceof MissingEnvironmentError) return { text: `needs ${error.variable}, which is not set`, next: `set ${error.variable} before starting Casper` };
    throw error;
  }
  if (!(await stat(definition.cwd).then((entry) => entry.isDirectory(), () => false))) return { text: `its start folder ${shown(ctx, definition.cwd)} is missing` };
  const command = resolveEnvironment(transport.command);
  const hasFolder = command.includes("/") || (ctx.platform === "win32" && command.includes("\\"));
  const found = hasFolder
    ? await stat(path.resolve(definition.cwd, command)).then((entry) => entry.isFile(), () => false)
    : Boolean(await onPath(command, ctx.env, ctx.platform));
  if (found) return undefined;
  const hint = installHint(command);
  return { text: `${command} is not installed`, ...(hint ? { next: hint } : {}) };
}

export async function checkMcp(ctx: DoctorContext, profile: string): Promise<{ lines: DoctorLine[]; servers: MCPServerDefinition[] }> {
  const configuration = await discoverMCPConfiguration({ projectRoot: ctx.projectRoot ?? ctx.homeDir, homeDir: ctx.homeDir, profileName: profile, platform: ctx.platform });
  const lines: DoctorLine[] = configuration.diagnostics.map((diagnostic) => note(`MCP: ${diagnostic}`));
  const live = new Map((ctx.mcpStatus?.() ?? []).map((status) => [status.name, status]));
  let ready = 0;
  for (const definition of configuration.servers) {
    if (definition.disabled) continue;
    const status = live.get(definition.name);
    if (status?.state === "failed") {
      lines.push(fail(`MCP ${definition.name}: didn't start: ${status.error ?? "no reason given"}`, `/mcp connect ${definition.name} tries again`));
      continue;
    }
    const problem = await launchProblem(ctx, definition);
    if (problem) lines.push(fail(`MCP ${definition.name}: can't start: ${problem.text}`, problem.next));
    else ready++;
  }
  if (ready) lines.unshift(ok(`MCP: ${ready} server${ready === 1 ? "" : "s"} can start`));
  else if (!lines.length) lines.push(ok("MCP: no servers set up"));
  return { lines, servers: configuration.servers };
}

// --- Language servers ---

const LANGUAGES: Array<{ name: string; markers: string[]; extensions: string[] }> = [
  { name: "TypeScript", markers: ["tsconfig.json", "package.json"], extensions: [".ts", ".tsx", ".js", ".jsx"] },
  { name: "Python", markers: ["pyproject.toml", "requirements.txt", "setup.py", "uv.lock"], extensions: [".py"] },
  { name: "Go", markers: ["go.mod"], extensions: [".go"] },
  { name: "Rust", markers: ["Cargo.toml"], extensions: [".rs"] },
];

/** The project's languages (from its marker files) against the language servers set up for them. A language with no
 * server is worth knowing, not a problem: Casper works without one. */
export async function checkLanguageServers(ctx: DoctorContext, profile: string): Promise<DoctorLine[]> {
  if (!ctx.projectRoot) return [];
  const root = ctx.projectRoot;
  const present = [];
  for (const language of LANGUAGES) {
    for (const marker of language.markers) {
      if (await stat(path.join(root, marker)).then(() => true, () => false)) { present.push(language); break; }
    }
  }
  if (!present.length) return [];
  const { servers } = await discoverLSPConfiguration({ projectRoot: root, homeDir: ctx.homeDir, profileName: profile });
  const lines: DoctorLine[] = [];
  for (const language of present) {
    const server = servers.find((entry) => language.extensions.some((extension) => extension in entry.languages));
    if (!server) { lines.push(note(`${language.name}: no language server set up (optional)`, "docs/LSP.md")); continue; }
    const command = server.command;
    const found = path.isAbsolute(command) ? await stat(command).then((entry) => entry.isFile(), () => false) : Boolean(await onPath(command, ctx.env, ctx.platform));
    lines.push(found ? ok(`${language.name}: language server ${server.name}`)
      : fail(`${language.name}: language server ${server.name} can't start: ${command} is not installed`, `install it, or fix the path in ${shown(ctx, server.source)}`));
  }
  return lines;
}

// --- Security tools ---

/** The pinned security tools this project uses: missing ones, and copies of another version than Casper pins. */
export async function checkSecurityTools(ctx: DoctorContext): Promise<DoctorLine[]> {
  if (!ctx.projectRoot) return [];
  const root = await realpath(ctx.projectRoot);
  const needs = toolNeeds(await detectProject(root, await gitState(root)));
  const missing: SecurityToolId[] = [];
  const lines: DoctorLine[] = [];
  let pinned = 0;
  for (const id of SECURITY_TOOL_ORDER) {
    if (!needs[id].needed || (id === "semgrep" && ctx.platform === "win32")) continue;
    const spec = SECURITY_TOOLS[id];
    const location = await findTool(spec, { homeDir: ctx.homeDir, env: ctx.env, platform: ctx.platform });
    if (location.kind === "missing") missing.push(id);
    else if (location.kind === "path" && location.version !== spec.version) {
      lines.push(note(`Security tool ${spec.label}: your copy is ${location.version ?? "an unknown version"} (Casper pins ${spec.version})`));
    } else pinned++;
  }
  ctx.missingTools = missing;
  if (missing.length) {
    const labels = missing.map((id) => SECURITY_TOOLS[id].label);
    lines.unshift(note(`Security tools not installed yet: ${labels.join(", ")}`, "/security-review offers them when you first run it", "security"));
  } else if (!lines.length) lines.push(ok(`Security tools: ${pinned} ready`));
  return lines;
}

// --- Sandbox ---

export async function checkSandbox(ctx: DoctorContext, loaded: LoadedConfiguration | undefined): Promise<DoctorLine[]> {
  const state = ShellSandbox.detect({ platform: ctx.platform, agentDir: ctx.agentDir,
    ...(loaded ? { settings: loaded.sandbox } : {}), ...(ctx.sandboxProblem ? { problem: ctx.sandboxProblem } : {}) });
  if (state.kind === "on") return [ok("Sandbox: can hold shell commands here")];
  if (state.kind === "off") return [note(`Sandbox: off (${state.reason}); Casper asks before shell commands that change things`)];
  if (state.kind === "unsupported") return [note(`Sandbox: none on ${state.reason === "Windows" ? "Windows yet" : state.reason}; Casper asks before shell commands that change things`)];
  const reason = state.reason ?? "it can't start here";
  // The Linux reason already ends with the line to type (sudo apt install …, sudo sysctl …).
  const install = /: (sudo .+)$/.exec(reason);
  return [fail(`Sandbox: can't hold commands here: ${install ? reason.slice(0, install.index) : reason}`, install?.[1] ?? "see docs/SECURITY.md")];
}

// --- Disk ---

const LOW = 2 * 1024 ** 3;
const TOO_LOW = 512 * 1024 ** 2;

async function defaultFreeBytes(folder: string): Promise<number | undefined> {
  try { const info = await statfs(folder); return Number(info.bavail) * Number(info.bsize); } catch { return undefined; }
}

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export async function checkDisk(ctx: DoctorContext): Promise<DoctorLine[]> {
  const casper = path.join(ctx.homeDir, ".casper");
  const folder = await stat(casper).then(() => casper, () => ctx.homeDir);
  const free = await (ctx.freeBytes ?? defaultFreeBytes)(folder);
  if (free === undefined) return [note("Disk: free space not known")];
  if (free < TOO_LOW) return [fail(`Disk: only ${size(free)} free for ~/.casper`, "free some space; old saved conversations are in ~/.casper/sessions")];
  if (free < LOW) return [note(`Disk: ${size(free)} free for ~/.casper`)];
  return [ok(`Disk: ${size(free)} free`)];
}

// --- Network server ---

export async function checkNetworkServer(ctx: DoctorContext, servers: readonly MCPServerDefinition[]): Promise<DoctorLine[]> {
  const ours = servers.find((definition) => isCaspersEntry(definition, ctx.homeDir));
  if (!ours) {
    const other = servers.find((definition) => definition.name === NETWORK_SERVER_NAME || isNetworkServer(definition));
    if (other) return [ok(`Network server: your own (${other.name})`)];
    if ((await readSetupState(ctx.homeDir)).answer === "not-now") return [];
    return [note("Network server: not set up (optional, for Mist, Central and ClearPass)", "/mcp setup network", "network")];
  }
  const installed = await installedVersion(ctx.homeDir, NETWORK_SERVER, ctx.platform);
  if (!installed) return [fail(`Network server: in ${shown(ctx, ours.source)} but not installed`, "/mcp setup network", "network")];
  const logins = Object.keys(await readLogins(ctx.homeDir)) as Array<keyof typeof PRODUCT_LABELS>;
  const saved = logins.length ? `logins saved: ${logins.map((product) => PRODUCT_LABELS[product]).join(", ")}` : "no logins saved yet (asked the first time)";
  if (compareVersions(installed, NETWORK_SERVER.version) < 0) {
    return [note(`Network server: ${installed}, update ready (${NETWORK_SERVER.version}); ${saved}`, "/mcp setup network", "network")];
  }
  return [ok(`Network server: ${installed}; ${saved}`)];
}
