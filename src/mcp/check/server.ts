/**
 * The server part of `casper mcp check`: start it once, list its tools, and grade startup, stdout,
 * labels, schemas, the router contract and the access check. With --live the connection stays open
 * for the live step, which makes the only tool calls the check ever makes.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { redactPreview } from "../../tui/format";
import type { MCPServerDefinition } from "../config";
import { accessCheckTool, ACCESS_TOOL } from "../access";
import { toolLabel } from "../../capabilities/labels";
import { MCP_LIMITS, type MCPTool } from "../manager";
import { matchPreset, type PresetMatch } from "../presets";
import type { CheckContext, CheckStep, Finding } from "./index";
import { startLine, type StartDefinition } from "./examples";
import { checkLabels, routerContract } from "./labels";
import { liveSmoke } from "./live";
import { isLoopbackUrl, probeServer, type ProbeConnection, type ProbeTool } from "./probe";
import { MISSING_PACKAGES } from "./repo";
import { checkSchemas } from "./schemas";

/** Casper's own per-server tool limit (manager.ts listTools). */
export const CASPER_MAX_TOOLS = 5000;
const MAX_TEST_FILES = 500;
const MAX_SOURCE_FILES = 3000;
const MAX_FILE = 1024 * 1024;
const SOURCE = /\.(py|ts|js|mjs|cjs|go|rs|java|kt|rb)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "env", "dist", "build", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", "site-packages"]);

export interface ServerStepOptions {
  /** How long starting may take; defaults to the preset's or Casper's connect limit. */
  connectMs?: number;
  /** For tests: the fetch used for HTTP servers. */
  fetch?: typeof fetch;
}

function asDefinition(start: StartDefinition): MCPServerDefinition {
  const transport = start.type === "stdio"
    ? { type: "stdio" as const, command: start.command, args: start.args, env: start.env }
    : { type: "http" as const, url: start.url, headers: start.headers };
  return { name: start.name, source: start.source, cwd: start.cwd, disabled: false, transport };
}

function asTools(tools: readonly ProbeTool[]): MCPTool[] {
  return tools.map((tool) => ({ name: tool.name, annotations: tool.annotations, _meta: tool._meta,
    inputSchema: { ...(typeof tool.inputSchema === "object" && tool.inputSchema !== null ? tool.inputSchema as Record<string, unknown> : {}), type: "object" } }));
}

async function readSmall(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_FILE) return "";
    return await readFile(file, "utf8");
  } catch { return ""; }
}

async function testTexts(root: string, files: readonly string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const file of files.slice(0, MAX_TEST_FILES)) texts.set(file, await readSmall(path.join(root, file)));
  return texts;
}

/** Whether the repo's source asks the user anything through MCP elicitation. Bounded; files only. */
export async function repoUsesElicitation(root: string): Promise<boolean> {
  let seen = 0;
  const walk = async (folder: string, depth: number): Promise<boolean> => {
    if (depth > 8 || seen >= MAX_SOURCE_FILES) return false;
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (seen >= MAX_SOURCE_FILES) return false;
      const child = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".") && await walk(child, depth + 1)) return true;
      } else if (entry.isFile() && SOURCE.test(entry.name)) {
        seen++;
        if (/elicit/i.test(await readSmall(child))) return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}

function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/**
 * The default server step and live step. They share one connection: the server step starts the
 * server, and with --live keeps it open for the live step; the check's close() stops it.
 */
