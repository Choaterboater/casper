/** Checks after a change and on /verify: the run with its bounded repairs, the questions when a check was already
 * failing, did not finish or touches a lab device, the check lines, and the checks plan the banner and /status show.
 * Moved from src/app.ts. */

import type { CasperApp } from "../app";
import { detectWebService, isDetectedWebService } from "../services/detect";
import { redactPreview, terminalText } from "../tui/format";
import type { ProjectContext } from "../project/context";
import { formatReceipt, liveCheckLine } from "../task/result";
import { type CheckName, formatDuration, formatVerificationReport, formatVerificationResult, type VerificationReport, type VerificationResult } from "../verify/evidence";
import { VerifierRegistry } from "../verify/registry";
import { longerLimit, timedOutAfter, verifyAndRepair, type UnfinishedChoice } from "../verify/repair-loop";
import { ALREADY_FAILING_CHOICES, unfinishedChoices } from "./safe-choices";
import { VerificationTask } from "../verify/task";
import { checkCommands, isBuiltinCheck, labNamedChecks } from "../verify/named";
import { autoDetectedChecks } from "../verify/migrations-check";
import type { NamedCheckRunner, NetworkToolContext } from "../verify/registry";
import { PROJECT_YAML, saveNamedCheck, saveProjectTimeout } from "../project/config-write";
import { askLabFailure, labCheckRunner } from "./lab-checks";
import type { ProjectCommand } from "../project/model";
import { manualChecks, resolveVerificationMode, selectedChecks, type ChecksPlan } from "../verify/mode";
import { measuredCheckTime, recordCheckTimings } from "../verify/timings";
import { checkEvent } from "./json-events";
import { sandboxReceipt } from "./sandbox";
import { exactPick } from "./approvals";
import { phase, clearSteps } from "./footer";
import { prepareCapabilities, pageRun, smokeRun } from "./task-tools";
import { bigModelReceipt, switchToBigModel, restoreModel, askBigModelRetry, bigModelOf } from "./big-model";
import { receiptSurface } from "./task-run";
import { ensureRuntime } from "./runtime-start";
import { reloadProject, writeProjectFile } from "./project-file";

