import type { ProjectCommand, ProjectModel } from "../project/model";
import { boundObservationText } from "../runtime/observation";
import type { RuntimeEvent } from "../runtime/types";
import { CHECK_NAMES } from "../verify/evidence";
import type { ObservedCheck, TaskResult } from "./result";

type TaskObservationSnapshot = Required<Pick<TaskResult, "observedEdits" | "observedChecks" | "possibleMutations">> & Pick<TaskResult, "changedPaths" | "changedDuringChecks">;

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

/** Passive, command-scoped diagnostics. Never verifier evidence or tool authority.
 * The app owns edit invalidation independently of these bounded receipt fields. */
export class TaskObservations {
  private readonly edits = new Set<string>();
  private readonly checks = new Map<ProjectCommand, ObservedCheck>();
  private readonly outputs: RetainedToolOutput[] = [];
  private mutationToolRan = false;

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
    const name = CHECK_NAMES.find((candidate) => commands?.[candidate]?.trim() === command.trim());
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
      possibleMutations: this.mutationToolRan && !changedPaths };
  }
}
