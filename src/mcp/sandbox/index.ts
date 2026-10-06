import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MCPServerDefinition } from "../config";
import type { MCPSandboxStatus } from "../manager";
import { quote, which } from "../../sandbox/linux";
import { ShellSandbox, type SandboxState } from "../../sandbox/manager";
import { seccompHelper } from "../../sandbox/seccomp";
import { realpathLongest } from "../../platform/project-paths";
import { serverProfile, type ServerProfile } from "./profile";
import { HostProxy } from "./proxy";

/**
 * Runs a local MCP server inside the same sandbox as the AI's shell (sandbox-exec on macOS, bubblewrap on Linux),
 * held to its profile (src/mcp/sandbox/profile.ts): it reads only its own install, writes only its cache, and reaches
 * only its hosts through its own proxy. Your home folder (keys, ~/.casper, your projects) and the system temp folder
 * are hidden from it. On by default for a server with a profile; `/mcp sandbox <name> off` turns it off for that
 * server (kept in ~/.casper/mcp-sandbox.json). A server without a profile, a machine with no sandbox (Windows), or a
 * sandbox that can't start: the server starts as it always did, and /mcp says why. Never a hard failure.
 */

/** How a server is started: what the MCP SDK spawns. */
export interface ServerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** A server held by the sandbox: how to start it, what /mcp says, and what to stop when it ends. */
export interface HeldServer {
  launch: ServerLaunch;
  profile: ServerProfile;
  /** Hosts its proxy refused. */
  refused(): string[];
  close(): Promise<void>;
}

/** held: in the sandbox. Otherwise it runs as before, and `why` says why (for /mcp). */
export type HoldResult = { held: HeldServer } | { open: "none" | "off" | "failed"; why: string };

/** The servers you turned the sandbox off for (by name), in Casper's own folder. */
export const MCP_SANDBOX_FILE = path.join(".casper", "mcp-sandbox.json");

export class MCPSandboxStore {
  /** The list as last read or written, for /mcp (read again before each start). */
  private cached: string[];
  constructor(private readonly home: string) {
    let text = "";
    try { text = readFileSync(this.file, "utf8"); } catch { /* none yet */ }
    this.cached = parseOff(text);
  }
  get file(): string { return path.join(this.home, MCP_SANDBOX_FILE); }

  async offList(): Promise<string[]> {
    this.cached = parseOff(await readFile(this.file, "utf8").catch(() => ""));
    return [...this.cached];
  }

  /** From the last read: no file access (for /mcp). */
  offNow(name: string): boolean { return this.cached.includes(name); }

  async isOff(name: string): Promise<boolean> { return (await this.offList()).includes(name); }

  async set(name: string, on: boolean): Promise<void> {
    const off = new Set(await this.offList());
    if (on) off.delete(name); else off.add(name);
    this.cached = [...off].sort();
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ off: [...off].sort() })}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
}

function parseOff(text: string): string[] {
  try {
    const off = (JSON.parse(text) as { off?: unknown })?.off;
    return Array.isArray(off) ? off.filter((name): name is string => typeof name === "string").slice(0, 500) : [];
  } catch { return []; }
}

export interface MCPServerSandboxOptions {
  home: string;
  /** The session's sandbox state (off with --no-sandbox or `sandbox: off`, missing, unsupported). */
  state?: () => SandboxState;
  /** Folders hidden from the server besides your home folder and the temp folders (the open project). */
  hide?: () => string[];
  platform?: NodeJS.Platform;
  /** Linux's apply-seccomp helper (test seam). */
  seccompPath?: () => Promise<string | undefined>;
  /** One plain line for you ([mcp] ...). */
  note?: (line: string) => void;
}

/** Files every program writes on macOS (the runtime's own list). */
const DEVICE_WRITES = ["/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait"];
/** The port the proxy has inside the Linux sandbox (socat bridges it to the proxy's socket). */
const LINUX_PROXY_PORT = 3128;

type MacWrap = typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js").wrapCommandWithSandboxMacOS;

export class MCPServerSandbox {
  readonly store: MCPSandboxStore;
  constructor(private readonly options: MCPServerSandboxOptions) {
    this.store = new MCPSandboxStore(options.home);
  }