export async function runVerification(app: CasperApp, checks: readonly CheckName[],
  repair: boolean,
  request = `Make the selected verification checks pass: ${checks.join(", ")}.`,
  task?: VerificationTask,
  /** Repairs left for this task; defaults to the project's repair budget. */
  maxAttempts?: number,
): Promise<VerificationReport> {
  const context = app.projectContext!;
  const controller = new AbortController();
  // A standalone verification task (/verify, branch checks) owns its objective; post-task
  // verification passes `task` and continues the parent request's delegation budget.
  if (!task) { app.delegateToolForTask = undefined; app.crewParts = undefined; app.builderSteer = undefined; }
  // Your own /verify (no parent task) may use a saved "Always"; anything the AI asked for shows the box every time.
  const evidence = task ?? new VerificationTask(
    VerifierRegistry.forProject(context.model, context.verification.timeoutMs, app.blockOnCleanupFailure, taskNetworkOptions(app, task ? "ai" : "user")), app.activeWorkspaceRoot(),
    (result) => writeCheckResult(app, result),
  );
  // /verify <lab check> alone: a failure asks before any repair (Stop first); nothing touches the lab again on its own.
  const labOnly = !task && checks.length > 0 && checks.every((name) => context.model.namedChecks?.[name]?.kind === "lab");
  const cancel = () => controller.abort();
  app.commandAbort?.signal.addEventListener("abort", cancel, { once: true });
  if (app.commandAbort?.signal.aborted) cancel();
  app.verificationAbort = controller;
  app.verificationTask = evidence;
  app.repairOnBigModel = undefined;
  app.bigModelGrant = undefined;
  if (!task) app.bigModelUse = undefined;
  app.events.ensureLineBreak();
  phase(app, "checks", "start");
  try {
    app.verificationWork = verifyAndRepair({
      task: evidence,
      checks,
      cwd: app.activeWorkspaceRoot(),
      request,
      constraints: [context.rules.profile, context.rules.project, ...context.model.conventions].filter(Boolean).join("\n"),
      maxAttempts: maxAttempts ?? context.repair.maxAttempts,
      signal: controller.signal,
      repair: repair || labOnly ? async (prompt) => {
        await prepareCapabilities(app, request);
        const session = await ensureRuntime(app);
        // This try runs on the big model: the user chose it at the repair limit, or set repair.bigModelLastTry.
        const big = app.repairOnBigModel;
        app.repairOnBigModel = undefined;
        if (controller.signal.aborted) return;
        const back = big ? await switchToBigModel(app, session, big) : undefined;
        if (big && !back) app.output.write(`[model] Casper could not switch to your big model ${terminalText(big.label)}; this repair runs on the current model.\n`);
        phase(app, "repair", "start");
        try { await session.prompt(prompt, controller.signal, { request, maxTurns: app.maxTurns }); }
        finally {
          phase(app, "repair", "end");
          if (back) await restoreModel(app, session, back);
        }
        if (back && big) {
          app.bigModelUse = { model: big.label, attempts: (app.bigModelUse?.attempts ?? 0) + 1,
            oneOff: Boolean(big.oneOff) && (app.bigModelUse?.oneOff ?? true) };
        }
        if (app.taskRuntimeFailed && !app.taskRuntimeCancelled) throw new Error("Repair model stopped unsuccessfully; changes retained.");
        return back && big ? { model: big.label } : undefined;
      } : undefined,
      onRepair: (attempt, max) => {
        app.repairsTried = attempt;
        // The granted extra try, or the last one with repair.bigModelLastTry on, runs on the big model.
        const granted = app.bigModelGrant;
        app.bigModelGrant = undefined;
        const setting = attempt === max && context.repair.bigModelLastTry === true && app.session ? bigModelOf(app, app.session) : undefined;
        app.repairOnBigModel = granted ?? (setting ? { query: "@reason", label: setting.label } : undefined);
        const on = app.repairOnBigModel;
        app.output.write(`↻ repair ${attempt}/${max}${on ? ` on ${on.oneOff ? "" : "your big model "}${terminalText(on.label)}` : ""}\n`);
      },
      // Out of tries: one numbered offer to try once more on the big model. Only a person answers it; one-shot
      // and --json runs never get it, so they never spend on a bigger model on their own.
      onRepairLimit: repair && app.interactive && app.terminal.canAsk ? (failures, signal) => askBigModelRetry(app, failures, signal) : undefined,
      onLabFailure: (repair || labOnly) && app.interactive
        ? (failures, signal) => askLabFailure({ pick: (question, options, answerSignal) => exactPick(app, question, options, answerSignal) }, failures, signal) : undefined,
      // A check that was already failing before the change is not the change's doing: say so, and ask before paying to fix it.
      beforeRepair: repair && task && task === app.checkTask && app.taskBaseline ? (failures, signal) => repairPreexisting(app, failures, signal) : undefined,
      // Only a person can say whether a check that did not finish is worth a paid repair.
      onUnfinished: app.interactive && app.terminal.rich ? (unfinished, signal) => askUnfinished(app, unfinished, context.verification.timeoutMs, signal) : undefined,
      // The task's smoke checks join its own verification (repairs and review reruns), never a standalone /verify.
      smoke: task && task === app.checkTask && app.smokeTask?.size ? smokeRun(app, app.smokeTask) : undefined,
      // So do its page checks: planned again from every change since the task started, after each repair too.
      pages: task && task === app.checkTask && app.pageTask ? pageRun(app, app.pageTask) : undefined,
    });
    const report = await app.verificationWork;
    await recordCheckTimings(context.stateDirectory, report.rounds.flat());
    // A model task's receipt summarizes its checks; a standalone run gets its own summary.
    if (app.verbose) app.output.write(`${formatVerificationReport(report)}\n`);
    else if (!task) app.output.write(`${formatReceipt({ execution: "completed", verification: report, ...bigModelReceipt(app),
      ...(app.sandbox ? { sandbox: sandboxReceipt(app.sandbox)! } : {}) },
      { surface: receiptSurface(app) })}\n`);
    return report;
  } finally {
    phase(app, "checks", "end");
    if (!task) { await evidence.close(); clearSteps(app); }
    app.commandAbort?.signal.removeEventListener("abort", cancel);
    app.verificationTask = undefined;
    app.verificationAbort = undefined;
    app.verificationWork = undefined;
  }
}

/** One inline result line per check; a failed check also boxes the tail of its output, since that is
 * what a person reads next. Passing checks stay quiet (their output remains in the evidence). */
export function writeCheckResult(app: CasperApp, result: VerificationResult): void {
  app.onEvent?.(checkEvent(result, app.modelCheckCalls > 0 ? "casper_check" : "casper"));
  app.events.ensureLineBreak();
  // Each check Casper runs shows as it finishes; verbose output keeps the per-run evidence line
  // instead. A check the model ran with casper_check already has its tool line.
  if (app.verbose) app.output.write(`${formatVerificationResult(result)}\n`);
  else if (app.modelCheckCalls === 0) app.output.write(`${liveCheckLine(result)}\n`);
  if (result.status !== "fail") return;
  for (const [stream, text] of [["stderr", result.stderr], ["stdout", result.stdout]] as const) {
    if (!text.trim()) continue;
    const lines = text.replace(/\n$/, "").split("\n");
    const shown = lines.length > 40 ? [`… ${lines.length - 40} earlier line(s) omitted; the full output stays in the check evidence`, ...lines.slice(-40)] : lines;
    app.terminal.writePanel(`${result.name}: ${stream}`, redactPreview(shown.join("\n")), { tone: "error" });
  }
}

