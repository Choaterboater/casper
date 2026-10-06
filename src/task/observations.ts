import type { ProjectCommand, ProjectModel } from "../project/model";
import { boundObservationText, type ToolObservationInput } from "../runtime/observation";
import type { RuntimeEvent } from "../runtime/types";
import { CHECK_NAMES } from "../verify/evidence";
import { rememberableTestCommand } from "../flows/runners";
import type { ObservedCheck, TaskResult } from "./result";
import { remoteChanges } from "./remote-changes";
import { leavesLocalFilesAlone } from "../flows/plan";

type TaskObservationSnapshot = Required<Pick<TaskResult, "observedEdits" | "observedChecks" | "possibleMutations" | "usage">> & Pick<TaskResult, "changedPaths" | "changedDuringChecks" | "testRunner" | "remoteChanges" | "remoteNotRun" | "secretInCommand">;

/** One retained tool call, newest last. Output is already bounded by the runtime adapter. */
export interface RetainedToolOutput {
  toolName: string;
  target?: string;
  /** The whole shell command (its secrets already hidden), shown by /output. */
  command?: string;
  status: "success" | "error";
  text: string;
  truncated: boolean;
}

/** Retained per task for `/output`; older calls are dropped. */
export const TOOL_OUTPUT_LIMIT = 20;
/** Calls listed per task by `/output all` (name, identity fields and status only). */
export const TOOL_CALL_LIMIT = 1000;

/** One tool call as `/output all` lists it. */
/** `input`: the call's identity fields, formatted like its transcript line when shown. */
export interface ToolCallLine { toolName: string; input?: ToolObservationInput; status: "success" | "error" }

/** Canonical spelling of a shell command for matching a configured check. Only aliases that
 * run the very same package script collapse: `npm|pnpm|yarn test` is `<pm> run test` and
 * `npm run-script X` is `npm run X`. `bun test` stays distinct (Bun's own runner, not the
 * script), as do any extra arguments, which may select a subset of the check. Blanks collapse
 * only without quotes, escapes or newlines, where they are pure word separators. */
