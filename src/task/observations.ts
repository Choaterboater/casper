import type { ProjectCommand, ProjectModel } from "../project/model";
import { boundObservationText } from "../runtime/observation";
import type { RuntimeEvent } from "../runtime/types";
import { CHECK_NAMES } from "../verify/evidence";
import type { ObservedCheck, TaskResult } from "./result";

type TaskObservationSnapshot = Required<Pick<TaskResult, "observedEdits" | "observedChecks" | "possibleMutations">>;

/** Passive, command-scoped diagnostics. Never verifier evidence or tool authority.
 * The app owns edit invalidation independently of these bounded receipt fields. */
export class TaskObservations {
  private readonly edits = new Set<string>();
  private readonly checks = new Map<ProjectCommand, ObservedCheck>();
  private possibleMutations = false;

  recordEdit(path: string): void {
    if (this.edits.size < 32) this.edits.add(path.slice(0, 512));
  }

  observeToolEnd(event: Extract<RuntimeEvent, { type: "tool_end" }>, commands: ProjectModel["commands"] | undefined): void {
    // Failures can follow partial writes; shell success need not mean any write.
    if (["bash", "edit", "write"].includes(event.toolName) || (event.toolName === "lsp" && event.input?.operation === "rename")) this.possibleMutations = true;
    if (event.toolName !== "bash") return;
    const command = event.input?.command;
    if (!command || Buffer.byteLength(command) > 8192) return;
    const name = CHECK_NAMES.find((candidate) => commands?.[candidate]?.trim() === command.trim());
    if (!name) return;
    const output = boundObservationText(event.output?.text ?? "");
    this.checks.set(name, { name, command, toolStatus: event.isError ? "error" : "success",
      output: output.text, truncated: output.truncated || Boolean(event.output?.truncated) });
  }

  snapshot(): TaskObservationSnapshot {
    return { observedEdits: [...this.edits], observedChecks: [...this.checks.values()].map((check) => ({ ...check })),
      possibleMutations: this.possibleMutations };
  }
}