/**
 * The network tools plus a device (lab) check runner that asks the person in a numbered box first: for /verify and
 * for the AI's casper_check in this session. Only a person's answer starts a device check; a run that can't ask
 * (one-shot, --json, a pipe, auto mode) sends nothing. Helpers (subagents) never get it.
 */
export function taskNetworkOptions(app: CasperApp, origin: "user" | "ai" = "ai"): { network?: NetworkToolContext; runLab?: NamedCheckRunner } {
  const context = app.projectContext!;
  // Where nobody can answer the box (one-shot, --json, a pipe), the AI isn't offered device checks at all.
  if (origin === "ai" && !app.interactive) return networkOptions(app);
  return { ...networkOptions(app), runLab: labCheckRunner({
    // The approval box below decides whether a box can be answered (a cooked TTY with redirected output can't).
    canAsk: () => app.interactive && !app.closing,
    pick: (question, options, signal) => exactPick(app, question, options, signal),
    write: (text) => { if (!app.closing) app.output.write(text); }, stateDirectory: context.stateDirectory, ...(context.lab ? { lab: context.lab } : {}),
    ...(app.networkTools ? { network: app.networkTools } : {}) }, origin) };
}

export function networkOptions(app: CasperApp): { network?: NetworkToolContext } {
  return app.networkTools ? { network: app.networkTools } : {};
}

/** The mode and checks this session uses after a change; the banner, /status and every task share it. */
export async function checksPlan(app: CasperApp, context: ProjectContext): Promise<ChecksPlan> {
  const flag = app.verificationFlag;
  const configured = context.verification.mode;
  const checks = selectedChecks(context.verification.checks, context.model.commands, context.model.namedChecks,
    autoDetectedChecks(context.model).map((check) => check.name));
  const measuredMs = flag || configured || !app.interactive ? undefined : await measuredCheckTime(context.stateDirectory, checks, checkCommands(context.model));
  const mode = resolveVerificationMode({ flag, configured, interactive: app.interactive, measuredMs });
  const manual = manualChecks(checks, context.model.namedChecks);
  const lab = labNamedChecks(context.model.namedChecks);
  const found = Object.keys(context.model.foundChecks ?? {});
  // The dev server is named before it first runs, since it runs the project's own code.
  const web = mode === "auto" && context.pages !== "off" ? await detectWebService(app.activeWorkspaceRoot(), { frameworks: context.model.frameworks,
    packageManager: context.model.packageManager, services: context.services ?? {} }).catch(() => undefined) : undefined;
  return { mode, checks, ...(mode === "offer" && measuredMs !== undefined ? { slow: true } : {}), ...(manual.length ? { manual } : {}),
    ...(lab.length ? { lab } : {}), ...(found.length ? { found } : {}),
    ...(isDetectedWebService(web) ? { pages: redactPreview(terminalText(web.label)).slice(0, 120) } : {}) };
}