  get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }

  private state(): SandboxState {
    return this.options.state?.() ?? ShellSandbox.detect({ platform: this.platform });
  }

  /** The profile a server would get now (for /mcp), or why none. */
  profile(definition: MCPServerDefinition, logins: Record<string, string> = {}): ReturnType<typeof serverProfile> {
    return serverProfile(definition, { home: this.options.home, logins, platform: this.platform });
  }

  setOn(name: string, on: boolean): Promise<void> { return this.store.set(name, on); }

  /** What /mcp says before a start: no file access, and no hosts yet (they come from the logins at the start). */
  expected(definition: MCPServerDefinition): MCPSandboxStatus | undefined {
    const found = this.profile(definition);
    if ("none" in found) return { state: "none", why: found.none };
    if (this.store.offNow(definition.name)) return { state: "off", why: offWhy(definition.name) };
    const state = this.state();
    if (state.kind !== "on") return { state: "failed", why: stateWhy(state) };
    return { state: "on" };
  }

  /**
   * How to start `definition`: held by the sandbox when it has a profile, the sandbox runs here and you did not turn
   * it off; else as it is. Never throws: anything that goes wrong starts it as before, with the reason.
   */
  async hold(definition: MCPServerDefinition, launch: ServerLaunch, logins: Record<string, string>): Promise<HoldResult> {
    const found = this.profile(definition, logins);
    if ("none" in found) return { open: "none", why: found.none };
    if (await this.store.isOff(definition.name)) return { open: "off", why: offWhy(definition.name) };
    const state = this.state();
    if (state.kind !== "on") return { open: "failed", why: stateWhy(state) };
    try {
      return { held: await this.wrap(definition.name, found.profile, launch) };
    } catch (error) {
      const why = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      return { open: "failed", why: `the sandbox could not start (${why})` };
    }
  }

  private async wrap(name: string, profile: ServerProfile, launch: ServerLaunch): Promise<HeldServer> {
    await mkdir(profile.cache, { recursive: true, mode: 0o700 });
    const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-mcp-")));
    const cleanups: (() => Promise<unknown>)[] = [() => rm(temp, { recursive: true, force: true })];
    const close = async () => { for (const step of cleanups.splice(0).reverse()) await step().catch(() => {}); };
    try {
      const linux = this.platform === "linux";
      const proxy = await HostProxy.start({
        hosts: profile.hosts,
        ...(linux ? { socket: path.join(temp, "proxy.sock") } : {}),
        onRefused: (host) => this.options.note?.(`[mcp] The sandbox kept ${name} from reaching ${host} (it may reach only ${profile.hosts.join(", ") || "no hosts"}).`),
      });
      cleanups.push(() => proxy.close());
      // It starts in /: a start folder inside a hidden one (your home) leaves the shell that starts it waiting on macOS.
      const cwd = "/";
      const proxyUrl = `http://127.0.0.1:${linux ? LINUX_PROXY_PORT : proxy.listenPort}`;
      const env: Record<string, string> = {
        ...withoutProxy(launch.env), HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, TMPDIR: temp,
      };
      const held = linux
        ? await this.linux(profile, { ...launch, env, cwd }, temp)
        : await this.mac(profile, { ...launch, env, cwd }, temp, proxy.listenPort!, proxyUrl);
      return { launch: held, profile, refused: () => proxy.refused(), close };
    } catch (error) { await close(); throw error; }
  }

  /** What is hidden: your home folder, the temp folders, and the open project. */
  private hidden(): string[] {
    const tmp = [os.tmpdir(), "/tmp", "/var/tmp"].filter((dir) => existsSync(dir));
    return unique([this.options.home, ...tmp, ...(this.options.hide?.() ?? [])].flatMap((entry) => [path.resolve(entry), realpathLongest(entry)]))
      .filter((entry) => entry !== path.parse(entry).root);
  }

  private async mac(profile: ServerProfile, launch: Required<ServerLaunch>, temp: string, port: number, proxyUrl: string): Promise<ServerLaunch> {
    if (!existsSync("/usr/bin/sandbox-exec")) throw new Error("sandbox-exec is missing");
    const { wrapCommandWithSandboxMacOS } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js") as { wrapCommandWithSandboxMacOS: MacWrap };
    const reads = unique([...profile.reads, profile.cache, temp].flatMap((entry) => [path.resolve(entry), realpathLongest(entry)]));
    // The runtime sets its own proxy and temp settings; the server's own come last, inside the sandbox.
    const inner = [
      "unset NO_PROXY no_proxy ALL_PROXY all_proxy",
      `export HTTPS_PROXY=${quote(proxyUrl)} https_proxy=${quote(proxyUrl)} HTTP_PROXY=${quote(proxyUrl)} http_proxy=${quote(proxyUrl)} TMPDIR=${quote(temp)}`,
      `exec ${[launch.command, ...launch.args].map(quote).join(" ")}`,
    ].join("; ");
    const wrapped = wrapCommandWithSandboxMacOS({
      command: inner, needsNetworkRestriction: true, httpProxyPort: port, socksProxyPort: undefined,
      readConfig: { denyOnly: this.hidden(), allowWithinDeny: reads },
      writeConfig: { allowOnly: unique([profile.cache, realpathLongest(profile.cache), temp, ...DEVICE_WRITES]), denyWithinAllow: [] },
      allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false, binShell: "/bin/sh",
    } as Parameters<MacWrap>[0]);
    return { command: "/bin/sh", args: ["-c", wrapped], env: launch.env, cwd: launch.cwd };
  }

  private async linux(profile: ServerProfile, launch: Required<ServerLaunch>, temp: string): Promise<ServerLaunch> {
    const bwrap = which("bwrap");
    const socat = which("socat");
    if (!bwrap || !socat) throw new Error(`${!bwrap ? "bubblewrap" : "socat"} is missing`);
    const seccomp = await (this.options.seccompPath ?? (() => seccompHelper()))().catch(() => undefined);
    if (!seccomp) throw new Error(`no seccomp helper for ${process.arch}, so Unix sockets can't be blocked`);
    const args = mcpBwrapArgs({
      hidden: this.hidden(), reads: [...profile.reads], writes: [profile.cache, temp], cwd: launch.cwd,
      socat, socket: path.join(temp, "proxy.sock"), port: LINUX_PROXY_PORT, seccomp, command: [launch.command, ...launch.args],
    });
    return { command: bwrap, args, env: launch.env, cwd: launch.cwd };
  }
}