function scriptInvocation(command: string): string {
  const trimmed = command.trim();
  if (/['"\\\r\n]/.test(trimmed)) return trimmed;
  const words = trimmed.split(/[ \t]+/);
  if (words.length === 2 && words[1] === "test" && ["npm", "pnpm", "yarn"].includes(words[0]!)) return `${words[0]} run test`;
  if (words.length === 3 && words[0] === "npm" && words[1] === "run-script") return `npm run ${words[2]}`;
  return words.join(" ");
}

/** Passive, command-scoped diagnostics. Never verifier evidence or tool authority.
 * The app owns edit invalidation independently of these bounded receipt fields. */
export class TaskObservations {
  private readonly edits = new Set<string>();
  private readonly checks = new Map<ProjectCommand, ObservedCheck>();
  private readonly outputs: RetainedToolOutput[] = [];
  private readonly calls: ToolCallLine[] = [];
  private mutationToolRan = false;
  /** The last known test-runner command the model ran without error while the project had no test command. */
  private testRunner?: string;
  private turns = 0;
  private tokens: number | null = 0;
  private estimatedCost: number | null = 0;
  /** What the reported calls add up to so far, kept even when a call went unreported (footer and spend limits). */
  private known = { tokens: 0, cost: 0 };
  /** Delegate calls started, and child usage reports received. Counted apart, not matched in
   * order: the tool reports when it returns, which may reach us before or after its tool_start. */
  private delegations = 0;
  private delegationReports = 0;
  /** Changes on other machines seen in the AI's commands (ssh, scp), per host as the command names it. */
  private readonly remote = new Map<string, { host: string; changes: string[] }>();
  /** Commands to other machines Casper stopped before they ran, by address. */
  private readonly remoteStopped = new Map<string, { host: string; commands: number }>();
  /** A secret appeared in a command the AI sent (hidden on screen; the AI has it). */
  private secretInCommand = false;

  /** Counts the main conversation's model responses and totals their reported usage. A delegated
   * subagent's model calls are added by `recordDelegatedUsage`; until every delegate call has
   * reported, the totals are unknown rather than an undercount. Turns stay the parent's own. */
  observeUsage(event: RuntimeEvent): void {
    if (event.type === "tool_start" && event.toolName === "delegate") this.delegations++;
    if (event.type !== "assistant_response_end") return;
    this.turns++;
    if (!event.usage) { this.recordUntrackedModelUse(); return; }
    this.addKnown(event.usage);
    if (this.tokens !== null) this.tokens += event.usage.tokens;
    if (this.estimatedCost !== null) this.estimatedCost += event.usage.estimatedCost;
  }

  /** One delegate call's child usage (zero when no child ran); null when the child's is unknown. */
  recordDelegatedUsage(usage: { tokens: number; estimatedCost: number } | null): void {
    this.delegationReports++;
    if (!usage) { this.recordUntrackedModelUse(); return; }
    this.addKnown(usage);
    if (this.tokens !== null) this.tokens += usage.tokens;
    if (this.estimatedCost !== null) this.estimatedCost += usage.estimatedCost;
  }

  /** A Casper-made model call outside the conversation (the acceptance check); null when unreported. */
  recordModelCall(usage: { tokens: number; estimatedCost: number } | null): void {
    if (!usage) { this.recordUntrackedModelUse(); return; }
    this.addKnown(usage);
    if (this.tokens !== null) this.tokens += usage.tokens;
    if (this.estimatedCost !== null) this.estimatedCost += usage.estimatedCost;
  }

  private addKnown(usage: { tokens: number; estimatedCost: number }): void {
    if (Number.isFinite(usage.tokens) && usage.tokens > 0) this.known.tokens += usage.tokens;
    if (Number.isFinite(usage.estimatedCost) && usage.estimatedCost > 0) this.known.cost += usage.estimatedCost;
  }

  /** Tokens and estimated cost the task's reported model calls add up to so far: at least this much. */
  spent(): { tokens: number; cost: number } { return { ...this.known }; }

  /** The task made model calls these totals do not include. */
  recordUntrackedModelUse(): void {
    this.tokens = null;
    this.estimatedCost = null;
  }

  recordEdit(path: string): void {
    if (this.edits.size < 32) this.edits.add(path.slice(0, 512));
  }

  observeToolEnd(event: Extract<RuntimeEvent, { type: "tool_end" }>, commands: ProjectModel["commands"] | undefined): void {
    if (this.outputs.length === TOOL_OUTPUT_LIMIT) this.outputs.shift();
    const input = event.input;
    const target = input?.path ?? input?.command ?? input?.operation ?? input?.pattern ?? input?.check ?? input?.url ?? input?.query;
    this.outputs.push({ toolName: event.toolName, ...(target === undefined ? {} : { target }),
      ...(typeof input?.command === "string" && input.path === undefined ? { command: input.command } : {}), status: event.isError ? "error" : "success",
      text: event.output?.text ?? "", truncated: Boolean(event.output?.truncated) });
    if (this.calls.length < TOOL_CALL_LIMIT) {
      const kept = input ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 512) : value])) as ToolObservationInput : undefined;
      this.calls.push({ toolName: event.toolName.slice(0, 80), ...(kept && Object.keys(kept).length ? { input: kept } : {}), status: event.isError ? "error" : "success" });
    }
    // Failures can follow partial writes; shell success need not mean any write. Only the
    // workspace snapshot can settle either, so this merely flags that the question is open.
    // A look command (ls, cat, grep, find) or ssh to another machine leaves this folder's files alone.
    const looked = event.toolName === "bash" && typeof event.input?.command === "string" && leavesLocalFilesAlone(event.input.command);
    if ((["bash", "powershell", "edit", "write"].includes(event.toolName) && !looked) || (event.toolName === "lsp" && event.input?.operation === "rename")) this.mutationToolRan = true;
    if (event.input?.secretHidden) this.secretInCommand = true;
    // A command Casper or the sandbox refused did not reach the other machine.
    const refused = event.isError && /^(?:Not run:|\[shell\] Not run)|\[sandbox\] /.test(event.output?.text ?? "");
    if ((event.toolName === "bash" || event.toolName === "powershell") && event.input?.command && refused && this.remoteStopped.size < 16) {
      for (const { host, address } of remoteChanges(event.input.command)) {
        const entry = this.remoteStopped.get(address) ?? { host, commands: 0 };
        if (host.length > entry.host.length) entry.host = host;
        entry.commands++;
        this.remoteStopped.set(address, entry);
      }
    }
    if ((event.toolName === "bash" || event.toolName === "powershell") && event.input?.command && !refused && this.remote.size < 16) {
      for (const { host, address, changes } of remoteChanges(event.input.command)) {
        // One machine by its address: "build-server" and "198.51.100.20" are one line, named "198.51.100.20 (build-server)".
        const entry = this.remote.get(address) ?? { host, changes: [] };
        if (host.length > entry.host.length) entry.host = host;
        for (const change of changes) if (!entry.changes.includes(change) && entry.changes.length < 12) entry.changes.push(change);
        this.remote.set(address, entry);
      }
    }
    if (event.toolName !== "bash") return;
    const command = event.input?.command;
    if (!command || Buffer.byteLength(command) > 8192) return;
    const invoked = scriptInvocation(command);
    const name = CHECK_NAMES.find((candidate) => commands?.[candidate] !== undefined && scriptInvocation(commands[candidate]!) === invoked);
    // No test command yet: a known test runner that finished without error may be offered to remember.
    // Only the exact known shapes count (src/flows/runners.ts); it is a suggestion, never check evidence.
    if (!name && !commands?.test && !event.isError) {
      const runner = rememberableTestCommand(command);
      if (runner) this.testRunner = runner;
    }
    if (!name) return;
    const output = boundObservationText(event.output?.text ?? "");
    this.checks.set(name, { name, command, toolStatus: event.isError ? "error" : "success",
      output: output.text, truncated: output.truncated || Boolean(event.output?.truncated) });
  }

  /** The n-th most recent retained tool call (1 = latest), or undefined when out of range. */
  toolOutput(recency: number): RetainedToolOutput | undefined {
    const entry = recency >= 1 ? this.outputs[this.outputs.length - recency] : undefined;
    return entry ? { ...entry } : undefined;
  }

  get retainedOutputs(): number {
    return this.outputs.length;
  }

  /** Every tool call of the task, oldest first (the first TOOL_CALL_LIMIT). */
  get toolCalls(): ToolCallLine[] { return this.calls.map(call => ({ ...call, ...(call.input ? { input: { ...call.input } } : {}) })); }

  /** An approved MCP change ran: like a shell command, it may have changed files Casper did not see. */
  recordChangeCall(): void { this.mutationToolRan = true; }

  /** Files the task's own tools wrote, as the tools named them. */
  edited(): string[] { return [...this.edits]; }

  /** `changedPaths` undefined means the workspace snapshot failed or was skipped; only then can
   * a mutation-capable tool call leave writes unconfirmed. */
  snapshot(changedPaths: string[] | undefined, changedDuringChecks: string[] = []): TaskObservationSnapshot {
    return { observedEdits: [...this.edits], observedChecks: [...this.checks.values()].map((check) => ({ ...check })),
      ...(changedPaths ? { changedPaths: [...changedPaths] } : {}),
      ...(changedDuringChecks.length ? { changedDuringChecks: [...changedDuringChecks] } : {}),
      ...(this.testRunner ? { testRunner: this.testRunner } : {}),
      ...(this.remote.size ? { remoteChanges: [...this.remote.values()].map(({ host, changes }) => ({ host, changes: [...changes] })) } : {}),
      ...(this.remoteStopped.size ? { remoteNotRun: [...this.remoteStopped.values()].map((entry) => ({ ...entry })) } : {}),
      ...(this.secretInCommand ? { secretInCommand: true as const } : {}),
      possibleMutations: (this.mutationToolRan || this.edits.size > 0) && !changedPaths,
      usage: { turns: this.turns, ...(this.delegationReports < this.delegations ? { tokens: null, estimatedCost: null }
        : { tokens: this.tokens, estimatedCost: this.estimatedCost }) } };
  }
}
