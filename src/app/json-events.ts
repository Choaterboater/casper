import type { RuntimeEvent, RuntimeStatus } from "../runtime/types";
import type { SmokeReport } from "../services/smoke";
import type { PageReport } from "../services/page-report";
import { formatTerminalJSON } from "../tui/json";
import { redactPreview } from "../tui/format";
import type { VerificationReport, VerificationResult } from "../verify/evidence";
import type { ChangeProof } from "../verify/proof";
import type { RequirementsReview } from "../task/review";
import { checksPassed, formatReceipt, receiptVerdict, taskOutcome, type SecuritySummary, type TaskOutcome, type TaskResult, type TaskUsage } from "../task/result";

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
  /** Present only when the check did not finish as a test run: "timeout" or "no_start". */
  ended?: "timeout" | "no_start";
  /** Named checks only: "report" (a diff, never a pass or a fail) or "lab" (the user's own lab devices). */
  kind?: "report" | "lab";
  /** A few plain words shown beside the result, e.g. "dry run not guaranteed". */
  label?: string;
  /** Lab checks only: the devices the check was pointed at. */
  hosts?: string[];
  /** Reports only: the one-line summary. */
  summary?: string;
}

/** The additive fields a named check adds to a check event or a receipt check. */
export function namedCheckFields(result: Pick<VerificationResult, "kind" | "label" | "hosts" | "summary">): Pick<CheckEvent, "kind" | "label" | "hosts" | "summary"> {
  return { ...(result.kind ? { kind: result.kind } : {}), ...(result.label ? { label: redactPreview(result.label) } : {}),
    ...(result.hosts ? { hosts: [...result.hosts] } : {}), ...(result.summary ? { summary: redactPreview(result.summary) } : {}) };
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
  checks: Array<{ name: string; command: string | null; status: VerificationResult["status"]; exit: number | null; ms: number; fresh: boolean }
    & Pick<CheckEvent, "kind" | "label" | "hosts" | "summary">>;
  repairAttempts: number;
  turnLimit: number | null;
  /** This task's model use; null when no model task ran (a local command). */
  usage: TaskUsage | null;
  /** Whether the tests fail without the change and pass with it; null when Casper did not compare. */
  proof: ChangeProof | null;
  /** Why checks that passed on changed files did not come with a proof; null otherwise. */
  proofSkipped: string | null;
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
  /** Casper's last page check against the dev server (console text redacted); null when none ran. */
  pages: PageReport | null;
  /** Whether the checks passed on the final files, apart from what the outcome also asks for. */
  checksPassed: boolean;
  /** The model each repair used, in order; null when the host did not say. */
  repairModels: string[] | null;
  /** The last repair ran on the user's big model; null otherwise. */
  bigModel: NonNullable<TaskResult["bigModel"]> | null;
  /** Casper's security tools, counts only; null when they did not run in this task. */
  security: SecuritySummary | null;
  /** This task's saved receipt number; null when receipts are not kept. */
  task: number | null;
  /** Whether /undo can put this task's files back; null when undo is not known for this run. */
  undo: { available: boolean; reason: string | null } | null;
  /** The plain receipt a person would read. */
  /** Line 1 of the receipt: what the run proved, in one line. */
  verdict: string;
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
    ms: Math.round(result.durationMs), recordedBy, reused: result.reused === true, ...(result.ended ? { ended: result.ended } : {}), ...namedCheckFields(result) };
}

/**
 * What leaves Casper about a task (JSON events, saved receipts) and how each part is made safe:
 * - check output (stdout, stderr) and rounds: never included;
 * - smoke bodies, reasons and crash logs; proof output; review items; acceptance output; page console text,
 *   overlays, server errors and log tails; named check labels and summaries: redactPreview;
 * - security: counts and tool states only, never finding text.
 */

/** Service responses and logs may echo env or tokens: like other previews, they are redacted before script output. */
export function redactSmoke(smoke: SmokeReport): SmokeReport {
  const copy = structuredClone(smoke);
  for (const check of copy.checks) {
    if (check.actual) check.actual.body = redactPreview(check.actual.body);
    if (check.reason) check.reason = redactPreview(check.reason);
  }
  for (const crash of copy.crashes ?? []) if (crash.tail) crash.tail = redactPreview(crash.tail);
  if (copy.reason) copy.reason = redactPreview(copy.reason);
  return copy;
}

/** Proof output is the failing test run's tail and may echo env or tokens; redact a copy, never the evidence. */
export function redactProof(proof: ChangeProof): ChangeProof {
  const copy = structuredClone(proof);
  if (copy.status === "unavailable") copy.reason = redactPreview(copy.reason);
  else {
    if (copy.without.reason) copy.without.reason = redactPreview(copy.without.reason);
    if (copy.without.output) copy.without.output = redactPreview(copy.without.output);
  }
  return copy;
}