/** `/verify add <name>` or a picked suggestion: save a check Casper found in .casper/project.yaml, then use it. */
export async function saveFoundCheck(app: CasperApp, name: string): Promise<void> {
  const context = app.projectContext!;
  const spec = context.model.foundChecks?.[name];
  if (!spec && context.model.namedChecks?.[name]) {
    app.output.write(`[project] ${terminalText(name)} is already saved in ${PROJECT_YAML}; /verify ${terminalText(name)} runs it.\n`);
    return;
  }
  if (!spec) {
    const found = Object.keys(context.model.foundChecks ?? {});
    app.output.write(`[project] ${terminalText(name)} is not a check Casper found here.${found.length ? ` Found: ${found.join(", ")}.` : ""}\n`);
    return;
  }
  try {
    const written = await writeProjectFile(app, context.info.root, () => saveNamedCheck(context.info.root, name, spec));
    app.output.write(`[project] Saved ${terminalText(written.line)} in ${PROJECT_YAML}\n`);
    try { await reloadProject(app); }
    catch (error) { app.output.write(`[project] ${PROJECT_YAML} could not be read again (${terminalText(error instanceof Error ? error.message : String(error))}); restart Casper to use it.\n`); }
  } catch (error) {
    app.output.write(`[project] Not saved: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  }
}

/** The project read again after the model changed a top-level file, when that changed which checks it has;
 * undefined when nothing relevant changed or it can't be read. A task that rewrote .casper/project.yaml keeps the
 * checks and settings it started with: the file is read again when Casper next starts. */
export async function projectAfterSetup(app: CasperApp, context: ProjectContext, changed: string[]): Promise<ProjectContext | undefined> {
  if (!changed.some((file) => !file.includes("/") || file === ".casper/project.yaml")) return undefined;
  let fresh: ProjectContext;
  try { fresh = await app.loadProjectContextFn(context.info); } catch { return undefined; }
  if (fresh.projectFile !== context.projectFile) {
    app.events.ensureLineBreak();
    app.output.write("[project] .casper/project.yaml changed in this task; Casper keeps the checks it started with until it starts again\n");
    return undefined;
  }
  const checks = (c: ProjectContext) => JSON.stringify([c.model.commands, c.model.namedChecks ?? {}, c.verification.checks ?? null]);
  if (checks(fresh) === checks(context)) return undefined;
  app.projectContext = fresh;
  return fresh;
}

/** Before the first repair: run each failing check on the files from before the change. One that failed there
 * too was already broken; the terminal asks whether to pay for a fix (Esc leaves it), scripts go on repairing. */
export async function repairPreexisting(app: CasperApp, failures: VerificationResult[], signal: AbortSignal): Promise<boolean> {
  const held = app.taskBaseline;
  const context = app.projectContext;
  if (!held || !context) return true;
  const names = failures.map((failure) => failure.name).filter((name): name is ProjectCommand => isBuiltinCheck(name) && Boolean(context.model.commands[name]?.trim()));
  if (!names.length) return true;
  app.events.ensureLineBreak();
  app.output.write(`… Casper checking whether ${names.join(", ")} failed before this change too\n`);
  const before: string[] = [];
  for (const name of names) {
    const result = await held.baseline.before({ root: held.root, check: name, command: context.model.commands[name]!.trim(),
      timeoutMs: app.verificationTask?.limit(name) ?? context.verification.timeoutMs, signal });
    if (result === "fail") before.push(name);
  }
  if (!before.length || signal.aborted) return true;
  const which = before.join(", ");
  app.output.write(`• ${which} was already failing before this change (Casper ran it on the files from before)\n`);
  if (!app.interactive || !app.terminal.rich) return true;
  // Leave it comes first, so Enter never starts a repair that uses tokens.
  const answer = await app.terminal.ask(`${which} was already failing before this change. Fix it anyway?`,
    ALREADY_FAILING_CHOICES.map((choice) => ({ ...choice })), false, signal);
  return answer?.[0] === "Fix it anyway";
}

/** "test timed out after 10m. 1 Stop · 2 Retry · 3 Fix it anyway · 4 Allow more time". Stop comes first, so Enter
 * never runs anything or starts a repair; Esc is the same as Stop. */
export async function askUnfinished(app: CasperApp, unfinished: VerificationResult[], timeoutMs: number, signal: AbortSignal): Promise<UnfinishedChoice | undefined> {
  // The limit the run actually had: after "Allow more time" it is the longer one, not the configured one.
  const limit = (result: VerificationResult) => timedOutAfter(result) ?? timeoutMs;
  const what = unfinished.map((result) => result.ended === "timeout"
    ? `${result.name} timed out after ${formatDuration(limit(result))}` : `${result.name} could not start`).join(", ");
  // More time: four times the limit the run just had (at least a minute, at most an hour), as often as it is chosen.
  const had = Math.max(0, ...unfinished.filter((result) => result.ended === "timeout").map(limit));
  const longer = longerLimit(had);
  const options = unfinishedChoices(had, longer);
  app.events.ensureLineBreak();
  const answer = await app.terminal.ask(`${what}. Casper did not try to fix it. What now?`,
    options.map(({ label, description }) => ({ label, description })), false, signal);
  const choice = options.find((option) => option.label === answer?.[0])?.choice;
  if (choice !== "more-time-saved") return choice;
  // Saved for the user, no file to edit: every check in this project gets the longer limit from now on.
  try {
    const written = await writeProjectFile(app, app.activeWorkspaceRoot(), () => saveProjectTimeout(app.activeWorkspaceRoot(), longer));
    app.output.write(`[verify] Saved ${written.line} in ${PROJECT_YAML}: every check here gets ${formatDuration(longer)} from now on.\n`);
    if (app.projectContext) {
      try { await reloadProject(app); } catch { /* the file is read again at the next start */ }
    }
  } catch (error) {
    app.output.write(`[verify] Not saved (${terminalText(error instanceof Error ? error.message : String(error))}); this run gets ${formatDuration(longer)}.\n`);
  }
  return "more-time";
}
