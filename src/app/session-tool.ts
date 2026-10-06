/** casper_session: the AI reads Casper's own state (model, effort, usage, context, the last task, background work, MCP
 * servers), the things /status, /usage, /context, /receipt, /tasks and /mcp show the person. Read-only: no network,
 * no model call, no secrets, no hosts, and no paths outside the project. */

import path from "node:path";
import type { RuntimeStatus, RuntimeTool, RuntimeUsage } from "../runtime/types";
import type { TaskResult } from "../task/result";
import { formatShortReceipt } from "../task/result";
import type { MCPStatus } from "../mcp/manager";
import type { BackgroundTask } from "./background";
import { hideCommandSecrets } from "../secrets/files";
import { redactPreview } from "../tui/format";

export const SESSION_TOOL = "casper_session";
export const SESSION_PARTS = ["model", "usage", "context", "lastTask", "tasks", "mcp"] as const;
export type SessionPart = (typeof SESSION_PARTS)[number];
const ROLES = ["fast", "build", "reason", "review"] as const;

export interface SessionToolSource {
  status(): RuntimeStatus | undefined;
  roles(): Record<string, string>;
  usage(): RuntimeUsage | undefined;
  lastTask(): TaskResult | undefined;
  tasks(): BackgroundTask[];
  mcp(): MCPStatus[];
  /** What side questions (`? …`) cost this session, outside the conversation. */
  sideQuestions?(): { requests: number; tokens: number; estimatedCost: number } | undefined;
}

/** Text the person or the AI wrote, with the secret rules run first, on one line. */
function clean(text: string, max = 200): string {
  return redactPreview(hideCommandSecrets(text).text).replace(/\s+/g, " ").trim().slice(0, max);
}

/** A changed path as the receipt has it, only when it is inside the project (relative, no "..", no drive). */
function insideProject(file: string): boolean {
  if (!file || path.isAbsolute(file) || path.win32.isAbsolute(file) || /^[a-z]:/i.test(file)) return false;
  return !file.split(/[\\/]/).includes("..");
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function safely<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}

function modelPart(source: SessionToolSource): Record<string, unknown> | null {
  const status = safely(() => source.status());
  if (!status?.model) return null;
  const roles = safely(() => source.roles()) ?? {};
  return {
    provider: status.provider ?? null, id: status.model, effort: status.thinkingLevel ?? null,
    configuredEffort: status.configuredEffort ?? null, availableEfforts: status.availableThinkingLevels ?? [],
    savedDefault: status.defaultModel ? `${status.defaultModel.provider}/${status.defaultModel.id}` : null,
    roles: Object.fromEntries(ROLES.map((role) => [role, roles[role] ? clean(roles[role]!, 120) : null])),
  };
}

function usagePart(source: SessionToolSource): Record<string, unknown> | null {
  const usage = safely(() => source.usage());
  if (!usage) return null;
  const { input, output, cacheRead, cacheWrite } = usage.tokens;
  const read = input + cacheRead + cacheWrite;
  const side = safely(() => source.sideQuestions?.());
  return {
    input, output, cacheRead, cacheWrite, cacheHitRate: read ? round(cacheRead / read, 2) : null,
    estimatedCost: usage.estimatedCost ?? null, costNote: "estimate, not a bill",
    classifierCost: usage.effortClassification ? usage.effortClassification.estimatedCost ?? null : null,
    ...(side?.requests ? { sideQuestionCost: side.estimatedCost } : {}),
  };
}

function contextPart(source: SessionToolSource): Record<string, unknown> | null {
  const usage = safely(() => source.usage());
  if (!usage) return null;
  const context = usage.context;
  return { tokens: context?.tokens ?? null, window: context?.contextWindow ?? null,
    percent: context?.percent == null ? null : round(context.percent, 1), messages: usage.messages };
}

function lastTaskPart(source: SessionToolSource): Record<string, unknown> | null {
  const task = safely(() => source.lastTask());
  if (!task) return null;
  const checks: Record<string, string> = {};
  for (const result of task.verification?.results ?? []) checks[result.name] = result.status === "skip" ? "skipped" : result.status;
  const receipt = safely(() => formatShortReceipt(task)) ?? "";
  const line = receipt.split("\n").map((part) => Bun.stripANSI(part).trim()).find(Boolean);
  return {
    number: task.receipt ?? null, execution: task.execution,
    changedPaths: (task.changedPaths ?? []).filter(insideProject).slice(0, 50).map((file) => clean(file, 300)),
    checks, receiptLine: line ? clean(line) : null,
  };
}

function tasksPart(source: SessionToolSource): Array<Record<string, unknown>> {
  // /tasks lists only live work; the status line can hold a dev server's address, so only the kind, name and state.
  return (safely(() => source.tasks()) ?? []).map((task, index) => ({ n: index + 1, kind: task.kind, label: clean(task.name, 120),
    running: !/^(?:paused|stopped)/.test(task.status) }));
}

function mcpPart(source: SessionToolSource): Array<Record<string, unknown>> {
  return (safely(() => source.mcp()) ?? []).map((server) => ({ name: clean(server.name, 80), connected: server.state === "ready", writes: server.writes }));
}

/** The whole snapshot, or one part of it. */
export function sessionSnapshot(source: SessionToolSource, part?: SessionPart): Record<string, unknown> {
  const parts: Record<SessionPart, () => unknown> = {
    model: () => modelPart(source), usage: () => usagePart(source), context: () => contextPart(source),
    lastTask: () => lastTaskPart(source), tasks: () => tasksPart(source), mcp: () => mcpPart(source),
  };
  if (part) return { [part]: parts[part]() };
  return Object.fromEntries(SESSION_PARTS.map((name) => [name, parts[name]()]));
}

export function casperSessionTool(source: SessionToolSource): RuntimeTool {
  return {
    name: SESSION_TOOL,
    // Offered every task, so every request pays for this text: keep it short (tests/fixed-tokens.test.ts).
    description: "Casper's state now: model, effort, roles, usage and cost, context, last task, background tasks, MCP servers. Read-only, free.",
    inputSchema: { type: "object", properties: { part: { type: "string", enum: [...SESSION_PARTS] } } },
    async execute(args) {
      const part = args.part;
      if (part !== undefined && !SESSION_PARTS.some((name) => name === part)) {
        return { text: `Unknown part. Use one of: ${SESSION_PARTS.join(", ")}.`, isError: true };
      }
      return { text: JSON.stringify(sessionSnapshot(source, part as SessionPart | undefined), null, 1) };
    },
  };
}