export function serverSteps(options: ServerStepOptions = {}): { serverChecks: CheckStep; live: CheckStep } {
  let connection: ProbeConnection | undefined;
  let tools: ProbeTool[] = [];
  let preset: PresetMatch | undefined;
  let started = false;

  const serverChecks: CheckStep = async (context: CheckContext) => {
    const start = context.start;
    if (!start) return [];
    const definition = asDefinition(start);
    preset = matchPreset(definition);
    const live = context.cmd.live;
    if (start.type === "http" && !live && !isLoopbackUrl(start.url)) {
      return [{ section: "server", status: "fail", label: "remote", text: "Remote server: needs --live (offline only contacts localhost)." }];
    }
    const connectMs = options.connectMs ?? preset?.preset.limits?.connectMs ?? MCP_LIMITS.connectMs;
    context.write(`Starting ${start.name}: ${redactPreview(startLine(start))} (from ${start.source})\n`);
    const probe = await probeServer(start, { connectMs, env: context.env, overrides: context.cmd.env, live, keepOpen: live, signal: context.signal, ...(options.fetch ? { fetch: options.fetch } : {}) });
    if (probe.connection) {
      connection = probe.connection;
      context.onClose(() => connection?.close());
    }
    const findings: Finding[] = [];
    const noise = probe.stdoutNoise.length
      ? [{ section: "server" as const, status: "fail" as const, label: "stdout", text: `Server wrote plain text to stdout: "${probe.stdoutNoise[0]}" In stdio mode stdout is only for MCP messages. Print to stderr.` }]
      : [];
    if (!probe.started) {
      const tail = probe.stderrTail;
      let setup = "";
      if (MISSING_PACKAGES.test(tail.join("\n"))) {
        const uv = await lstat(path.join(context.root, "uv.lock")).then(() => true, () => false);
        setup = ` Not set up: it needs packages that are not installed. ${uv ? "Run `uv sync` in the repo" : "Install the repo's packages"}, then check again.`;
      }
      findings.push({ section: "server", status: "fail", label: "starts",
        text: `${probe.error ?? "Did not start."}${setup}${tail.length ? " Last lines it printed (secrets hidden):" : ""}`, ...(tail.length ? { detail: tail } : {}) });
      return [...findings, ...noise];
    }
    started = true;
    tools = probe.tools;
    preset = matchPreset(definition, asTools(tools)) ?? preset;
    findings.push({ section: "server", status: "ok", label: "starts", text: `in ${seconds(probe.ms)}, ${tools.length} tool${tools.length === 1 ? "" : "s"}` });
    findings.push(...noise);
    if (!tools.length) {
      findings.push({ section: "server", status: "warn", label: "tools", text: "The server lists no tools." });
      return findings;
    }
    const callMs = preset?.preset.limits?.callMs ?? MCP_LIMITS.callMs;
    const needsElicit = tools.some((tool) => tool.annotations?.readOnlyHint !== true
      && typeof tool.inputSchema === "object" && tool.inputSchema !== null
      && Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).some((field) => /^(confirm|confirmed|force)$/i.test(field)));
    const elicits = needsElicit ? await repoUsesElicitation(context.root) : undefined;
    findings.push(...checkLabels(tools, { callMs, ...(elicits === undefined ? {} : { elicits }) }));
    findings.push(...checkSchemas(tools));
    if (tools.some((tool) => tool.name === "find_tool") && tools.some((tool) => tool.name === "invoke_read_tool")) {
      findings.push(...routerContract(tools, await testTexts(context.root, context.repo.testFiles), preset));
    }
    if (tools.length > CASPER_MAX_TOOLS) {
      findings.push({ section: "server", status: "warn", label: "size", text: `${tools.length.toLocaleString("en-US")} tools. Casper loads at most ${CASPER_MAX_TOOLS.toLocaleString("en-US")} per server; keep the router on for Casper.` });
    }
    if (!tools.some((tool) => tool.name === ACCESS_TOOL)) {
      findings.push({ section: "server", status: "note", label: "access", text: "No access_check tool. Casper can't show what this credential may do." });
    } else if (!accessCheckTool(asTools(tools), toolLabel)) {
      findings.push({ section: "server", status: "warn", label: "access", text: "access_check must be labeled read-only and need no fields, or Casper won't call it." });
    }
    return findings;
  };

  const live: CheckStep = async (context: CheckContext) => {
    if (!connection) {
      return [{ section: "live", status: "skip", label: "live", text: started ? "The connection was lost, so nothing was called." : "The server did not start, so nothing was called." }];
    }
    return liveSmoke(connection, tools, { signal: context.signal, ...(preset?.preset.limits?.callMs ? { callMs: preset.preset.limits.callMs } : {}) });
  };

  return { serverChecks, live };
}
