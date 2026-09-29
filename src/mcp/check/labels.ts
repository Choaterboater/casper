/**
 * Label checks for `casper mcp check`: does each tool carry readOnlyHint/destructiveHint, and does the
 * label fit the tool's name? The word lists live in src/capabilities/labels.ts (wordLabel is the honest
 * reading of a name, so glp_write_status reads a status); this file has none of its own.
 *
 * These are findings for the server's author. Nothing here changes how Casper labels or approves a
 * call, and nothing here claims a tool is read-only: a "looks read-only" hint only says what to add.
 */
import { toolLabel, wordLabel, type CapabilitySafety } from "../../capabilities/labels";
import type { MCPTool } from "../manager";
import type { PresetMatch } from "../presets";
import type { Finding } from "./index";

/** The fields a checked tool needs. Tools come straight from the server, so everything is optional. */
export type CheckTool = Pick<MCPTool, "name" | "description" | "annotations" | "_meta"> & { inputSchema?: unknown };

const GROUP_OVER = 5;
/** Fields that make or confirm a change. A read-only tool should not need them. */
export const CHANGE_FIELD = /^(confirm|confirmed|force|dry_?run|commit|apply|apply_config|config_text|validate_only|check_only)$/i;
/** Fields that choose between a preview and the real change. */
const PREVIEW_FIELD = /^(dry_?run|preview|validate_only|check_only)$/i;
const APPLY_FIELD = /^(apply|apply_config|commit)$/i;
const CONFIRM_FIELD = /^(confirm|confirmed|force)$/i;
const TIMEOUT_FIELD = /^timeout(_?(s|sec|secs|seconds|ms))?$/i;
/** A description that tells the AI to confirm by itself: "retry with confirm=true", "call again with confirmed: true". */
const SELF_CONFIRM = /\b(re-?try|retry|call (it )?again|re-?run|re-?send|repeat|resubmit)\b[^.\n]{0,80}\b(confirm(ed)?|force)\b\s*[=:]\s*["']?true\b|\b(confirm(ed)?|force)\b\s*[=:]\s*["']?true\b["']?[^.\n]{0,40}\b(to (re-?try|proceed|continue|execute|run it)|and (re-?try|call again|run again))\b/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function properties(tool: CheckTool): Record<string, unknown> {
  const schema = tool.inputSchema;
  return record(schema) && record(schema.properties) ? schema.properties : {};
}

function required(tool: CheckTool): string[] {
  const schema = tool.inputSchema;
  return record(schema) && Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
}

/** Whether the server labeled the tool at all: readOnlyHint or destructiveHint set to true or false. */
export function hasLabel(tool: CheckTool): boolean {
  return typeof tool.annotations?.readOnlyHint === "boolean" || typeof tool.annotations?.destructiveHint === "boolean";
}

/** What the server's own label says, in one word, for the report. */
export function serverLabelWord(tool: CheckTool): string {
  const hints = tool.annotations;
  if (hints?.readOnlyHint === true && hints.destructiveHint === true) return "read-only and destructive";
  if (hints?.readOnlyHint === true) return "read";
  if (hints?.destructiveHint === true) return "destructive";
  if (hints?.destructiveHint === false) return "write";
  // MCP's default for a tool that is not read-only is destructive.
  return hints?.readOnlyHint === false ? "destructive" : "no label";
}

/** Casper's own label for a tool, from the shared label rules (never looser than 0.2.14). */
export function casperLabel(tool: CheckTool): CapabilitySafety {
  return toolLabel({ name: tool.name, annotations: tool.annotations, _meta: tool._meta });
}

/** The name check: what the words in the name say (read, write, exec or destructive). */
export function plausibleLabel(tool: Pick<CheckTool, "name">): CapabilitySafety {
  return wordLabel(tool.name);
}

