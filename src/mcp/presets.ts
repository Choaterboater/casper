import path from "node:path";

/** What "writes off" means, in the one sentence /mcp, /help all and the docs all use. */
export const WRITES_OFF_MEANING = "Writes off: the server runs with its read-only settings, and every change asks you first.";
import type { CapabilitySafety } from "../capabilities/broker";
import type { MCPServerDefinition } from "./config";
import type { MCPTool } from "./manager";

/**
 * Presets for known network MCP servers. A preset can only make Casper stricter: it may pin
 * read-only settings, raise a tool's label, hide tools while writes are off, refuse arguments, add
 * notes to the approval box or refuse remembered approval. It never lowers a label, never claims a
 * server is read-only and never skips an approval on its own. The one opt-in (Junos show commands)
 * is turned on by the user per server, and even then only plain `show` commands pass the parser.
 */

/** Order used to compare labels. Higher is stricter. */
const SAFETY_RANK: Record<CapabilitySafety, number> = {
  read: 0, diagnostic: 1, "external-action": 2, write: 3, exec: 4, destructive: 5,
};
export const SAFETY_ORDER = Object.keys(SAFETY_RANK) as CapabilitySafety[];
export function safetyRank(safety: CapabilitySafety): number { return SAFETY_RANK[safety]; }
/** The stricter of two labels. Presets go through this, so they can never lower a label. */
export function strictest(a: CapabilitySafety, b: CapabilitySafety): CapabilitySafety {
  return SAFETY_RANK[b] > SAFETY_RANK[a] ? b : a;
}

export type ArgGuardResult = "allow" | "ask" | { refuse: string };
export interface ArgGuardContext { writes: "off" | "on"; showOptIn: boolean }
export interface PresetPins { env: Record<string, string>; appendArgs: string[] }

export interface Preset {
  id: string;
  /** Product name for the user, e.g. "Central" in "Central writes are off." */
  label: string;
  matchDefinition(definition: MCPServerDefinition): boolean;
  /** Tool names that must all be present to recognise the server by its tool list. */
  toolSignature?: string[];
  /** Settings that keep the server itself read-only while writes are off. */
  pins?: PresetPins;
  /** Why no pin exists, for the /mcp line. */
  noPinReason?: string;
  tighten?(tool: MCPTool, safety: CapabilitySafety): CapabilitySafety;
  hideWhenWritesOff?(tool: MCPTool): boolean;
  argGuard?(tool: MCPTool, args: Record<string, unknown>, context: ArgGuardContext): ArgGuardResult;
  approvalNotes?(tool: MCPTool): string[];
  /** Tools whose "preview" would really run the change. */
  noPreview?(tool: MCPTool): boolean;
  rememberBlock?(definition: MCPServerDefinition): string | undefined;
  /** The user's own settings that already keep writes off (shown when writes are turned on). */
  userKeepsWritesOff?(definition: MCPServerDefinition): string[];
  advice?: string;
  /** Call and connect limits. They are not safety settings and never part of the definition hash. */
  limits?: { callMs?: number; connectMs?: number };
  /** Casper's own network server: the logins saved in ~/.casper/network-logins.json go into its start env
   * (only when recognised by its definition, never by its tool list, and never for a project's server). */
  logins?: true;
  /** A call whose kinds are all "troubleshoot" runs without turning writes on: the server's own gate lets its
   * hand-checked troubleshooting list through its read-only pin. */
  troubleshootRunsPinned?: true;
  /** invoke_tool running one tool Casper can see is judged as a write plus that tool's own name and kind, not as a
   * destructive dispatcher (only when recognised by its definition). Risky and disruptive kinds still ask every time. */
  routedByRealTool?: true;
}

// ---------------------------------------------------------------------------
// Definition helpers
// ---------------------------------------------------------------------------

