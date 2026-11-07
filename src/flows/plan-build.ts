import type { RuntimeTool } from "../runtime/types";
import { firstVersionSteps, type ParsedPlan } from "./plan";
import { lineText } from "../tui/format";

const NOT_REPORTED = "not reported done by the model";
export interface PlanStepReport { title: string; status: "pending" | "active" | "done" | "not-done"; reason?: string }
/** Progress is the model's report, not verification evidence. Unreported steps never become done. */
export class PlanBuild {
  readonly steps: PlanStepReport[];
  private closed = false;
  /** `onSteps`: the whole checklist at the start, after each step the model reports and at the finish (an ACP app's
   * plan entries, decision 84). */
  constructor(plan: ParsedPlan, private readonly show: (line?: string) => void, private readonly onSteps?: (steps: readonly PlanStepReport[]) => void) {
    this.steps = (plan.steps.length ? plan.steps : firstVersionSteps(plan.firstVersion)).map(title => ({ title, status: "pending" }));
    if (this.steps.length) { this.steps[0]!.status = "active"; this.progress(0); }
    this.report(this.steps);
  }
  private report(steps: readonly PlanStepReport[]): void { if (steps.length) this.onSteps?.(steps.map(step => ({ ...step }))); }
  private progress(index: number): void { this.show(`Step ${index + 1} of ${this.steps.length} · ${this.steps[index]!.title}`); }
  finish(execution: string): PlanStepReport[] {
    this.closed = true;
    this.show(undefined);
    const finished: PlanStepReport[] = this.steps.map(step => step.status === "done" || step.status === "not-done" ? { ...step } : {
      ...step, status: "not-done", reason: execution === "completed" ? NOT_REPORTED : `build ${execution}`,
    });
    this.report(finished);
    return finished;
  }
  /** The changed row, counts and the next open step: the whole checklist is already in the prompt. */
  private reply(index: number): Record<string, unknown> {
    const next = this.steps.findIndex((step, at) => at !== index && (step.status === "pending" || step.status === "active"));
    return {
      updated: { step: index + 1, ...this.steps[index] },
      done: this.steps.filter(step => step.status === "done").length, of: this.steps.length,
      ...(next >= 0 ? { next: { step: next + 1, title: this.steps[next]!.title } } : {}),
    };
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
        this.report(this.steps);
        return { text: JSON.stringify(this.reply(index)) };
      },
    };
  }
}
/** The plan's one line on the screen after a task: how many steps the model reported done and, when one was not
 * done for a reason it gave ("Waiting for the repository path"), that reason, so a question it stopped on is not
 * buried under every step. /receipt keeps the full checklist (planReceipt). */
export function planSummary(steps: readonly PlanStepReport[] | undefined): string[] {
  if (!steps?.length) return [];
  const done = steps.filter(step => step.status === "done").length;
  if (done === steps.length) return [`✓ Plan: all ${steps.length} steps done (model report)`];
  const why = steps.find(step => step.status !== "done" && step.reason && step.reason !== NOT_REPORTED)?.reason;
  return [`– Plan: ${done} of ${steps.length} steps done (model report)${why ? ` — ${lineText(why)}` : ""}; /receipt lists them`];
}
export function planReceipt(steps: readonly PlanStepReport[] | undefined): string[] {
  if (!steps?.length) return [];
  return ["Plan checklist (model report, not verification):", ...steps.map((step, index) => `${step.status === "done" ? "✓" : "–"} ${index + 1}. ${lineText(step.title)}${step.status === "done" ? " — done" : ` — not done: ${lineText(step.reason ?? NOT_REPORTED)}`}`)];
}
