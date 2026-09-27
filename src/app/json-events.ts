import type { RuntimeEvent, RuntimeStatus } from "../runtime/types";
import type { SmokeReport } from "../services/smoke";
import { formatTerminalJSON } from "../tui/json";
import { redactPreview } from "../tui/format";
import type { VerificationReport, VerificationResult } from "../verify/evidence";
import type { ChangeProof } from "../verify/proof";
import type { RequirementsReview } from "../task/review";
import { formatReceipt, taskOutcome, type TaskOutcome, type TaskResult, type TaskUsage } from "../task/result";

/** Bump only for a breaking change; new event types and fields are additive within a version. */
export const JSON_EVENTS_VERSION = 1;

export interface CheckEvent {
  type: "check";
  name: string;
  command: string | null;
  status: VerificationResult["status"];
  exit: number | null;
  ms: number;
  /** "casper": Casper ran it (auto mode, /verify, repair). "casper_check": the model asked for it. */
  recordedBy: "casper" | "casper_check";
  /** A fresh earlier pass was reused instead of rerunning the command. */
  reused: boolean;
}

export interface PhaseEvent {
  type: "phase";
  phase: "task" | "checklist" | "checks" | "smoke" | "review" | "proof" | "acceptance" | "repair";
  state: "start" | "end";
  atMs: number;
}

export interface ReceiptEvent {
  type: "receipt";
  outcome: TaskOutcome;
  exitCode: number;
  execution: TaskResult["execution"];
  /** Workspace files the request changed; null when Casper could not compare the workspace. */
  changed: string[] | null;
  changedDuringChecks: string[];
  verificationMode: TaskResult["verificationMode"] | null;
  checks: Array<{ name: string; command: string | null; status: VerificationResult["status"]; exit: number | null; ms: number; fresh: boolean }>;
  repairAttempts: number;
  turnLimit: number | null;
  /** This task's model use; null when no model task ran (a local command). */
  usage: TaskUsage | null;
  /** Whether the tests fail without the change and pass with it; null when Casper did not compare. */
  proof: ChangeProof | null;
  /** The model's requirements checklist after its review round (its own claim); null when none ran. */
  review: RequirementsReview | null;
  /** Tests written from the request alone, run against the change; null when the check did not run. */
  acceptance: NonNullable<TaskResult["acceptance"]> | null;
  /** The cases the request states (verification.checklist), handed to the model; null when none were made. */
  checklist: string[] | null;
  /** The session's managed services at the end of the task (origin null when not starting or ready). */
  services: Array<{ name: string; origin: string | null; state: string }>;
  /** Casper's last smoke run against fresh services; null when none ran. */
  smoke: SmokeReport | null;
  /** The plain receipt a person would read. */
  text: string;
}

export type CasperEvent =
  | { type: "session_start"; casper: string; cwd: string; session: string | null; provider: string | null; model: string | null; effort: string | null }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_start"; tool: string; id: string | null; target: string | null }
  | { type: "tool_end"; tool: string; id: string | null; ok: boolean; ms: number | null }
  | CheckEvent
  | PhaseEvent
  | ReceiptEvent
  | { type: "error"; message: string };

/** One JSON Lines record. JSON escapes C0 controls; DEL/C1 and bidi controls are escaped too. */
export function formatJsonEvent(event: CasperEvent): string {
  return `${formatTerminalJSON({ v: JSON_EVENTS_VERSION, ...event })}\n`;
}

export function sessionStartEvent(input: { casper: string; cwd: string; session?: string; status?: RuntimeStatus }): CasperEvent {
  return { type: "session_start", casper: input.casper, cwd: input.cwd, session: input.session ?? null,
    provider: input.status?.provider ?? null, model: input.status?.model ?? null, effort: input.status?.thinkingLevel ?? null };
}

export function phaseEvent(phase: PhaseEvent["phase"], state: PhaseEvent["state"]): PhaseEvent {
  return { type: "phase", phase, state, atMs: performance.now() };
}

export function checkEvent(result: VerificationResult, recordedBy: CheckEvent["recordedBy"]): CheckEvent {
  return { type: "check", name: result.name, command: result.command ?? null, status: result.status, exit: result.exitCode,
    ms: Math.round(result.durationMs), recordedBy, reused: result.reused === true };
}