function stdio(definition: MCPServerDefinition) {
  return definition.transport.type === "stdio" ? definition.transport : undefined;
}
/** Command and args as one lowercase string list, for "contains" checks. */
function words(definition: MCPServerDefinition): string[] {
  const transport = stdio(definition);
  if (!transport) return [];
  return [transport.command, path.basename(transport.command), ...transport.args].map((word) => word.toLowerCase());
}
function mentions(definition: MCPServerDefinition, needle: RegExp): boolean {
  return words(definition).some((word) => needle.test(word));
}
function envKeys(definition: MCPServerDefinition): string[] {
  return Object.keys(stdio(definition)?.env ?? {});
}
function httpHost(definition: MCPServerDefinition): string | undefined {
  if (definition.transport.type !== "http") return undefined;
  try { return new URL(definition.transport.url).hostname.toLowerCase(); } catch { return undefined; }
}
const named = (...names: string[]) => (tool: MCPTool) => names.includes(tool.name);
const notAnnotatedRead = (tool: MCPTool) => tool.annotations?.readOnlyHint !== true;
const truthy = (value: string | undefined) => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

// ---------------------------------------------------------------------------
// Unpinned package runners
// ---------------------------------------------------------------------------

const EXACT_VERSION = /^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;
function commandName(command: string): string {
  return path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}
/** `pkg@1.2.3`, `@scope/pkg@1.2.3`: pinned when the version is exact. */
function npmSpecPinned(spec: string): boolean {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return false;
  return EXACT_VERSION.test(spec.slice(at + 1));
}
/** `pkg==1.2.3`, `pkg@1.2.3`, or a git URL ending in `@<commit>`. */
function pythonSpecPinned(spec: string): boolean {
  if (/^git\+/.test(spec)) {
    const at = spec.lastIndexOf("@");
    return at > spec.indexOf("://") && COMMIT.test(spec.slice(at + 1).replace(/#.*$/, ""));
  }
  const exact = /^[A-Za-z0-9_.[\],-]+===?(.+)$/.exec(spec);
  if (exact) return EXACT_VERSION.test(exact[1]!);
  const at = spec.lastIndexOf("@");
  return at > 0 && EXACT_VERSION.test(spec.slice(at + 1));
}
/** `image@sha256:...` or `image:tag` with a tag other than latest. */
function imagePinned(image: string): boolean {
  if (/@sha256:[0-9a-f]{64}$/i.test(image)) return true;
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon <= slash) return false;
  const tag = image.slice(colon + 1);
  return tag !== "" && tag.toLowerCase() !== "latest";
}

/** Options that take a value in `docker run` / `podman run`. Anything unknown stops the parse. */
const DOCKER_VALUE_OPTIONS = new Set([
  "-e", "--env", "--env-file", "-v", "--volume", "--name", "--network", "--net", "-p", "--publish", "-w", "--workdir",
  "-u", "--user", "--entrypoint", "--mount", "-l", "--label", "--platform", "--pull", "-h", "--hostname", "--add-host",
  "--cpus", "-m", "--memory", "--dns", "--cap-add", "--cap-drop", "--security-opt", "--tmpfs", "--ulimit", "--log-driver",
  "--log-opt", "--restart", "--stop-signal", "--stop-timeout", "--pids-limit", "--group-add", "--ipc", "--pid", "--userns",
]);
const DOCKER_FLAG_OPTIONS = new Set([
  "-i", "-t", "-it", "-ti", "--interactive", "--tty", "--rm", "-d", "--detach", "--init", "--read-only", "-q", "--quiet",
  "--privileged", "-P", "--publish-all", "--no-healthcheck", "--sig-proxy",
]);
export interface ContainerRun { runIndex: number; imageIndex: number; image: string }
/** Where the image sits in `docker run ... image ...`, or undefined when Casper can't tell. */
export function containerRun(definition: MCPServerDefinition): ContainerRun | undefined {
  const transport = stdio(definition);
  if (!transport || !["docker", "podman"].includes(commandName(transport.command))) return undefined;
  const args = transport.args;
  let index = 0;
  if (args[0] === "container") index = 1;
  if (args[index] !== "run") return undefined;
  const runIndex = index;
  for (index += 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) return { runIndex, imageIndex: index, image: arg };
    if (arg === "--") return undefined;
    const option = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (arg.includes("=") && (DOCKER_VALUE_OPTIONS.has(option) || DOCKER_FLAG_OPTIONS.has(option))) continue;
    if (DOCKER_FLAG_OPTIONS.has(arg)) continue;
    if (DOCKER_VALUE_OPTIONS.has(arg)) { index += 1; continue; }
    return undefined;
  }
  return undefined;
}
export function isContainerCommand(definition: MCPServerDefinition): boolean {
  const transport = stdio(definition);
  return !!transport && ["docker", "podman"].includes(commandName(transport.command));
}

