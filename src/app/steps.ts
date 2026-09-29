import type { PhaseEvent } from "./json-events";

/** Plain words for the footer: the model's turn is "building". */
const LABELS: Record<PhaseEvent["phase"], string> = {
  checklist: "checklist", task: "building", checks: "checks", smoke: "smoke", review: "review",
  proof: "proof", acceptance: "acceptance", repair: "repair",
};

/** The stages of the current task for the footer: each once, in the order first seen, marked ✓ once
 * it has ended (a stage that starts again, such as checks after a repair, is active again). Nested
 * stages (smoke inside checks) are counted, so an inner end never marks the outer one done. */
export class StepRail {
  private readonly steps: Array<{ phase: PhaseEvent["phase"]; active: number; skipped?: boolean }> = [];

  update(phase: PhaseEvent["phase"], state: PhaseEvent["state"]): void {
    let step = this.steps.find((entry) => entry.phase === phase);
    if (!step) { step = { phase, active: 0 }; this.steps.push(step); }
    step.active = Math.max(0, step.active + (state === "start" ? 1 : -1));
  }

  /** A stage that ended without doing its job (no checklist was made): marked "skipped", never ✓. */
  skip(phase: PhaseEvent["phase"]): void {
    const step = this.steps.find((entry) => entry.phase === phase);
    if (step) step.skipped = true;
  }

  clear(): void { this.steps.length = 0; }

  text(): string | undefined {
    return this.steps.length ? this.steps.map((step) => `${LABELS[step.phase]}${step.active ? "" : step.skipped ? " skipped" : " ✓"}`).join(" · ") : undefined;
  }
}