/** Review items quote the model's answer, which may quote code or config with secrets in it. */
export function redactReview(review: RequirementsReview): RequirementsReview {
  const copy = structuredClone(review);
  for (const key of ["done", "fixed", "open"] as const) {
    const items = (copy as Record<string, unknown>)[key];
    if (Array.isArray(items)) (copy as Record<string, unknown>)[key] = items.map((item) => redactPreview(String(item)));
  }
  return copy;
}

/** Page console text and server logs may echo env or tokens; redact a copy, never the evidence. */
export function redactPages(pages: PageReport): PageReport {
  const copy = structuredClone(pages);
  for (const page of copy.pages) {
    page.consoleErrors = page.consoleErrors.map(redactPreview);
    if (page.overlay) page.overlay = redactPreview(page.overlay);
    if (page.serverError) page.serverError = redactPreview(page.serverError);
    if (page.reason) page.reason = redactPreview(page.reason);
    page.failedRequests = page.failedRequests.map((request) => ({ ...request, url: redactPreview(request.url), ...(request.error ? { error: redactPreview(request.error) } : {}) }));
  }
  if (copy.reason) copy.reason = redactPreview(copy.reason);
  if (copy.logTail) copy.logTail = redactPreview(copy.logTail);
  copy.server = { ...copy.server, command: redactPreview(copy.server.command) };
  return copy;
}

/** A task result that is safe to keep on disk (a saved receipt): the rules above, applied to a copy. */
export function storedTaskResult(task: TaskResult): TaskResult {
  const copy = structuredClone(task);
  if (copy.verification) {
    const strip = (result: VerificationResult): VerificationResult => ({ ...result, stdout: "", stderr: "",
      ...(result.reason ? { reason: redactPreview(result.reason) } : {}), ...(result.command ? { command: redactPreview(result.command) } : {}),
      ...(result.label ? { label: redactPreview(result.label) } : {}), ...(result.summary ? { summary: redactPreview(result.summary) } : {}) });
    copy.verification = { ...copy.verification, results: copy.verification.results.map(strip), rounds: [],
      ...(copy.verification.reason ? { reason: redactPreview(copy.verification.reason) } : {}),
      ...(copy.verification.smoke ? { smoke: redactSmoke(copy.verification.smoke) } : {}),
      ...(copy.verification.pages ? { pages: redactPages(copy.verification.pages) } : {}) };
  }
  if (copy.observedChecks) copy.observedChecks = copy.observedChecks.map((check) => ({ ...check, command: redactPreview(check.command), output: "" }));
  if (copy.proof) copy.proof = redactProof(copy.proof);
  if (copy.review) copy.review = redactReview(copy.review);
  if (copy.acceptance) copy.acceptance = { ...copy.acceptance, ...(copy.acceptance.output !== undefined ? { output: redactPreview(copy.acceptance.output) } : {}),
    ...(copy.acceptance.unconfirmed ? { unconfirmed: copy.acceptance.unconfirmed.map(redactPreview) } : {}) };
  if (copy.checklist) copy.checklist = copy.checklist.map(redactPreview);
  if (copy.proofSkipped) copy.proofSkipped = redactPreview(copy.proofSkipped);
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
      exit: result.exitCode, ms: Math.round(result.durationMs), fresh: result.status === "pass" && result.freshness !== "stale", ...namedCheckFields(result) })),
    repairAttempts: verification?.repairAttempts ?? 0,
    turnLimit: task?.turnLimit ?? null,
    usage: task?.usage ? { ...task.usage } : null,
    proof: task?.proof ? redactProof(task.proof) : null,
    proofSkipped: task?.proofSkipped ?? null,
    review: task?.review ? redactReview(task.review) : null,
    acceptance: task?.acceptance ? { ...task.acceptance, ...(task.acceptance.output !== undefined ? { output: redactPreview(task.acceptance.output) } : {}),
      ...(task.acceptance.unconfirmed ? { unconfirmed: task.acceptance.unconfirmed.map(redactPreview) } : {}) } : null,
    checklist: task?.checklist ? task.checklist.map(redactPreview) : null,
    services: (task?.services ?? []).map((service) => ({ name: service.name, origin: service.origin ?? null, state: service.state })),
    smoke: verification?.smoke ? redactSmoke(verification.smoke) : null,
    pages: verification?.pages ? redactPages(verification.pages) : null,
    checksPassed: checksPassed(report, task),
    repairModels: verification?.repairModels ? [...verification.repairModels] : null,
    bigModel: task?.bigModel ? { ...task.bigModel } : null,
    security: task?.security ? structuredClone(task.security) : null,
    task: task?.receipt ?? null,
    undo: task?.undo ? { available: task.undo.available, reason: task.undo.available ? null : redactPreview(task.undo.reason) } : null,
    // The text quotes review items, acceptance gaps and bash commands the model ran: redact it too.
    verdict: receipt ? redactPreview(receiptVerdict(receipt, { surface: "one-shot" }) ?? "") : "",
    text: receipt ? redactPreview(formatReceipt(receipt, { surface: "one-shot" })) : "",
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