function hint(tool: CheckTool): Finding | undefined {
  const words = plausibleLabel(tool);
  const casper = casperLabel(tool);
  const text = words === "read"
    ? `${tool.name} looks read-only: add readOnlyHint: true.`
    : words === "exec"
      ? `${tool.name} runs any CLI command: mark destructiveHint: true.`
      : words === "destructive"
        ? `${tool.name} can delete or cut service: mark destructiveHint: true.`
        : `${tool.name} changes things: add readOnlyHint: false and destructiveHint (true if it can delete or cut service).`;
  return { section: "server", status: "note", label: "label", text: `${text} (Casper's label now: ${casper === "external-action" ? "unknown" : casper}.)` };
}

function numberDefault(schema: unknown): number | undefined {
  return record(schema) && typeof schema.default === "number" && Number.isFinite(schema.default) ? schema.default : undefined;
}

/**
 * Label findings: missing labels (grouped when more than 5), contradictions, a read-only label on a
 * name that changes things, a write label on a name that can cut service, change fields on read-only
 * tools, preview switches without a default, long default timeouts, and descriptions or confirm fields
 * that let the AI confirm by itself.
 */
export function checkLabels(tools: readonly CheckTool[], options: { callMs: number; elicits?: boolean } = { callMs: 90_000 }): Finding[] {
  const findings: Finding[] = [];
  const unlabeled = tools.filter((tool) => !hasLabel(tool));
  if (unlabeled.length > GROUP_OVER) {
    findings.push({ section: "server", status: "fail", label: "labels", text: `${unlabeled.length} of ${tools.length} tools have no label. Casper will ask before every call. Add readOnlyHint or destructiveHint.` });
  } else {
    for (const tool of unlabeled) findings.push({ section: "server", status: "fail", label: "label", text: `${tool.name} has no label. Casper will ask before every call. Add readOnlyHint or destructiveHint.` });
  }
  for (const tool of tools) {
    const hints = tool.annotations;
    const words = plausibleLabel(tool);
    const fields = Object.keys(properties(tool));
    if (!hasLabel(tool)) {
      const note = hint(tool);
      if (note) findings.push(note);
    } else if (hints?.readOnlyHint === true && hints.destructiveHint === true) {
      findings.push({ section: "server", status: "fail", label: "label", text: `${tool.name} says both read-only and destructive.` });
    } else if (hints?.readOnlyHint === true && words !== "read") {
      findings.push({ section: "server", status: "fail", label: "label", text: words === "exec"
        ? `${tool.name} is labeled read-only, but the name says it runs commands.`
        : `${tool.name} is labeled read-only, but the name says it changes things.` });
    } else if (hints?.readOnlyHint !== true && hints?.destructiveHint === false && (words === "destructive" || words === "exec")) {
      findings.push({ section: "server", status: "fail", label: "label", text: words === "exec"
        ? `${tool.name} is labeled write, but the name says it runs any command. Mark it destructiveHint: true.`
        : `${tool.name} is labeled write, but the name says it can cut service. Mark it destructiveHint: true.` });
    }
    if (hints?.readOnlyHint === true) {
      const change = fields.find((field) => CHANGE_FIELD.test(field));
      if (change) findings.push({ section: "server", status: "warn", label: "label", text: `${tool.name} is labeled read-only but has a "${change}" field.` });
    }
    for (const field of fields) {
      const schema = properties(tool)[field];
      if ((PREVIEW_FIELD.test(field) || APPLY_FIELD.test(field)) && !(record(schema) && "default" in schema)) {
        findings.push({ section: "server", status: "note", label: "dry_run", text: PREVIEW_FIELD.test(field)
          ? `${tool.name}: ${field} has no default in the schema. Make preview the default.`
          : `${tool.name}: ${field} has no default in the schema. Make false (no change) the default.` });
      }
      const seconds = TIMEOUT_FIELD.test(field) ? numberDefault(schema) : undefined;
      if (seconds !== undefined) {
        const ms = /ms$/i.test(field) ? seconds : seconds * 1000;
        if (ms > options.callMs) {
          findings.push({ section: "server", status: "note", label: "timeout", text: `${tool.name}: default timeout ${/ms$/i.test(field) ? `${seconds} ms` : `${seconds} s`} is longer than Casper's ${Math.round(options.callMs / 1000)} s call limit.` });
        }
      }
    }
    const described = [tool.description, ...fields.map((field) => { const schema = properties(tool)[field]; return record(schema) && typeof schema.description === "string" ? schema.description : ""; })].join("\n");
    if (SELF_CONFIRM.test(described)) {
      findings.push({ section: "server", status: "fail", label: "confirm", text: `${tool.name} tells the AI to call again with confirm=true. Only the user may confirm: ask the user through MCP elicitation instead.` });
    }
    const confirm = fields.find((field) => CONFIRM_FIELD.test(field));
    if (confirm && hints?.readOnlyHint !== true && words !== "read" && options.elicits === false) {
      findings.push({ section: "server", status: "warn", label: "confirm", text: `${tool.name} takes a "${confirm}" field, but the server never asks the user (no elicitation in the repo). The AI can set it by itself; Casper still asks you, other clients may not.` });
    }
  }
  return findings;
}