/** First argument that is not an option, after `skip` leading words. */
function firstPositional(args: string[], valueOptions: Set<string>): { spec?: string; from?: string } {
  let from: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--from" || arg === "--package" || arg === "-p" || arg === "--spec") { from = args[index + 1]; index += 1; continue; }
    if (arg.startsWith("--from=") || arg.startsWith("--package=") || arg.startsWith("--spec=")) { from = arg.slice(arg.indexOf("=") + 1); continue; }
    if (arg.startsWith("-")) { if (valueOptions.has(arg)) index += 1; continue; }
    return { spec: arg, from };
  }
  return { from };
}
const RUNNER_VALUE_OPTIONS = new Set(["--python", "--with", "--index-url", "--extra-index-url", "-c", "--call", "--registry", "--cache"]);

export interface RunnerPin { runner: string; pinned: boolean; example: string }
/**
 * For servers started through a package runner (npx, bunx, pnpm dlx, yarn dlx, npm exec, uvx, uv tool run,
 * uv run --with, pipx run, deno run of an address, nix run, docker/podman run): whether the package or image is pinned to a fixed version. An
 * unpinned runner can fetch new code later with the same definition, so it never gets remembered
 * approval. Commands that are not runners return undefined.
 */
export function runnerPin(definition: MCPServerDefinition): RunnerPin | undefined {
  const transport = stdio(definition);
  if (!transport) return undefined;
  const command = commandName(transport.command);
  const args = transport.args;
  if (command === "docker" || command === "podman") {
    const run = containerRun(definition);
    if (!run) return args.includes("run") ? { runner: command, pinned: false, example: "a version tag or an @sha256 digest" } : undefined;
    return { runner: command, pinned: imagePinned(run.image), example: "a version tag or an @sha256 digest" };
  }
  let rest: string[] | undefined;
  let kind: "npm" | "python" | undefined;
  if (command === "npx" || command === "bunx") { rest = args; kind = "npm"; }
  else if ((command === "pnpm" || command === "yarn") && args[0] === "dlx") { rest = args.slice(1); kind = "npm"; }
  else if (command === "bun" && args[0] === "x") { rest = args.slice(1); kind = "npm"; }
  else if (command === "uvx") { rest = args; kind = "python"; }
  else if (command === "uv" && args[0] === "tool" && args[1] === "run") { rest = args.slice(2); kind = "python"; }
  else if (command === "pipx" && args[0] === "run") { rest = args.slice(1); kind = "python"; }
  else if (command === "npm" && (args[0] === "exec" || args[0] === "x")) { rest = args.slice(1); kind = "npm"; }
  else if (command === "uv" && args[0] === "run") return uvRunPin(args.slice(1));
  else if (command === "deno" && (args[0] === "run" || args[0] === "serve")) {
    // A server from an address or a package registry can change under the same command; a local file can't.
    const { spec } = firstPositional(args.slice(1), new Set(["--config", "-c", "--import-map", "--location", "--cert", "--lock"]));
    if (spec && /^https?:\/\//i.test(spec)) return { runner: "deno", pinned: false, example: "a local checkout or npm:pkg@1.4.2" };
    if (spec && /^(npm|jsr):/.test(spec)) return { runner: "deno", pinned: npmSpecPinned(spec.slice(4)), example: "npm:pkg@1.4.2" };
    return undefined;
  } else if (command === "nix" && (args[0] === "run" || args[0] === "shell")) {
    const { spec } = firstPositional(args.slice(1), new Set(["--override-input", "--inputs-from"]));
    if (!spec || /^(\.|\/|path:)/.test(spec)) return undefined;
    return { runner: "nix", pinned: /\/[0-9a-f]{40}(?:[#?]|$)|[?&]rev=[0-9a-f]{40}/.test(spec), example: "a flake reference with a commit" };
  }
  if (!rest || !kind) return undefined;
  const { spec, from } = firstPositional(rest, RUNNER_VALUE_OPTIONS);
  const target = from ?? spec;
  if (kind === "npm") return { runner: command, pinned: !!target && npmSpecPinned(target), example: "@1.4.2" };
  return { runner: command, pinned: !!target && pythonSpecPinned(target), example: "==1.4.2 or a commit" };
}

/** `uv run --with <spec>` installs the newest matching package on every start: pinned only when every --with is. A
 * plain `uv run` of a local checkout is not a runner that downloads. */
function uvRunPin(args: string[]): RunnerPin | undefined {
  const withs: string[] = [];
  let remote = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) break;
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (name === "--with") withs.push(...(value ?? "").split(",").map((spec) => spec.trim()).filter(Boolean));
    if (name === "--with-requirements" && /^https?:\/\//i.test(value ?? "")) remote = true;
    if (!arg.includes("=") && ["--with", "--with-requirements", "--with-editable", "--directory", "--project", "--python", "-p", "--from", "--index-url", "--extra-index-url"].includes(name)) index += 1;
  }
  if (!withs.length && !remote) return undefined;
  return { runner: "uv run", pinned: !remote && withs.every(pythonSpecPinned), example: "==1.4.2 or a commit" };
}

export function notPinnedText(name: string, example: string): string {
  return `Not remembered: ${name} is not pinned to a version. An update could add write tools. Pin it (for example ${example}) and connect again.`;
}

// ---------------------------------------------------------------------------
// Junos show-only parser
// ---------------------------------------------------------------------------

const JUNOS_PIPES = new Set(["match", "except", "count", "display", "no-more", "last", "find", "trim"]);
/**
 * A plain Junos `show` command: the literal word `show` first (no abbreviations), no `;`, no line
 * breaks, no redirection, and every `|` stage from a small read-only list (`| save` is refused).
 */
export function isPlainJunosShow(command: unknown): boolean {
  if (typeof command !== "string" || command.length > 512) return false;
  if (/[;\r\n\u0000`>&$\\]/.test(command)) return false;
  const stages = command.split("|").map((stage) => stage.trim());
  const head = stages[0]!.split(/\s+/);
  if (head[0] !== "show" || head.length < 2 || !/^[a-z]/.test(head[1]!)) return false;
  for (const stage of stages.slice(1)) {
    const word = stage.split(/\s+/)[0];
    if (!word || !JUNOS_PIPES.has(word)) return false;
  }
  return true;
}

const JUNOS_EXECUTE = new Set(["execute_junos_command", "execute_junos_command_batch", "execute_junos_pfe_command"]);
const JUNOS_WRITES_OFF = "Junos writes are off; only show commands run.";
function junosArgGuard(tool: MCPTool, args: Record<string, unknown>, context: ArgGuardContext): ArgGuardResult {
  if (tool.name === "load_and_commit_config" || tool.name === "render_and_apply_j2_template") {
    return context.writes === "off" ? { refuse: JUNOS_WRITES_OFF } : "ask";
  }
  if (!JUNOS_EXECUTE.has(tool.name)) return "ask";
  const commands: unknown[] = [];
  if ("command" in args) commands.push(args.command);
  if ("commands" in args) {
    if (!Array.isArray(args.commands)) commands.push(undefined);
    else commands.push(...args.commands);
  }
  const allShow = commands.length > 0 && commands.every(isPlainJunosShow);
  if (!allShow) return context.writes === "off" ? { refuse: JUNOS_WRITES_OFF } : "ask";
  // PFE shell commands always ask, even plain shows.
  if (tool.name === "execute_junos_pfe_command") return "ask";
  return context.showOptIn ? "allow" : "ask";
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const HPE_GATES = [
  "HPE_MCP_CENTRAL_WRITES", "HPE_MCP_GLP_V2BETA1_WRITES", "HPE_MCP_AOS8_WRITES", "HPE_MCP_EDGECONNECT_WRITES",
  "HPE_MCP_APSTRA_WRITES", "HPE_MCP_MIST_WRITES", "HPE_MCP_CLEARPASS_WRITES", "HPE_MCP_UXI_WRITES", "HPE_MCP_AXIS_WRITES",
  "HPE_MCP_AOS8_ROLLBACK_WRITES",
];
const CANT_PIN_REMOTE = "it runs elsewhere";

const TABLE: Preset[] = [
  {
    // casper-network-mcp, the server Casper sets up itself (Mist, Central, ClearPass behind one router).
    // --read-only is its only write switch. No tighten: invoke_tool is a write (routedByRealTool), and the real tool's kind
    // (its name words and find_tool's kind) makes risky calls ask every time; tightening it to destructive
    // would take "Yes, for this session" away from every change. invoke_tool stays visible, so a change can
    // reach the box that turns writes on. Before hpe-networking-mcp: both have find_tool.
    id: "casper-network-mcp",
    label: "Network",
    matchDefinition: (definition) => mentions(definition, /casper-network-mcp|casper_network_mcp/),
    toolSignature: ["find_tool", "invoke_read_tool", "invoke_tool", "access_check"],
    pins: { env: {}, appendArgs: ["--read-only"] },
    logins: true,
    troubleshootRunsPinned: true,
    routedByRealTool: true,
    limits: { callMs: 300_000 },
  },
  {
    // hpe-networking-mcp. Recognised by what it runs, never by its name, because
    // another project uses the same name.
    id: "hpe-networking-mcp",
    label: "HPE networking",
    matchDefinition: (definition) => mentions(definition, /tool_router\.py$|^hpe-mcp-router$|hpe_networking_mcp/)
      || envKeys(definition).some((key) => key.startsWith("HPE_MCP_")),
    toolSignature: ["find_tool", "invoke_read_tool", "invoke_tool"],
    pins: {
      // safe-read-only with any gate at 1 is a startup error in the server, so every gate is pinned to 0.
      env: {
        HPE_MCP_ACCESS_PROFILE: "safe-read-only", HPE_MCP_READONLY: "1", HPE_MCP_PRODUCT_ACCESS: "read-only",
        ...Object.fromEntries(HPE_GATES.map((gate) => [gate, "0"])),
      },
      appendArgs: [],
    },
    tighten: (tool, safety) => ["invoke_tool", "invoke_tools_batch"].includes(tool.name) ? "destructive" : safety,
    hideWhenWritesOff: named("invoke_tool", "invoke_tools_batch"),
    userKeepsWritesOff: (definition) => {
      const env = stdio(definition)?.env ?? {};
      return [
        ...(env.HPE_MCP_ACCESS_PROFILE?.trim().toLowerCase() === "safe-read-only" ? ["HPE_MCP_ACCESS_PROFILE=safe-read-only"] : []),
        ...(truthy(env.HPE_MCP_READONLY) ? [`HPE_MCP_READONLY=${env.HPE_MCP_READONLY}`] : []),
      ];
    },
  },
  {
    // aruba-* servers built on centralmcp.
    id: "centralmcp",
    label: "Central",
    matchDefinition: (definition) => mentions(definition, /centralmcp/) || envKeys(definition).some((key) => key.startsWith("CENTRALMCP_")),
    pins: { env: { CENTRALMCP_READONLY: "1" }, appendArgs: [] },
    userKeepsWritesOff: (definition) => truthy(stdio(definition)?.env.CENTRALMCP_READONLY) ? ["CENTRALMCP_READONLY=1"] : [],
  },
  {
    // Karthik's central-mcp-server: no read-only setting exists, so only the version pin is checked.
    id: "central-mcp-server",
    label: "Central",
    matchDefinition: (definition) => mentions(definition, /central-mcp-server|central_mcp_server/),
    noPinReason: "it has no read-only setting",
    hideWhenWritesOff: notAnnotatedRead,
    rememberBlock: (definition) => {
      const spec = words(definition).find((word) => /central[-_]mcp[-_]server/.test(word));
      if (spec && (pythonSpecPinned(spec) || npmSpecPinned(spec))) return undefined;
      if (spec && /^[./~]|^[a-z]:\\/i.test(spec)) return undefined; // a local checkout the user controls
      return notPinnedText(definition.name, "==1.4.2 or a commit");
    },
  },
  {
    // Juniper junos-mcp-server. Nothing is annotated and nothing can be pinned.
    id: "junos-mcp-server",
    label: "Junos",
    matchDefinition: (definition) => mentions(definition, /jmcp\.py$|junos-mcp-server|junos_mcp/),
    toolSignature: ["execute_junos_command", "load_and_commit_config", "get_router_list"],
    noPinReason: "it has no read-only setting",
    tighten: (tool, safety) => {
      if (tool.name === "load_and_commit_config" || tool.name === "render_and_apply_j2_template") return "destructive";
      if (tool.name.startsWith("execute_")) return strictest(safety, "exec");
      return safety;
    },
    hideWhenWritesOff: named("load_and_commit_config", "render_and_apply_j2_template"),
    argGuard: junosArgGuard,
    approvalNotes: (tool) => tool.name === "load_and_commit_config"
      ? ["load_and_commit_config commits right away. No preview and no auto-rollback."]
      : tool.name === "render_and_apply_j2_template"
        ? ["render_and_apply_j2_template commits when apply_config is true. Set dry_run to check first."]
        : [],
    noPreview: named("load_and_commit_config"),
    // Junos commits can take minutes; the server's own timeout is 360 seconds.
    limits: { callMs: 400_000 },
  },
  {
    // Mist's hosted MCP. Matched by host only; the exact URL path is not confirmed.
    id: "mist-hosted",
    label: "Mist",
    matchDefinition: (definition) => { const host = httpHost(definition); return !!host && (host === "mist.com" || host.endsWith(".mist.com")); },
    noPinReason: CANT_PIN_REMOTE,
    advice: "Access not checked. Use a read-only (Observer) org token for this server.",
  },
  {
    // GreenCLI's own server (greencli-mcp, next to the app). It ships no write tools and has no switch to pin.
    // Recognised by the program's file name, from any install folder. Only its access_check can say read-only.
    id: "greencli-mcp",
    label: "GreenCLI",
    matchDefinition: (definition) => /^greencli-mcp(\.exe)?$/.test(stdio(definition)?.command.split(/[\\/]/).pop()?.toLowerCase() ?? ""),
    noPinReason: "it has no read-only setting; GreenCLI ships no write tools",
  },
  {
    // A local Mist API server (Python mist_mcp) with a MIST_READ_ONLY switch: while it is on, the server
    // sends only GET to Mist. Recognised by what it runs or that switch, never by the server's name.
    id: "mist-mcp",
    label: "Mist",
    matchDefinition: (definition) => mentions(definition, /mist[-_]mcp/) || envKeys(definition).includes("MIST_READ_ONLY"),
    pins: { env: { MIST_READ_ONLY: "1" }, appendArgs: [] },
    userKeepsWritesOff: (definition) => truthy(stdio(definition)?.env.MIST_READ_ONLY) ? [`MIST_READ_ONLY=${stdio(definition)!.env.MIST_READ_ONLY}`] : [],
  },
  {
    id: "netbox",
    label: "NetBox",
    matchDefinition: (definition) => mentions(definition, /netbox/) || envKeys(definition).some((key) => key.startsWith("NETBOX_"))
      || (httpHost(definition)?.includes("netbox") ?? false),
    noPinReason: "it has no read-only setting",
    advice: "Use a read-only NetBox API token for this server.",
  },
  {
    // netmiko_mcp can send config to devices. Its allowlist setting is not checked here, so it
    // is never remembered and anything not marked read-only stays hidden while writes are off.
    id: "netmiko-mcp",
    label: "Netmiko",
    matchDefinition: (definition) => mentions(definition, /netmiko/),
    noPinReason: "Casper can't set its allowlist",
    tighten: (tool, safety) => /^send_|config/.test(tool.name) ? strictest(safety, "exec") : safety,
    hideWhenWritesOff: notAnnotatedRead,
    rememberBlock: (definition) => `Not remembered: ${definition.name} can send config to devices, and Casper can't check its allowlist. Connect it each time.`,
  },
  {
    id: "oxidized-librenms",
    label: "Oxidized/LibreNMS",
    matchDefinition: (definition) => mentions(definition, /oxidized|librenms/)
      || envKeys(definition).some((key) => key.startsWith("OXIDIZED_") || key.startsWith("LIBRENMS_"))
      || /oxidized|librenms/.test(httpHost(definition) ?? ""),
    noPinReason: "it has no read-only setting",
    hideWhenWritesOff: notAnnotatedRead,
    advice: "Saved configs can hold passwords and keys. Check what a tool returns before you share it.",
  },
  {
    id: "grafana",
    label: "Grafana",
    matchDefinition: (definition) => mentions(definition, /mcp-grafana|grafana\/mcp-grafana|^mcp\/grafana/),
    pins: { env: {}, appendArgs: ["--disable-write"] },
  },
  {
    id: "clearpass-mcp",
    label: "ClearPass",
    matchDefinition: (definition) => mentions(definition, /clearpass/) || envKeys(definition).some((key) => key.startsWith("CLEARPASS_")),
    pins: { env: { CLEARPASS_READ_ONLY: "true" }, appendArgs: [] },
    userKeepsWritesOff: (definition) => truthy(stdio(definition)?.env.CLEARPASS_READ_ONLY) ? ["CLEARPASS_READ_ONLY=true"] : [],
  },
];
export const PRESETS: readonly Preset[] = Object.freeze(TABLE.map((preset) => Object.freeze(preset)));

export function presetById(id: string | undefined): Preset | undefined {
  return id === undefined ? undefined : PRESETS.find((preset) => preset.id === id);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface PresetMatch {
  preset: Preset;
  /** How it was recognised. A tool-list match on a server Casper can't pin only hides tools. */
  by: "definition" | "tools";
  /** Recognised by definition, but the tool list doesn't carry the preset's signature. */
  mismatch: boolean;
}

function toolsMatch(preset: Preset, tools: readonly MCPTool[]): boolean {
  if (!preset.toolSignature?.length) return false;
  const names = new Set(tools.map((tool) => tool.name));
  return preset.toolSignature.every((name) => names.has(name));
}

/** The preset for a definition, and (after listTools) whether its tool list fits. */
export function matchPreset(definition: MCPServerDefinition, tools?: readonly MCPTool[]): PresetMatch | undefined {
  const byDefinition = PRESETS.find((preset) => preset.matchDefinition(definition));
  if (byDefinition) {
    const mismatch = !!tools && !!byDefinition.toolSignature?.length && !toolsMatch(byDefinition, tools);
    return { preset: byDefinition, by: "definition", mismatch };
  }
  if (!tools) return undefined;
  const byTools = PRESETS.find((preset) => toolsMatch(preset, tools));
  return byTools ? { preset: byTools, by: "tools", mismatch: false } : undefined;
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

export type PinPlan =
  | { kind: "none" }
  | { kind: "pinned"; transport: Extract<MCPServerDefinition["transport"], { type: "stdio" }>; shown: string[] }
  | { kind: "cannot-pin"; reason: string };

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "cmd", "powershell", "pwsh"]);

/**
 * The transport to start while writes are off. Env pins beat the user's own env. For docker and
 * podman they go in as `-e NAME=VALUE` right before the image, after the user's own options, so
 * they are the last word. Args are added once. When Casper can't place a pin where the server
 * will see it, the plan says so instead of claiming a pin.
 */
export function planPins(definition: MCPServerDefinition, preset: Preset): PinPlan {
  const pins = preset.pins;
  const transport = stdio(definition);
  if (!pins || (!Object.keys(pins.env).length && !pins.appendArgs.length)) {
    if (!transport) return { kind: "cannot-pin", reason: CANT_PIN_REMOTE };
    return preset.noPinReason ? { kind: "cannot-pin", reason: preset.noPinReason } : { kind: "none" };
  }
  if (!transport) return { kind: "cannot-pin", reason: CANT_PIN_REMOTE };
  const command = commandName(transport.command);
  const envEntries = Object.entries(pins.env);
  const shown = envEntries.map(([key, value]) => `${key}=${value}`);
  const missingArgs = pins.appendArgs.filter((arg) => !transport.args.includes(arg));
  shown.push(...pins.appendArgs);
  if (isContainerCommand(definition)) {
    const run = containerRun(definition);
    if (!run) return { kind: "cannot-pin", reason: "Casper can't tell which part of the docker command is the image" };
    const args = [
      ...transport.args.slice(0, run.imageIndex),
      ...envEntries.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      ...transport.args.slice(run.imageIndex),
      ...missingArgs,
    ];
    return { kind: "pinned", transport: { ...transport, args, env: { ...transport.env } }, shown };
  }
  if (missingArgs.length && (SHELLS.has(command) || transport.args.includes("--"))) {
    return { kind: "cannot-pin", reason: "Casper can't tell where its settings go in this command" };
  }
  return {
    kind: "pinned",
    transport: { ...transport, args: [...transport.args, ...missingArgs], env: { ...transport.env, ...pins.env } },
    shown,
  };
}

// ---------------------------------------------------------------------------
// Labels, hiding, arguments (all restriction-only)
// ---------------------------------------------------------------------------

/** The preset's label for a tool, never below the label Casper already gave it. */
export function tightenSafety(match: PresetMatch | undefined, tool: MCPTool, base: CapabilitySafety): CapabilitySafety {
  const tightened = match?.preset.tighten?.(tool, base);
  return tightened && tightened in SAFETY_RANK ? strictest(base, tightened) : base;
}

export interface HideContext { writes: "off" | "on"; access: "read-only" | "read-write" | "unknown" }
/**
 * Whether a tool is left out of search, listings and the task tools. A read-only login hides
 * everything that is not read or diagnostic. With writes off, write and destructive tools and the
 * preset's own list are hidden; other tools stay visible and keep asking.
 */
export function isHidden(match: PresetMatch | undefined, tool: MCPTool, safety: CapabilitySafety, context: HideContext): boolean {
  if (context.access === "read-only" && safetyRank(safety) > SAFETY_RANK.diagnostic) return true;
  if (context.writes === "on") return false;
  if (safety === "write" || safety === "destructive") return true;
  return match?.preset.hideWhenWritesOff?.(tool) === true;
}

/**
 * The preset's word on these arguments. "allow" only comes back from the Junos show parser with
 * the user's opt-in and only for tools that would otherwise ask; everything else is "ask" or a
 * refusal.
 */
export function guardArguments(
  match: PresetMatch | undefined, tool: MCPTool, args: Record<string, unknown>, context: ArgGuardContext,
): ArgGuardResult {
  const guard = match?.preset.argGuard;
  if (!guard) return "ask";
  const result = guard(tool, args, context);
  if (result === "allow" && !context.showOptIn) return "ask";
  return result === "allow" || result === "ask" || (typeof result === "object" && typeof result.refuse === "string") ? result : "ask";
}

export function approvalNotes(match: PresetMatch | undefined, tool: MCPTool): string[] {
  return match?.preset.approvalNotes?.(tool) ?? [];
}
export function hasNoPreview(match: PresetMatch | undefined, tool: MCPTool): boolean {
  return match?.preset.noPreview?.(tool) === true;
}

/**
 * Why a server can't be remembered, or undefined when it can. Every unpinned package runner is
 * refused, not only the ones with a preset.
 */
export function rememberBlock(definition: MCPServerDefinition, match?: PresetMatch): string | undefined {
  const own = match?.preset.rememberBlock?.(definition);
  if (own) return own;
  const runner = runnerPin(definition);
  if (runner && !runner.pinned) return notPinnedText(definition.name, runner.example);
  return undefined;
}

// ---------------------------------------------------------------------------
// Text for /mcp and the writes box
// ---------------------------------------------------------------------------

/**
 * The preset part of a /mcp line. Pins are "sent, not confirmed" until the server itself reports
 * its write gates as off (access_check `server_gate`), because a different program with the same
 * setting names could ignore them.
 */
export function presetLine(match: PresetMatch, plan: PinPlan, pinsConfirmed = false): string[] {
  const id = match.preset.id;
  const lines: string[] = [];
  if (plan.kind === "pinned") {
    lines.push(pinsConfirmed
      ? `preset: ${id} (read-only pinned: ${plan.shown.join(", ")})`
      : `preset: ${id} (read-only pins sent, not confirmed: ${plan.shown.join(", ")})`);
  } else lines.push(`preset: ${id}`);
  if (plan.kind === "cannot-pin") {
    lines.push(plan.reason === CANT_PIN_REMOTE
      ? "Can't pin read-only for this server (it runs elsewhere). Every change asks you in Casper."
      : `Can't pin read-only for this server (${plan.reason}). Every change asks you in Casper.`);
  }
  if (match.mismatch) lines.push(`Looks different from the ${id} preset. Pins kept, and its extra checks still apply.`);
  if (match.preset.advice) lines.push(match.preset.advice);
  return lines;
}

/** Product name for the writes box: "Central writes are off." */
export function writesTitle(serverName: string, match?: PresetMatch): string {
  return `${match?.preset.label ?? serverName} writes are off.`;
}

/** Shown when writes are turned on but the user's own definition still keeps them off. */
export function ownSettingsNote(definition: MCPServerDefinition, match?: PresetMatch): string | undefined {
  const kept = match?.preset.userKeepsWritesOff?.(definition) ?? [];
  if (!kept.length) return undefined;
  return `Casper removed its read-only pins, but your own settings still keep writes off (${kept.join(", ")} in ${displaySource(definition.source)}).`;
}
function displaySource(source: string): string {
  const home = process.env.HOME;
  return home && source.startsWith(`${home}${path.sep}`) ? `~${source.slice(home.length)}` : source;
}
