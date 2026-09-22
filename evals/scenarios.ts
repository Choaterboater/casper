import { randomUUID } from "node:crypto";
import type { EvalTask } from "./runner";
import { findEvalTask } from "./tasks";

/** Human-driven protocols: preparation is offline; execution needs separate authorization. */
export const EVAL_SCENARIOS = ["cancel-resume", "delegate-investigation"] as const;

export function prepareScenario(id: string): { task: EvalTask; instructions: string } {
  const base = findEvalTask("repair-order-reservations");
  if (!base) throw new Error("Missing reservation repair fixture");
  if (id === "cancel-resume") {
    const marker = `resume-${randomUUID()}`;
    const task: EvalTask = {
      ...base, id,
      prompt: `${base.prompt}\nConversation-only requirement: include ${marker} in your final answer. Do not write this marker into a workspace file.`,
      acceptance: { ...base.acceptance, answerContains: [marker], noMatch: [{ text: marker, under: "." }] },
      requiredEvidence: ["cancelled-active-work", "clean-exit", "same-conversation-resumed", "workspace-retained", "cancelled-work-stopped"],
    };
    return {
      task,
      instructions: [
        "Keep manifest.json, prompt.txt, evaluator/, observations and results outside candidate/. Use the prepared home consistently; authorize provider/credential setup separately.",
        "Start the actual interactive Casper CLI in candidate/. Submit prompt.txt. Record the exact conversation id and original process id from host/session evidence.",
        "After a real file change while work is still active, capture changed-file hashes and interrupt using the terminal's cancellation control. If work already completed, record the scenario as not exercised, not passed.",
        "Wait for cancellation to settle. Record cancelled-active-work and cancelled-work-stopped evidence, including any observed child/check process exits. A display message alone is insufficient; unresolved cleanup fails the check.",
        "Capture post-cancellation workspace hashes, exit Casper cleanly, and record the exit status. Restart a NEW Casper process against the same candidate and isolated home.",
        "Use /resume to list conversations and /resume <exact-id> to resume the recorded conversation. Record both process ids and the matching conversation id. Compare workspace hashes before any new task prompt.",
        "Ask only: Continue the interrupted task. Do not repeat the original instructions or the conversation-only marker. Complete the change and record the final answer verbatim.",
        "Record planned cancel/exit/restart/resume as required interactions. Any corrective hint, manual code edit or unplanned restart is rescue. Keep the complete ordered interaction log for this attempt.",
        "Provide host observations for every requiredEvidence id in manifest.json with transcript/artifact references. Missing or failed evidence prevents acceptance even when code checks pass.",
        "Grade with tools/eval.ts --grade <prepared-root> --observation <host-json>. This runs no provider. Each grade saves a distinct result; retain failed attempts. Abrupt crash recovery is outside this scenario.",
      ].join("\n\n"),
    };
  }
  if (id === "delegate-investigation") {
    return {
      task: {
        ...base, id,
        prompt: `First use Casper's delegate tool with an explorer to investigate the defect without edits. Use the returned findings to make and verify the repair yourself.\n${base.prompt}`,
        requiredEvidence: ["explorer-completed-before-change", "explorer-read-only", "parent-completed-change"],
      },
      instructions: [
        "Keep the evaluator and observation files outside candidate/. Use the actual Casper CLI with separately authorized provider/model and child-role selections; record both parent and child configuration.",
        "Submit prompt.txt. Observe an actual explorer delegation and successful returned report before the parent's first production edit. Retain call/report evidence; a final-answer claim of delegation does not qualify.",
        "Compare host workspace snapshots around the delegated investigation and retain the child's available tool/activity record to establish explorer-read-only. An unobserved or failed delegation is a failed check.",
        "Observe the parent using the investigation and completing the production change. Record parent-completed-change evidence and independently grade behavior through the protected evaluator.",
        "Record approvals or requested clarification as required interactions. Telling a parent that skipped delegation to try again is rescue; retain the original failed attempt.",
        "Supply each requiredEvidence id from manifest.json with host transcript/artifact references. Report child usage separately when available; unavailable usage remains unavailable, never zero by assumption.",
        "Use tools/eval.ts --grade <prepared-root> --observation <host-json>. No provider is invoked by grading. Keep every saved result.",
      ].join("\n\n"),
    };
  }
  throw new Error(`Unknown evaluation scenario: ${id}`);
}