/** Service responses and logs may echo env or tokens: like other previews, they are redacted before script output. */
function redactSmoke(smoke: SmokeReport): SmokeReport {
  const copy = structuredClone(smoke);
  for (const check of copy.checks) {
    if (check.actual) check.actual.body = redactPreview(check.actual.body);
    if (check.reason) check.reason = redactPreview(check.reason);
  }
  for (const crash of copy.crashes ?? []) if (crash.tail) crash.tail = redactPreview(crash.tail);
  if (copy.reason) copy.reason = redactPreview(copy.reason);
  return copy;
}

/** Exactly one per one-shot run: what changed, what Casper proved, and the exit code it implies. */
export function receiptEvent(report: VerificationReport | undefined, task: TaskResult | undefined, exitCode: number): ReceiptEvent {
  const verification = task?.verification ?? report;
  const receipt = task ?? (report ? { execution: "completed" as const, verification: report } : undefined);
  return {
    type: "receipt",
    outcome: taskOutcome(report, task),
    exitCode,
    execution: task?.execution ?? "completed",
    changed: task ? task.changedPaths ?? (task.possibleMutations ? null : []) : [],
    changedDuringChecks: task?.changedDuringChecks ?? [],
    verificationMode: task?.verificationMode ?? null,
    checks: (verification?.results ?? []).map((result) => ({ name: result.name, command: result.command ?? null, status: result.status,
      exit: result.exitCode, ms: Math.round(result.durationMs), fresh: result.status === "pass" && result.freshness !== "stale" })),
    repairAttempts: verification?.repairAttempts ?? 0,
    turnLimit: task?.turnLimit ?? null,
    usage: task?.usage ? { ...task.usage } : null,
    proof: task?.proof ? structuredClone(task.proof) : null,
    review: task?.review ? structuredClone(task.review) : null,
    acceptance: task?.acceptance ? { ...task.acceptance, ...(task.acceptance.output !== undefined ? { output: redactPreview(task.acceptance.output) } : {}),
      ...(task.acceptance.unconfirmed ? { unconfirmed: task.acceptance.unconfirmed.map(redactPreview) } : {}) } : null,
    checklist: task?.checklist ? task.checklist.map(redactPreview) : null,
    services: (task?.services ?? []).map((service) => ({ name: service.name, origin: service.origin ?? null, state: service.state })),
    smoke: verification?.smoke ? redactSmoke(verification.smoke) : null,
    text: receipt ? formatReceipt(receipt, { surface: "one-shot" }) : "",
  };
}

/** Runtime events → JSON events. Stateful: an assistant message is the text streamed since its
 * response started, and a tool's duration runs from its start event. */
export class RuntimeEventMapper {
  private text = "";
  private readonly started = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  map(event: RuntimeEvent): CasperEvent[] {
    switch (event.type) {
      case "assistant_response_start": this.text = ""; return [];
      case "assistant_text_delta": this.text += event.delta; return [{ type: "assistant_delta", text: event.delta }];
      case "assistant_response_end": {
        const text = this.text;
        this.text = "";
        const events: CasperEvent[] = text ? [{ type: "assistant_message", text }] : [];
        // A provider failure (quota, retired model, rejected credential) ends the response.
        if (!["stop", "toolUse", "aborted"].includes(event.stopReason) && event.errorMessage) events.push({ type: "error", message: redactPreview(event.errorMessage) });
        return events;
      }
      case "tool_start": {
        if (event.toolCallId) this.started.set(event.toolCallId, this.now());
        const input = event.input;
        const target = input?.pattern ?? input?.path ?? input?.command ?? input?.operation ?? input?.check;
        return [{ type: "tool_start", tool: event.toolName, id: event.toolCallId ?? null, target: target === undefined ? null : redactPreview(target) }];
      }
      case "tool_end": {
        const started = event.toolCallId ? this.started.get(event.toolCallId) : undefined;
        if (event.toolCallId) this.started.delete(event.toolCallId);
        return [{ type: "tool_end", tool: event.toolName, id: event.toolCallId ?? null, ok: !event.isError,
          ms: started === undefined ? null : Math.round(this.now() - started) }];
      }
      case "error": return [{ type: "error", message: redactPreview(event.message) }];
      default: return [];
    }
  }
}
