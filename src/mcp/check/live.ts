/**
 * `casper mcp check --live`: a few safe read calls to the real server.
 *
 * It calls access_check (only when Casper itself would: labeled read-only, Casper's label read, no
 * required fields), then at most 3 tools that pass every one of: the server's readOnlyHint is true,
 * Casper's own label is read, the name check says read, no required fields, no confirm/dry_run/commit
 * field, and `{}` is valid input.
 * Write, destructive, run-command and unlabeled tools are never called, and neither are routers.
 * The report shows a duration and an item count, never what the tool returned.
 */
import { toolLabel, wordLabel } from "../../capabilities/labels";
import { compileInputSchema } from "../../capabilities/validate";
import { accessCheckTool, accessStatusText, ACCESS_TOOL, parseAccessCheck } from "../access";
import { MCP_LIMITS, type MCPTool } from "../manager";
import { redactServerText } from "../server-output";
import { scrubText } from "../../secrets/scrub";
import type { Finding } from "./index";
import { CHANGE_FIELD } from "./labels";
import type { ProbeConnection, ProbeTool } from "./probe";

export const LIVE_MAX_TOOLS = 3;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTool(tool: ProbeTool): MCPTool {
  const schema = record(tool.inputSchema) ? tool.inputSchema : {};
  return { name: tool.name, annotations: tool.annotations, _meta: tool._meta, inputSchema: { ...schema, type: "object" } };
}

/** Whether --live may call this tool with `{}`. Every check must pass; any doubt means no. */
export function safeToCall(tool: ProbeTool): boolean {
  if (tool.name === ACCESS_TOOL) return false;
  if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) return false;
  if (toolLabel(asTool(tool)) !== "read" || wordLabel(tool.name) !== "read") return false;
  if (/^invoke_|^find_tool$|_batch$/.test(tool.name)) return false;
  const schema = tool.inputSchema;
  if (!record(schema) || schema.type !== "object") return false;
  if (Array.isArray(schema.required) && schema.required.length) return false;
  // A confirm, dry_run or commit field means the tool may change something after all.
  if (record(schema.properties) && Object.keys(schema.properties).some((field) => CHANGE_FIELD.test(field))) return false;
  try { return compileInputSchema(schema)({}).valid; } catch { return false; }
}

function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/** How many items came back, without showing any of them. */
function itemCount(result: unknown): string {
  const structured = record(result) ? result.structuredContent : undefined;
  let data: unknown = structured;
  if (data === undefined && record(result) && Array.isArray(result.content)) {
    const text = result.content.find((block): block is { type: "text"; text: string } => record(block) && block.type === "text" && typeof block.text === "string");
    if (text) { try { data = JSON.parse(text.text); } catch { data = undefined; } }
  }
  if (Array.isArray(data)) return `, ${data.length} item${data.length === 1 ? "" : "s"}`;
  if (record(data)) {
    const lists = Object.values(data).filter(Array.isArray);
    if (lists.length === 1) return `, ${lists[0]!.length} item${lists[0]!.length === 1 ? "" : "s"}`;
  }
  return "";
}

/** Server text from a real system: its credentials, token shapes and device-config secrets hidden. */
function shown(text: string, secrets: readonly string[]): string {
  return redactServerText(scrubText(text).text, secrets);
}

function errorText(result: unknown, secrets: readonly string[]): string {
  const content = record(result) && Array.isArray(result.content) ? result.content : [];
  const text = content.map((block) => record(block) && typeof block.text === "string" ? block.text : "").join(" ").trim();
  return shown(text || "the tool reported an error", secrets);
}

async function timed(connection: ProbeConnection, name: string, callMs: number, signal?: AbortSignal): Promise<{ ms: number; result?: unknown; error?: string }> {
  const began = Date.now();
  try {
    const result = await connection.call(name, {}, callMs, signal);
    return { ms: Date.now() - began, result };
  } catch (error) {
    return { ms: Date.now() - began, error: shown(error instanceof Error ? error.message : String(error), connection.secrets) };
  }
}

/** The --live calls. `connection` is the probe's open connection; `tools` is what it listed. */
export async function liveSmoke(connection: ProbeConnection, tools: readonly ProbeTool[], options: { callMs?: number; signal?: AbortSignal } = {}): Promise<Finding[]> {
  const callMs = options.callMs ?? MCP_LIMITS.callMs;
  const findings: Finding[] = [];
  const access = accessCheckTool(tools.map(asTool), toolLabel);
  if (access) {
    const answer = await timed(connection, access.name, callMs, options.signal);
    if (answer.error) findings.push({ section: "live", status: "fail", label: "access_check", text: `failed after ${seconds(answer.ms)}: ${answer.error}` });
    else if (record(answer.result) && answer.result.isError === true) findings.push({ section: "live", status: "fail", label: "access_check", text: `failed after ${seconds(answer.ms)}: ${errorText(answer.result, connection.secrets)}` });
    else findings.push({ section: "live", status: "ok", label: "access_check", text: `${seconds(answer.ms)} · ${accessStatusText(parseAccessCheck(answer.result))}` });
  } else if (tools.some((tool) => tool.name === ACCESS_TOOL)) {
    findings.push({ section: "live", status: "note", label: "access_check", text: "not called: it must be labeled read-only and need no fields." });
  }
  const chosen = tools.filter(safeToCall).slice(0, LIVE_MAX_TOOLS);
  if (!chosen.length) {
    findings.push({ section: "live", status: "none", label: "live", text: tools.some((tool) => tool.annotations?.readOnlyHint === true)
      ? "No tool labeled read-only can be called without fields, so --live calls nothing more."
      : "No tool is labeled read-only, so --live calls nothing." });
    return findings;
  }
  for (const tool of chosen) {
    if (options.signal?.aborted) break;
    const answer = await timed(connection, tool.name, callMs, options.signal);
    if (answer.error) findings.push({ section: "live", status: "fail", label: tool.name, text: `failed after ${seconds(answer.ms)}: ${answer.error}` });
    else if (record(answer.result) && answer.result.isError === true) findings.push({ section: "live", status: "fail", label: tool.name, text: `failed after ${seconds(answer.ms)}: ${errorText(answer.result, connection.secrets)}` });
    else findings.push({ section: "live", status: "ok", label: tool.name, text: `${seconds(answer.ms)}${itemCount(answer.result)}` });
  }
  return findings;
}
