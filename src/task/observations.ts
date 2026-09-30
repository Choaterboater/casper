import type { ProjectCommand, ProjectModel } from "../project/model";
import { boundObservationText } from "../runtime/observation";
import type { RuntimeEvent } from "../runtime/types";
import { CHECK_NAMES } from "../verify/evidence";
import { rememberableTestCommand } from "../flows/runners";
import type { ObservedCheck, TaskResult } from "./result";

type TaskObservationSnapshot = Required<Pick<TaskResult, "observedEdits" | "observedChecks" | "possibleMutations" | "usage">> & Pick<TaskResult, "changedPaths" | "changedDuringChecks" | "testRunner">;

/** One retained tool call, newest last. Output is already bounded by the runtime adapter. */
export interface RetainedToolOutput {
  toolName: string;
  target?: string;
  status: "success" | "error";
  text: string;
  truncated: boolean;
}

/** Retained per task for `/output`; older calls are dropped. */
export const TOOL_OUTPUT_LIMIT = 20;

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
  private mutationToolRan = false;
  /** The last known test-runner command the model ran without error while the project had no test command. */
  private testRunner?: string;
  private turns = 0;
  private tokens: number | null = 0;
  private estimatedCost: number | null = 0;
  /** Delegate calls started, and child usage reports received. Counted apart, not matched in
   * order: the tool reports when it returns, which may reach us before or after its tool_start. */
  private delegations = 0;
  private delegationReports = 0;

  /** Counts the main conversation's model responses and totals their reported usage. A delegated
   * subagent's model calls are added by `recordDelegatedUsage`; until every delegate call has
   * reported, the totals are unknown rather than an undercount. Turns stay the parent's own. */
  observeUsage(event: RuntimeEvent): void {
    if (event.type === "tool_start" && event.toolName === "delegate") this.delegations++;
    if (event.type !== "assistant_response_end") return;
    this.turns++;
    if (!event.usage) { this.recordUntrackedModelUse(); return; }
    if (this.tokens !== null) this.tokens += event.usage.tokens;
    if (this.estimatedCost !== null) this.estimatedCost += event.usage.estimatedCost;
  }

  /** One delegate call's child usage (zero when no child ran); null when the child's is unknown. */
  recordDelegatedUsage(usage: { tokens: number; estimatedCost: number } | null): void {
    this.delegationReports++;
    if (!usage) { this.recordUntrackedModelUse(); return; }
    if (this.tokens !== null) this.tokens += usage.tokens;
    if (this.estimatedCost !== null) this.estimatedCost += usage.estimatedCost;
  }

  /** A Casper-made model call outside the conversation (the acceptance check); null when unreported. */
  recordModelCall(usage: { tokens: number; estimatedCost: number } | null): void {
    if (!usage) { this.recordUntrackedModelUse(); return; }
    if (this.tokens !== null) this.tokens += usage.tokens;
    if (this.estimatedCost !== null) this.estimatedCost += usage.estimatedCost;
  }

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
    const target = event.input?.path ?? event.input?.command ?? event.input?.operation;
    this.outputs.push({ toolName: event.toolName, ...(target === undefined ? {} : { target }), status: event.isError ? "error" : "success",
      text: event.output?.text ?? "", truncated: Boolean(event.output?.truncated) });
    // Failures can follow partial writes; shell success need not mean any write. Only the
    // workspace snapshot can settle either, so this merely flags that the question is open.
    if (["bash", "edit", "write"].includes(event.toolName) || (event.toolName === "lsp" && event.input?.operation === "rename")) this.mutationToolRan = true;
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

  /** `changedPaths` undefined means the workspace snapshot failed or was skipped; only then can
   * a mutation-capable tool call leave writes unconfirmed. */
  snapshot(changedPaths: string[] | undefined, changedDuringChecks: string[] = []): TaskObservationSnapshot {
    return { observedEdits: [...this.edits], observedChecks: [...this.checks.values()].map((check) => ({ ...check })),
      ...(changedPaths ? { changedPaths: [...changedPaths] } : {}),
      ...(changedDuringChecks.length ? { changedDuringChecks: [...changedDuringChecks] } : {}),
      ...(this.testRunner ? { testRunner: this.testRunner } : {}),
      possibleMutations: this.mutationToolRan && !changedPaths,
      usage: { turns: this.turns, ...(this.delegationReports < this.delegations ? { tokens: null, estimatedCost: null }
        : { tokens: this.tokens, estimatedCost: this.estimatedCost }) } };
  }
}