/** A way to start the server with every backend tool listed, per preset. */
const ALL_TOOLS_HINT: Record<string, string> = {
  "hpe-networking-mcp": "--env HPE_MCP_ROUTER_MODE=direct --env HPE_MCP_TOOLSETS=all",
};

function isReadDispatcher(name: string): boolean {
  return /^invoke_read_/.test(name);
}

const REFUSAL_WORDS = /refus|block|not read.?only|raises|PermissionError/i;

/**
 * The router contract (find_tool + invoke_read_tool): the finder and the read dispatcher are
 * read-only, invoke_read_tool takes a text `name`, and every dispatcher that can reach write tools
 * (invoke_tool, invoke_tools_batch, any other non-read *_batch) is labeled destructive. It looks for a
 * test that shows invoke_read_tool refuses write tools. The refusal is never probed live: that would
 * mean calling a dispatcher with a write tool's name.
 */
export function routerContract(tools: readonly CheckTool[], testFiles: ReadonlyMap<string, string>, preset?: PresetMatch): Finding[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (!byName.has("find_tool") || !byName.has("invoke_read_tool")) return [];
  const findings: Finding[] = [];
  let broken = false;
  for (const name of ["find_tool", "invoke_read_tool"]) {
    const tool = byName.get(name)!;
    if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) {
      broken = true;
      findings.push({ section: "server", status: "fail", label: "router", text: `${name} should be labeled read-only (readOnlyHint: true).` });
    }
  }
  const nameField = properties(byName.get("invoke_read_tool")!).name;
  if (!(record(nameField) && nameField.type === "string")) {
    broken = true;
    findings.push({ section: "server", status: "fail", label: "router", text: "invoke_read_tool has no text \"name\" field for the tool to run." });
  }
  const dispatchers = tools.filter((tool) => tool.name === "invoke_tool" || (/_batch$/.test(tool.name) && /^invoke_/.test(tool.name) && !isReadDispatcher(tool.name)));
  for (const tool of dispatchers) {
    if (tool.annotations?.destructiveHint !== true || tool.annotations?.readOnlyHint === true) {
      broken = true;
      findings.push({ section: "server", status: "fail", label: "router", text: `${tool.name} can reach write tools but is not labeled destructive.` });
    }
  }
  if (!broken) {
    const shown = ["find_tool", "invoke_read_tool", ...dispatchers.map((tool) => tool.name)].map((name) => `${name} ${serverLabelWord(byName.get(name)!)}`);
    findings.push({ section: "server", status: "ok", label: "router", text: shown.join(" · ") });
  }
  const tested = [...testFiles].find(([, text]) => text.includes("invoke_read_tool") && REFUSAL_WORDS.test(text));
  findings.push(tested
    ? { section: "server", status: "ok", label: "router", text: `Refusal is tested: ${tested[0]}` }
    : { section: "server", status: "warn", label: "router", text: "No test shows invoke_read_tool refuses write tools." });
  if (tools.length < 20) {
    const all = preset ? ALL_TOOLS_HINT[preset.preset.id] : undefined;
    findings.push({ section: "server", status: "note", label: "router", text: all
      ? `Only the router's ${tools.length} tools are visible. To check every backend tool: ${all}`
      : `Only the router's ${tools.length} tools are visible. Start it in its direct mode to check every backend tool.` });
  }
  return findings;
}