export interface McpBwrapInput {
  /** Folders hidden (an empty folder in their place). */
  hidden: string[];
  /** Folders bound back read-only, then writable. */
  reads: string[];
  writes: string[];
  cwd: string;
  socat: string;
  /** The proxy's Unix socket, bridged to 127.0.0.1:`port` inside. */
  socket: string;
  port: number;
  seccomp: string;
  command: string[];
}

/**
 * bubblewrap's arguments for one MCP server: the machine read-only, no network of its own (only the bridge to its
 * proxy), your home folder, the temp folders and the project hidden, its own folders bound back, and no Unix sockets
 * for the server itself (apply-seccomp; the bridge starts first, outside it).
 */
export function mcpBwrapArgs(input: McpBwrapInput): string[] {
  const isDir = (entry: string) => { try { return statSync(entry).isDirectory(); } catch { return false; } };
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const entry of [...input.hidden].sort((a, b) => a.length - b.length)) if (isDir(entry)) args.push("--tmpfs", entry);
  for (const entry of input.reads) if (existsSync(entry)) args.push("--ro-bind", entry, entry);
  for (const entry of input.writes) if (existsSync(entry)) args.push("--bind", entry, entry);
  const bridge = `${quote(input.socat)} TCP-LISTEN:${input.port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${quote(input.socket)} >/dev/null 2>&1 &`;
  args.push("--chdir", input.cwd, "--", "/bin/sh", "-c", `${bridge}\nexec ${[input.seccomp, ...input.command].map(quote).join(" ")}`);
  return args;
}

const offWhy = (name: string) => `you turned it off for this server (/mcp sandbox ${name} on)`;
const stateWhy = (state: SandboxState) => state.kind === "off" ? `the sandbox is off (${state.reason ?? "off"})`
  : `no sandbox here (${state.reason === "Windows" ? "Windows has no sandbox yet" : state.reason ?? state.kind})`;

function withoutProxy(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^((https?|all|no)_proxy)$/i.test(name)));
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

/** The session's sandbox state for MCP servers: a sandbox that failed to start counts as not there. */
export function shellSandboxState(sandbox: Pick<ShellSandbox, "state" | "failure">): () => SandboxState {
  return () => sandbox.failure ? { kind: "missing", reason: sandbox.failure } : sandbox.state;
}

/** The /mcp line under a server about its sandbox; none for a server Casper has no profile for (the summary says it). */
export function sandboxLines(name: string, status: MCPSandboxStatus | undefined): string[] {
  if (!status || status.state === "none") return [];
  if (status.state === "off") return [`  sandbox: off for this server (/mcp sandbox ${name} on)`];
  if (status.state === "failed") return [`  sandbox: not used, ${status.why ?? "it can't run here"}; it runs as before`];
  const hosts = status.hosts ? (status.hosts.length ? status.hosts.join(", ") : "no hosts (no login saved)") : "its login hosts";
  return [
    `  sandbox: on · reaches only ${hosts} · writes only its cache · can't read your keys, ~/.casper or projects (/mcp sandbox ${name} off)`,
    ...(status.refused?.length ? [`  sandbox kept it from reaching: ${status.refused.join(", ")}`] : []),
  ];
}

/** One line under the /mcp list: which local servers run sandboxed, and which don't. */
export function sandboxSummary(statuses: readonly { name: string; sandbox?: MCPSandboxStatus }[]): string | undefined {
  const local = statuses.filter((status) => status.sandbox);
  if (!local.length) return undefined;
  const on = local.filter((status) => status.sandbox!.state === "on").map((status) => status.name);
  const unknown = local.filter((status) => status.sandbox!.state === "none").map((status) => status.name);
  const other = local.filter((status) => status.sandbox!.state === "off" || status.sandbox!.state === "failed").map((status) => status.name);
  const parts = [
    on.length ? `Sandboxed: ${on.join(", ")}.` : "No server runs sandboxed.",
    ...(other.length ? [`Not sandboxed: ${other.join(", ")} (see above).`] : []),
    ...(unknown.length ? [`Run as they are: ${unknown.join(", ")} (Casper doesn't know what ${unknown.length === 1 ? "it needs" : "they need"}).`] : []),
  ];
  return parts.join(" ");
}

/** The session's MCP server sandbox: held like the AI's shell (off with it), with the open project hidden too. */
export function mcpServerSandbox(home: string, shell: Pick<ShellSandbox, "state" | "failure">, project: () => string[], note: (line: string) => void): MCPServerSandbox {
  return new MCPServerSandbox({ home, state: shellSandboxState(shell), hide: project, note });
}
