import type { RuntimeTool } from "../runtime/types";
import type { ParsedPlan } from "./plan";
import { lineText } from "../tui/format";

export interface PlanStepReport { title: string; status: "pending" | "active" | "done" | "not-done"; reason?: string }
/** Progress is the model's report, not verification evidence. Unreported steps never become done. */
export class PlanBuild {
  readonly steps: PlanStepReport[];
  private closed = false;
  constructor(plan: ParsedPlan, private readonly show: (line?: string) => void) {
    this.steps = (plan.steps.length ? plan.steps : plan.firstVersion?.filter(Boolean) ?? []).map(title => ({ title: title.replace(/^\s*[-*•]\s*/, ""), status: "pending" }));
    if (this.steps.length) { this.steps[0]!.status = "active"; this.progress(0); }
  }
  private progress(index: number): void { this.show(`Step ${index + 1} of ${this.steps.length} · ${this.steps[index]!.title}`); }
  finish(execution: string): PlanStepReport[] {
    this.closed = true;
    this.show(undefined);
    return this.steps.map(step => step.status === "done" || step.status === "not-done" ? { ...step } : {
      ...step, status: "not-done", reason: execution === "completed" ? "not reported done by the model" : `build ${execution}`,
    });
  }
  tool(): RuntimeTool {
    return {
      name: "plan_step", description: "Update the accepted plan's checklist. Report active before a step, done after it, or not-done with a reason. This is a model report, not test evidence.",
      sequential: true,
      inputSchema: { type: "object", additionalProperties: false, required: ["step", "status"], properties: {
        step: { type: "integer", minimum: 1, maximum: this.steps.length || 1 }, status: { type: "string", enum: ["active", "done", "not-done"] }, reason: { type: "string" },
      } },
      execute: async args => {
        const index = Number(args.step) - 1;
        const status = args.status;
        if (this.closed || !Number.isInteger(index) || !this.steps[index] || !["active", "done", "not-done"].includes(String(status))) return { text: "No active plan step with that number/status.", isError: true };
        if (status === "not-done" && (typeof args.reason !== "string" || !args.reason.trim())) return { text: "Give the reason this step was not done.", isError: true };
        this.steps[index] = { title: this.steps[index]!.title, status: status as PlanStepReport["status"], ...(typeof args.reason === "string" ? { reason: lineText(args.reason) } : {}) };
        if (status === "active") this.progress(index);
        else {
          const next = this.steps.findIndex(step => step.status === "pending" || step.status === "active");
          if (next >= 0) this.progress(next); else this.show("Plan checklist reported · checking the result");
        }
        return { text: JSON.stringify(this.steps) };
      },
    };
  }
}
export function planReceipt(steps: readonly PlanStepReport[] | undefined): string[] {
  if (!steps?.length) return [];
  return ["Plan checklist (model report, not verification):", ...steps.map((step, index) => `${step.status === "done" ? "✓" : "–"} ${index + 1}. ${lineText(step.title)}${step.status === "done" ? " — done" : ` — not done: ${lineText(step.reason ?? "not reported done by the model")}`}`)];
}
