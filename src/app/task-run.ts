/** One request to the model, start to receipt: the checklist and plan first (when offered), the turn, the checks,
 * the review and the proof that the tests fail without the change, then the receipt and the row of next steps.
 * Moved from src/app.ts. */

import type { CasperApp } from "../app";
import os from "node:os";
import { riskyBaseline, riskyLinesIn } from "../network/risky-receipt";
import path from "node:path";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { SmokeChecks } from "../services/smoke";
import { lineText, terminalText } from "../tui/format";
import { ProjectMemory, type TaskOutcome } from "../memory/store";
import type { ChildProject } from "../project/child";
import type { RuntimeImage, RuntimeSession } from "../runtime/types";
import { formatSelectedSkills } from "../skills/registry";
import { classifyTask, formatTaskPrompt, underSpecifiedTarget } from "../task/classify";
import { answerClaimsBrowserPass, formatShortReceipt, undoPathsShown, formatTaskResult, type TaskResult } from "../task/result";
import { TaskObservations } from "../task/observations";
import { diffSnapshots, type TreeChanges } from "../task/changes";
import type { CheckName, VerificationReport } from "../verify/evidence";
import { VerifierRegistry } from "../verify/registry";
import { PLAN_CHOICES, PLAN_QUESTION } from "./safe-choices";
import { DEFAULT_SPEND_LIMITS, SpendGuard, requestSpendLimit } from "../task/spend";
import { VerificationTask } from "../verify/task";
import { ChangeBaseline, changesCode, proofRepairPrompt, type ChangeProof } from "../verify/proof";
import { independentAcceptance } from "../verify/acceptance";
import { parseChecklist, parseReview, requirementsReviewPrompt, ROUND_MAX_TURNS, type RequirementsReview } from "../task/review";
import { extractChecklist, formatChecklistPrompt, normalizeCases } from "../task/checklist";
import { isOutside } from "../platform/inside";
import { autoDetectedChecks } from "../verify/migrations-check";
import { buildNextRow, type NextItem } from "../tui/next-row";
import { findFlow, formatFlowPrompt, loadFlowCatalog, type Flow, type FlowRule } from "../flows/catalog";
import { beforeWorkPanel, readBeforeWorkAnswer, suggestBeforeWork } from "../flows/suggest";
import { extractPlan, parsePlanLines, planEditorHeading, planEditorLines, type ParsedPlan } from "../flows/plan";
import { PROJECT_YAML, saveProjectCommand } from "../project/config-write";
import type { TaskClassification } from "../task/classify";
import { planAutoChecks } from "../verify/mode";
import { outsideWritesReceipt, sandboxReceipt } from "./sandbox";
import { opened } from "./new-project";
import { explainModelError } from "../runtime/model-errors";
import { tildePath } from "../new/scaffold";
import { offerNetworkServer } from "./network-host";
import { updateFooter, nameConversation, phase, clearSteps } from "./footer";
import { prepareCapabilities, serviceManager, stopDebugger, planPages, pageNotesFor, pagePaths } from "./task-tools";
import { ensureModel, retryModelFailure, bigModelReceipt, bigModelNotice, imagesForModel, switchForPictures, restoreModel } from "./big-model";
import { attachImages } from "./images";
import { lookPrompt, pageLook, SHOW_PAGES_CHOICES, SHOW_PAGES_QUESTION } from "../services/page-look";
import { offerNewProject, childProjectOfTask, runChildChecks, offerWorkFolder } from "./workspace";
import { runVerification, writeCheckResult, taskNetworkOptions, checksPlan, saveFoundCheck, projectAfterSetup } from "./verification";
import { reportSkillWarnings } from "./wiring";
import { ensureRuntime } from "./runtime-start";

export async function runModelTask(app: CasperApp, prompt: string, options: { flow?: Flow; planFirst?: boolean } = {}): Promise<VerificationReport | undefined> {
  if (app.closing) return;
  // Pictures with the request: pasted ones and dropped image files are [image N] from here on (app/images.ts).
  const attached = await attachImages(prompt, { cwd: app.activeWorkspaceRoot(), pasted: app.pastedImages });
  app.pastedImages = undefined;
  for (const note of attached.notes) app.output.write(`[image] ${terminalText(note)}\n`);
  prompt = attached.text;
  // A flow the user picked, or /plan, is already this task's one choice before work: no other panel.
  app.beforeWorkAsked = Boolean(options.flow || options.planFirst);
  if (await offerNewProject(app, prompt) === "stop" || app.closing || app.commandAbort?.signal.aborted) return;
  await offerNetworkServer(app, prompt);
  if (app.closing || app.commandAbort?.signal.aborted) return;
  const previous = app.observations.spent();
  app.spentBefore = { tokens: app.spentBefore.tokens + previous.tokens, cost: app.spentBefore.cost + previous.cost };
  app.observations = new TaskObservations();
  // A limit said in the request ("keep it under $2") is this task's pause, whatever the config says.
  const said = requestSpendLimit(prompt);
  const limits = app.projectContext?.spend ?? DEFAULT_SPEND_LIMITS;
  app.spendGuard = new SpendGuard(said === undefined ? limits : { ...limits, pauseAt: said, ...(limits.noteAt !== undefined && limits.noteAt >= said ? { noteAt: undefined } : {}) });
  app.bigModelUse = undefined;
  app.taskChangeServers = new Set();
  let context = app.projectContext!;
  const classification = classifyTask(prompt);
  // beforeChanges policy: under-specified implement/configure work must see one recorded
  // ask attempt before the first edit. Interactive sessions only — one-shot cannot ask,
  // so denying edits there would only deadlock the task.
  app.asksThisTask = 0;
  // A new request gets a fresh delegation budget (the budget belongs to the parent task).
  app.delegateToolForTask = undefined;
  app.editGateActive = app.interactive && app.terminal.rich
    && context.policy.behavior.askQuestions === "beforeChanges"
    && (classification.intent === "implement" || classification.intent === "configure")
    && underSpecifiedTarget(prompt);
  // Debug values and active debuggees do not silently become model-task context.
  await stopDebugger(app);
  // A finished task's immutable evidence belongs to its receipt, not the next prompt.
  if (app.browser?.status().state === "closed") app.browser = undefined;
  app.lastTaskRequest = prompt;
  const selected = await app.skillRegistry!.loadForTask(prompt, context.model, classification);
  reportSkillWarnings(app);
  if (selected.length) {
    app.output.write(` skills selected: ${selected.map(({ skill }) => skill.name).join(", ")}\n`);
  }
  const skillContext = formatSelectedSkills(selected);
  let memoryContext = "";
  try {
    memoryContext = await new ProjectMemory(context.stateDirectory).context();
  } catch {
    // Facts are optional guidance. Keep explicit memory operations fail-closed,
    // and never echo possibly sensitive file contents or paths from read errors.
    if (!app.closing) app.output.write("[memory] Facts unavailable (invalid or unreadable state); continuing without them. Preserve and inspect memory.jsonl before manual repair.\n");
  }
  if (app.closing || app.commandAbort?.signal.aborted) return;
  const flag = app.verificationFlag;
  const configured = context.verification.mode;
  const verificationMode = (await checksPlan(app, context)).mode;
  if (verificationMode !== "off") app.checkTask = new VerificationTask(
    VerifierRegistry.forProject(context.model, context.verification.timeoutMs, app.blockOnCleanupFailure, taskNetworkOptions(app)), app.activeWorkspaceRoot(),
    (result) => writeCheckResult(app, result),
  );
  // Smoke checks are verification: they run only when Casper checks this task.
  const edits: NonNullable<CasperApp["taskEdits"]> = { edited: false, shell: false, turnEnded: false };
  app.taskEdits = edits;
  app.smokeTask = verificationMode !== "off" ? new SmokeChecks(context.smoke ?? [], () => serviceManager(app), () => changedSinceTaskStart(app, edits)) : undefined;
  await prepareCapabilities(app, prompt);
  if (app.closing || app.commandAbort?.signal.aborted) return;
  const session = await ensureRuntime(app);
  if (app.closing || app.commandAbort?.signal.aborted) return;
  if (!await ensureModel(app, session)) return;
  // The question comes now; a switch it picks happens only for the build turn, which is the turn that sees them.
  let { images, switchTo } = attached.images.length ? await imagesForModel(app, session, attached.images) : { images: [], switchTo: undefined };
  if (app.closing || app.commandAbort?.signal.aborted) return;
  nameConversation(app, session, prompt);
  updateFooter(app);
  bigModelNotice(app, session);
  clearSteps(app);
  const workspaceRoot = app.activeWorkspaceRoot();
  // Receipts describe the tree, not tool names: a read-only shell run is not a write. Undo's own copy is made
  // alongside, with the conversation's position (the plan turn and repairs are part of the task).
  app.snapshotFailure = undefined;
  const [before, undoStart] = await Promise.all([app.snapshotWorkspace(workspaceRoot, app.commandAbort?.signal),
    app.taskUndo.begin(workspaceRoot, session, app.commandAbort?.signal)]);
  edits.before = before;
  // The risky lines already in the project's config files, so the receipt lists only the ones this task adds.
  const riskyBefore = before ? await riskyBaseline(workspaceRoot, [...before.keys()]).catch(() => undefined) : undefined;
  let thrownError: string | undefined;
  // verification.checklist: the cases the request states, listed before the model starts, so it tests each one.
  // Unset, it is on for interactive code changes and off otherwise: questions, docs, refactors and one-shot runs.
  // At most one question before work: after the new-project question there is no checklist panel.
  const checklistOn = !app.beforeWorkAsked && (context.verification.checklist
    ?? (app.interactive && ["implement", "fix", "test"].includes(classification.intent)));
  const complete = checklistOn ? session.complete?.bind(session) : undefined;
  // Plan first: suggested for a build request with several asks, as one numbered choice folded into the
  // checklist panel, so there is still one panel before work. /plan chooses it directly.
  const planOffer = !app.beforeWorkAsked && app.terminal.canAsk ? suggestBeforeWork(prompt, classification, { interactive: app.interactive }) : undefined;
  const planState = planOffer ? await app.suggestions.state(context) : undefined;
  let planFirst = options.planFirst === true;
  let checklist: string[] | undefined;
  if (planOffer && planState?.visible(planOffer.id)) {
    const listed = complete ? await makeChecklist(app, complete, prompt, { edit: false }) : undefined;
    if (app.closing || app.commandAbort?.signal.aborted) return;
    const panel = beforeWorkPanel(planOffer, listed ?? []);
    // Editing needs the rich editor; the plain terminal offers the other two.
    if (!app.terminal.rich) panel.options = panel.options.filter((option) => option.choice !== "edit");
    app.events.ensureLineBreak();
    const picked = await app.terminal.pick(panel.question, panel.options.map(({ label, description }) => ({ label, description })), app.commandAbort?.signal);
    if (app.closing || app.commandAbort?.signal.aborted) return;
    const answer = readBeforeWorkAnswer(panel, picked === undefined ? undefined : [picked]);
    if (answer.kind === "plan-first") { planFirst = true; await planState.recordChosen(planOffer.id).catch(() => {}); }
    else await planState.recordIgnored([planOffer.id]).catch(() => {});
    if (answer.kind === "edit") checklist = await makeChecklist(app, complete!, prompt, { cases: listed });
    else {
      const cases = normalizeCases([...(listed ?? []), ...(answer.kind === "typed" ? [answer.text] : [])]);
      checklist = cases.length ? cases : undefined;
    }
    if (app.closing || app.commandAbort?.signal.aborted) return;
  } else if (!planFirst) checklist = complete ? await makeChecklist(app, complete, prompt) : undefined;
  if (app.closing || app.commandAbort?.signal.aborted) return;
  // The plan turn: the model reads and writes a plan and the cases to test; the user edits it, then builds.
  let planBlock = "";
  let changedWhilePlanning: string[] | undefined;
  if (planFirst) {
    const planned = await runPlanTurn(app, session, prompt, checklist, workspaceRoot);
    if (planned === "stop" || app.closing || app.commandAbort?.signal.aborted) return;
    changedWhilePlanning = planned.changed;
    checklist = planned.plan.tests.length ? planned.plan.tests : undefined;
    planBlock = `Casper plan (the user read and accepted it). Follow these steps in order:\n${planned.plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
  }
  // A code change in auto mode is reviewed and proven: the tests must fail without it. Only requests
  // that are clearly not behavior changes are exempt; the keyword intent is too coarse to decide more
  // ("add X; you may add new test files" reads as intent "test"), so the work itself decides later.
  // The workspace as it is now is what "without the change" means.
  const testCommand = context.model.commands.test?.trim();
  const proving = verificationMode === "auto" && Boolean(testCommand) && before !== undefined
    && !["refactor", "document", "inspect", "visualize", "configure"].includes(classification.intent);
  let baseline: ChangeBaseline | undefined;
  let baselineUnavailable: string | undefined;
  if (proving) {
    try { baseline = await ChangeBaseline.capture(workspaceRoot, { signal: app.commandAbort?.signal }); app.taskBaseline = { baseline, root: workspaceRoot }; }
    catch (error) {
      if (app.commandAbort?.signal.aborted) return;
      baselineUnavailable = `Casper could not copy the workspace to compare: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  let proof: ChangeProof | undefined;
  let proofSkipped: string | undefined;
  let review: RequirementsReview | undefined;
  let acceptance: TaskResult["acceptance"];
  let afterModel: Map<string, string> | undefined;
  let verification: VerificationReport | undefined;
  let autoChecks: ReturnType<typeof planAutoChecks> | undefined;
  let pageNotes: string[] | undefined;
  let pagesShown: number | undefined;
  let workFolder: ChildProject | undefined;
  let receiptShown = false;
  const flatten = (changes: TreeChanges) => [...changes.added, ...changes.modified, ...changes.removed].sort();
  // Automatic effort's classifier is a model call outside the conversation, so the task's usage
  // totals cannot include it: any classification (or an unreadable count) makes them unknown.
  const classifications = () => { try { return session.getUsage?.().effortClassification?.requests ?? 0; } catch { return undefined; } };
  const classifiedBefore = classifications();
  let visionBack: string | undefined;
  try {
    phase(app, "task", "start");
    try {
      if (switchTo) {
        visionBack = await switchForPictures(app, session, switchTo);
        if (!visionBack) images = [];
        if (app.closing || app.commandAbort?.signal.aborted) return;
      }
      await session.prompt([
        memoryContext,
        skillContext,
        formatTaskPrompt(prompt, classification, context.model, { verificationMode, proveChange: proving,
          reviewFollows: context.verification.review === true, afterContext: Boolean(memoryContext || skillContext) }),
        planBlock,
        checklist ? formatChecklistPrompt(checklist) : "",
        // A flow the user picked from the row: guidance for this one request.
        options.flow ? formatFlowPrompt(options.flow, prompt) : "",
      ].filter(Boolean).join("\n\n"), app.commandAbort?.signal, { request: prompt, maxTurns: app.maxTurns, ...(images.length ? { images } : {}) });
      await retryModelFailure(app, session, prompt);
    } finally {
      // A switch to a model that sees pictures was for this request's own turn; checks and repairs run on yours.
      if (visionBack && !app.closing) await restoreModel(app, session, visionBack);
    }
    phase(app, "task", "end");
    // Repair, review and proof rounds follow the change.
    edits.turnEnded = true;
    afterModel = before && !app.closing ? await app.snapshotWorkspace(workspaceRoot) : undefined;
    // A project the model just set up (package.json, pyproject.toml, Package.swift...) gets its checks now,
    // not on the next task: the checks known at the start were those of the folder before the change.
    if (verificationMode !== "off" && before && afterModel && !app.closing) {
      const refreshed = await projectAfterSetup(app, context, flatten(diffSnapshots(before, afterModel)));
      if (refreshed) {
        context = refreshed;
        // The same task keeps what the model's casper_check already recorded this turn; repair rounds rebuild
        // the model's tools (prepareCapabilities), so its casper_check offers the new checks.
        app.checkTask?.useRegistry(VerifierRegistry.forProject(context.model, context.verification.timeoutMs, app.blockOnCleanupFailure, taskNetworkOptions(app)));
      }
    }
    // A request cut short by --max-turns is unfinished work: checking it would only start repairs.
    const cancelled = app.closing || app.commandAbort?.signal.aborted || app.taskRuntimeCancelled || app.checkTask?.signal.aborted || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined;
    const stopped = cancelled || app.taskRuntimeFailed;
    // The model errored after editing: its edits are kept, so check them (no repair: the model just failed).
    if (!cancelled && app.taskRuntimeFailed && app.checkTask && verificationMode === "auto") {
      const edited = before && afterModel ? flatten(diffSnapshots(before, afterModel)) : undefined;
      const failedChecks = edited?.length ? planAutoChecks({ selected: context.verification.checks, commands: context.model.commands,
        scopes: context.model.verificationScopes, named: context.model.namedChecks, detected: autoDetectedChecks(context.model), changedPaths: edited }).run : [];
      if (failedChecks.length) {
        app.events.ensureLineBreak();
        app.output.write(`… Casper checking the edits the model made before it failed: ${failedChecks.join(", ")}\n`);
        verification = await runVerification(app, failedChecks, false, prompt, app.checkTask);
      }
    }
    if (!stopped && app.checkTask && verificationMode === "auto") {
      const changedByModel = before && afterModel ? flatten(diffSnapshots(before, afterModel)) : undefined;
      autoChecks = planAutoChecks({
        selected: context.verification.checks, commands: context.model.commands, scopes: context.model.verificationScopes,
        named: context.model.namedChecks, detected: autoDetectedChecks(context.model), changedPaths: changedByModel,
      });
      // Configured smoke checks run after a change; checks the model recorded always run.
      const smokeDue = Boolean(app.smokeTask?.recordedCount || (app.smokeTask?.size && autoChecks.skipped !== "no-changes"));
      // Pages are opened when the project facts say so (a web project, changed files that reach a page), never the prompt.
      // A removed page is not opened: only files that exist now can reach a page.
      const pagePlan = before && afterModel ? await planPages(app, context, pagePaths(diffSnapshots(before, afterModel))) : undefined;
      const pagesDue = Boolean(before && pagePlan && "service" in pagePlan && pagePlan.pages.open.length);
      app.pageTask = pagesDue ? { context, root: workspaceRoot, before: before! } : undefined;
      pageNotes = pagesDue ? undefined : pageNotesFor(app, pagePlan);
      // Fresh passes the model already recorded are reused, not rerun (VerificationTask).
      if (autoChecks.run.length || app.checkTask.checks.length || smokeDue || pagesDue) {
        const pending = [...new Set([...autoChecks.run, ...app.checkTask.checks]), ...(smokeDue ? ["smoke"] : []), ...(pagesDue ? ["pages"] : [])];
        app.events.ensureLineBreak();
        app.output.write(`… Casper checking: ${pending.join(", ")}\n`);
        verification = await runVerification(app, autoChecks.run, true, prompt, app.checkTask);
        // A model that sees pictures may look at the changed pages once (showPages); its fixes are checked again.
        ({ verification, shown: pagesShown } = await lookAtPages(app, session, prompt, autoChecks.run, verification, workspaceRoot));
        const changedCode = Boolean(before && afterModel && changesCode(diffSnapshots(before, afterModel)));
        if (verification.status === "pass" && !(proving && changedCode)) {
          proofSkipped = !verification.results.length && verification.pages && !verification.smoke?.checks.length
            ? verification.pages.pages.every((page) => page.consoleChecked) ? PAGES_ONLY_PROOF : PAGES_ANSWER_ONLY_PROOF
            : proofSkipReason({ intent: classification.intent, testCommand, snapshot: before !== undefined, changedCode,
              testsAddedNow: !testCommand && Boolean(context.model.commands.test?.trim()) });
        }
        if (proving && verification.status === "pass" && changedCode) {
          const initialReview = parseChecklist(app.lastAnswer);
          ({ verification, proof, review } = await finishChange(app, { baseline, baselineUnavailable, before, root: workspaceRoot,
            command: testCommand!, request: prompt, checks: autoChecks.run, verification, session, initialReview }));
        }
        // Not tied to the proof: any code change whose checks pass (server tasks and configure requests too).
        const acceptanceMode = context.verification.acceptance;
        if ((acceptanceMode === true || acceptanceMode === "warn") && testCommand && changedCode && verification.status === "pass" && proof?.status !== "unproven"
          && !app.closing && !app.commandAbort?.signal.aborted && !app.taskRuntimeFailed && app.taskTurnLimit === undefined && app.taskSpendStop === undefined) {
          acceptance = await acceptChange(app, { session, before: before!, root: workspaceRoot, command: testCommand, request: prompt,
            mode: acceptanceMode === "warn" ? "warn" : "verdict" });
        }
      }
    } else if (!stopped && app.checkTask && (app.checkTask.checks.length || app.smokeTask?.recordedCount)) {
      verification = await runVerification(app, app.checkTask.checks, true, prompt, app.checkTask);
    }
    // The work landed in a project inside this folder (sample-tools in Documents): its own checks run for this receipt.
    if (!stopped && before && afterModel && !app.closing) {
      workFolder = await childProjectOfTask(app, context, flatten(diffSnapshots(before, afterModel)));
      if (workFolder && !verification && app.checkTask && verificationMode === "auto") {
        const child = await runChildChecks(app, workFolder, flatten(diffSnapshots(before, afterModel)));
        if (child) {
          verification = child;
          autoChecks = undefined;
          if (child.status === "pass") proofSkipped = `the checks ran in ${workFolder.relative}; Casper did not compare the tests with and without the change`;
        }
      }
    }
  } catch (error) {
    app.taskRuntimeFailed = true;
    thrownError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    app.taskBaseline = undefined;
    await baseline?.dispose();
    const execution = app.closing || app.commandAbort?.signal.aborted || app.taskRuntimeCancelled || app.checkTask?.signal.aborted ? "cancelled" : app.taskRuntimeFailed ? "failed" : "completed";
    // Keep already-executed evidence on terminal error/cancellation, but never
    // launch another command or repair prompt after the task has stopped.
    if (!verification && app.checkTask?.checks.length) verification = {
      status: "blocked", reason: `Task ${execution}; no further checks or repair.`, repairAttempts: 0,
      results: await app.checkTask.refresh(), rounds: app.checkTask.rounds,
    };
    // The model turn and the verification/repair round are measured separately so check
    // scripts and repair edits are never attributed to the request itself.
    afterModel ??= before && !app.closing ? await app.snapshotWorkspace(workspaceRoot) : undefined;
    const afterChecks = verification && afterModel && !app.closing ? await app.snapshotWorkspace(workspaceRoot) : afterModel;
    const changedPaths = before && afterModel ? flatten(diffSnapshots(before, afterModel)) : undefined;
    const changedDuringChecks = afterModel && afterChecks && afterChecks !== afterModel ? flatten(diffSnapshots(afterModel, afterChecks)) : [];
    const classifiedAfter = classifications();
    if (classifiedBefore === undefined || classifiedAfter !== classifiedBefore) app.observations.recordUntrackedModelUse();
    const observations = app.observations.snapshot(changedPaths, changedDuringChecks);
    const browser = !app.closing && app.browser ? await app.browser.report() : undefined;
    const outsideWrites = outsideWritesReceipt(app.sandbox);
    // Dangerous lines in the config files this task changed (reload, shutdown …): a report, never a pass or a fail.
    const riskyLines = changedPaths && !app.closing ? await riskyLinesIn(workspaceRoot, changedPaths, riskyBefore).catch(() => []) : [];
    const services = !app.closing && app.services && !app.services.closed
      ? app.services.status().map(({ name, origin, state }) => ({ name, ...(origin ? { origin } : {}), state })) : [];
    const snapshotFailure = !changedPaths && app.snapshotFailure ? { reason: app.snapshotFailure,
      edited: observations.observedEdits.map((file) => { const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, file));
        return relative && !isOutside(relative) ? relative.split(path.sep).join("/") : file; }) } : undefined;
    const modelError = execution === "failed" ? explainModelError(app.events.lastError ?? thrownError ?? "")?.cause : undefined;
    app.lastTaskResult = { execution, ...(modelError ? { modelError } : {}), verification, ...observations, ...(snapshotFailure ? { snapshotFailure } : {}), ...(browser?.checks.length ? { browser, ...(browser.status !== "pass" && answerClaimsBrowserPass(app.lastAnswer) ? { browserClaimed: true } : {}) } : {}),
      ...(services.length ? { services } : {}), ...(riskyLines.length ? { riskyLines: [...riskyLines], ...(riskyLines.more ? { riskyMore: riskyLines.more } : {}) } : {}),
      // Smoke checks ran even without a configured command, so "no checks" no longer describes the task.
      verificationMode, ...(!flag && !configured && verificationMode === "auto" ? { verificationDefaulted: true as const } : {}),
      ...(autoChecks?.skipped && !verification?.smoke && !verification?.pages ? { autoSkipped: autoChecks.skipped } : {}),
      ...(pageNotes?.length && !verification?.pages ? { pageNotes } : {}), ...(pagesShown ? { pagesShown } : {}),
      ...(app.taskTurnLimit !== undefined ? { turnLimit: app.taskTurnLimit } : {}), ...(app.taskSpendStop ? { spendLimit: { ...app.taskSpendStop } } : {}), ...(proof ? { proof } : {}), ...(proofSkipped && !proof ? { proofSkipped } : {}), ...(review ? { review } : {}),
      ...(acceptance ? { acceptance } : {}), ...(checklist ? { checklist } : {}), ...bigModelReceipt(app),
      ...(changedWhilePlanning?.length ? { changedWhilePlanning } : {}), ...(app.sandbox ? { sandbox: sandboxReceipt(app.sandbox)! } : {}),
      ...outsideWrites };
    // The receipt is next: the steps fold and the Working box goes, even for a tool that ended late.
    app.events.reset();
    if (!app.closing) {
      app.terminal.endAssistant();
      app.events.ensureLineBreak();
      // A question that changed nothing and ran no tests gets no receipt, like a general one.
      const answeredOnly = changedPaths?.length === 0 && !app.lastTaskResult.testRunner;
      // A stop at --max-turns or at the spend limit is always said on a receipt.
      if ((classification.intent !== "general" && !answeredOnly) || execution !== "completed" || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined || verification || browser?.checks.length || observations.possibleMutations || observations.changedPaths?.length || observations.changedDuringChecks?.length || observations.observedEdits.length || observations.observedChecks.length
        || observations.remoteChanges?.length || observations.remoteNotRun?.length || observations.secretInCommand) {
        // The second copy and the saved receipt; the change summary lists only this task's files.
        const { stat } = await app.taskUndo.finish(undoStart, { request: prompt, task: app.lastTaskResult, session, servers: [...app.taskChangeServers] });
        const task = app.lastTaskResult;
        // The short receipt gets the colored result edge on the rich terminal; --verbose's full form stays plain.
        const receipt = app.verbose ? formatTaskResult(task) : formatShortReceipt(task, { surface: receiptSurface(app), ...receiptFolder(app, workspaceRoot),
          ...(app.checksHintShown ? { checksHintShown: true as const } : {}), undoNamed: app.undoNamed });
        if (app.verbose) app.output.write(`${receipt}\n`); else app.terminal.writeResult(`${receipt}\n`);
        if (!app.verbose) {
          if (task.autoSkipped === "no-checks" && !task.verification && !task.observedChecks?.length && task.execution === "completed") app.checksHintShown = true;
          // Only the files the receipt printed: ones past its limit are named on a later one.
          for (const shown of undoPathsShown(task, app.undoNamed)) app.undoNamed.add(shown);
        }
        // The per-file table stays behind Diff and --verbose; the receipt already says how many files changed.
        if (app.verbose && stat.trim()) app.output.write(stat.endsWith("\n") ? stat : `${stat}\n`);
        if (app.interactive) await offerNextSteps(app, app.lastTaskResult, prompt, classification);
        receiptShown = true;
      }
    }
    clearSteps(app);
    await recordTaskOutcome(app, { task: prompt, skills: selected.map(({ skill }) => skill.id),
      modelStatus: execution, verification });
    // Last, once this folder has the task's outcome: the offer may move Casper to the project the work is in.
    if (workFolder && receiptShown && !app.closing) await offerWorkFolder(app, workFolder);
  }
  return verification;
}

/**
 * The plan turn of plan first. The model reads and answers with "Plan:" steps and "Tests:" cases; every tool but
 * reading is refused meanwhile. The user edits the plan (rich terminal), then both terminals ask Stop or Build; a run
 * that cannot ask stops after showing the plan. "stop" when nothing is to be built.
 */
export async function runPlanTurn(app: CasperApp, session: RuntimeSession, request: string, cases: readonly string[] | undefined, root: string):
  Promise<{ plan: ParsedPlan; changed?: string[] } | "stop"> {
  const signal = app.commandAbort?.signal;
  const flow = await loadFlow(app, "plan-first");
  if (!flow) { app.output.write("[plan] The plan-first flow could not be loaded; nothing was built.\n"); return "stop"; }
  app.events.ensureLineBreak();
  app.output.write("… Casper planning first: the model reads and writes a plan; Casper blocks the file changes it can see until you choose Build\n");
  const before = await app.snapshotWorkspace(root, signal);
  app.lastAnswer = "";
  app.planning = true;
  try {
    await session.prompt([
      formatFlowPrompt(flow, request),
      ...(cases?.length ? [`Cases the user listed (put each under Tests:):\n${cases.map((item) => `- ${item}`).join("\n")}`] : []),
    ].join("\n\n"), signal, { request, maxTurns: app.maxTurns });
  } finally { app.planning = false; }
  if (app.closing || signal?.aborted || app.taskRuntimeCancelled) return "stop";
  // Casper blocks what it can see; anything that changed anyway is named, never hidden.
  const after = before && !app.closing ? await app.snapshotWorkspace(root) : undefined;
  const diff = before && after ? diffSnapshots(before, after) : undefined;
  const changed = diff ? [...diff.added, ...diff.modified, ...diff.removed].sort() : undefined;
  if (changed?.length) app.output.write(`• Changed while planning: ${changed.map((file) => terminalText(file)).join(", ")}\n`);
  if (app.taskRuntimeFailed) { app.output.write("[plan] The model failed while planning; nothing was built.\n"); return "stop"; }
  const parsed = extractPlan(app.lastAnswer);
  if (!parsed.steps.length) {
    app.output.write("[plan] The answer had no numbered Plan: steps, so nothing was built. Ask again, or send the request without /plan.\n");
    return "stop";
  }
  let plan: ParsedPlan = { steps: parsed.steps, tests: parsed.tests.length ? parsed.tests : normalizeCases([...(cases ?? [])]) };
  const { heading, hint } = planEditorHeading(plan);
  app.events.ensureLineBreak();
  let edited = false;
  if (app.interactive && app.terminal.rich) {
    const lines = await app.terminal.editLines(heading, hint, planEditorLines(plan), signal);
    if (app.closing || signal?.aborted) return "stop";
    const kept = lines ? parsePlanLines(lines) : undefined;
    if (!kept?.steps.length) { app.output.write("[plan] Stopped without building.\n"); return "stop"; }
    edited = planEditorLines(kept).join("\n") !== planEditorLines(plan).join("\n");
    plan = kept;
  } else {
    app.output.write(`${heading}\n${planEditorLines(plan).map((line) => `  ${terminalText(line)}`).join("\n")}\n`);
    if (!app.interactive || !app.terminal.canAsk) {
      app.output.write("[plan] This run can't ask you to build, so Casper stopped after the plan. Nothing was built.\n");
      return "stop";
    }
  }
  // Both terminals ask after the plan, Stop first, so Enter (also the editor's Enter) never starts a build that
  // uses tokens.
  const answer = await app.terminal.pick(PLAN_QUESTION, PLAN_CHOICES.map((choice) => ({ ...choice })), signal);
  if (answer !== "Build" || app.closing || signal?.aborted) { app.output.write("[plan] Stopped without building.\n"); return "stop"; }
  app.output.write(`Casper plan (${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}, ${plan.tests.length} ${plan.tests.length === 1 ? "case" : "cases"}${edited ? ", edited by you" : ""}):\n`
    + `${plan.steps.map((step, index) => `  ${index + 1}. ${terminalText(step)}\n`).join("")}${plan.tests.map((item) => `  - ${terminalText(item)}\n`).join("")}`);
  return { plan, ...(changed?.length ? { changed } : {}) };
}

/** verification.checklist: one separate model call lists the cases the request states and the task prompt asks
 * for one test per case. Nothing is printed before work unless the call failed or the list was cut; the user
 * edits the cases only by choosing to on the plan-first panel. Its usage joins the task's. A failed call is one
 * line on the transcript and the task goes on without a checklist. */
export async function makeChecklist(app: CasperApp, complete: NonNullable<RuntimeSession["complete"]>, request: string,
  options: { edit?: false; cases?: string[] } = {}): Promise<string[] | undefined> {
  let result: { cases: string[]; dropped: number } | { error: string };
  if (options.cases) result = { cases: options.cases, dropped: 0 };
  else {
    phase(app, "checklist", "start");
    try {
      const made = await extractChecklist({ complete, request, signal: app.commandAbort?.signal });
      app.observations.recordModelCall(made.usage);
      result = made;
    } catch (error) {
      // The call may have reached the provider: its usage is unknown.
      app.observations.recordUntrackedModelUse();
      result = { error: `the checklist call failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally { phase(app, "checklist", "end"); }
  }
  if (app.closing || app.commandAbort?.signal.aborted) return undefined;
  if ("error" in result) {
    app.events.ensureLineBreak();
    app.output.write(`• Checklist not made: ${lineText(result.error)}\n`);
    app.steps.skip("checklist"); app.terminal.setSteps(app.steps.text());
    return undefined;
  }
  // Nothing testable in the request (a question, say): no checklist, and no line about it.
  if (!result.cases.length) {
    app.steps.skip("checklist"); app.terminal.setSteps(app.steps.text());
    return undefined;
  }
  // Listed for the plan-first panel, which offers editing them.
  if (options.edit === false) return result.cases;
  // Made quietly: the cases are not printed before work. The receipt names one only when it is not met, and
  // /receipt lists them all. A list cut short still says so.
  if (!options.cases) {
    if (result.dropped) { app.events.ensureLineBreak(); app.output.write(`• Checklist kept ${result.cases.length} cases; ${result.dropped} more ${result.dropped === 1 ? "was" : "were"} left out\n`); }
    return result.cases;
  }
  // "Edit the cases first" on the plan-first panel: the user corrects the list before the model sees it.
  // Enter keeps the editor's lines, Esc (or deleting every line) starts without one, Ctrl+C cancels the task.
  const count = (n: number) => `${n} ${n === 1 ? "case" : "cases"}`;
  app.events.ensureLineBreak();
  const answer = await app.terminal.editLines(`Casper checklist: ${count(result.cases.length)} from your request. The model writes one test per case.`,
    "Enter starts with these · edit, add or delete lines · Esc starts without a checklist", result.cases, app.commandAbort?.signal);
  if (app.closing || app.commandAbort?.signal.aborted) return undefined;
  const kept = answer ? normalizeCases(answer) : [];
  if (!kept.length) {
    app.output.write("[checklist] skipped; the task starts without one\n");
    app.steps.skip("checklist"); app.terminal.setSteps(app.steps.text());
    return undefined;
  }
  return kept;
}

/** verification.acceptance: tests written from the request alone by a separate model call, run once
 * against the change and removed. Signal only: no repair, nothing kept; its usage joins the task's. */
export async function acceptChange(app: CasperApp, input: { session: RuntimeSession; before: Map<string, string>; root: string; command: string; request: string;
  mode: NonNullable<TaskResult["acceptance"]>["mode"] }): Promise<TaskResult["acceptance"]> {
  const { mode } = input;
  const complete = input.session.complete?.bind(input.session);
  if (!complete) return { status: "error", reason: "this runtime cannot make a separate model call", mode };
  const now = await app.snapshotWorkspace(input.root);
  if (!now) return { status: "error", reason: "Casper could not compare the workspace", mode };
  app.events.ensureLineBreak();
  app.output.write("… Casper checking the change against tests written from the request alone\n");
  phase(app, "acceptance", "start");
  try {
    const { usage, ...result } = await independentAcceptance({ complete, request: input.request, root: input.root, changes: diffSnapshots(input.before, now),
      files: now, testCommand: input.command, timeoutMs: app.projectContext!.verification.timeoutMs, signal: app.commandAbort?.signal });
    app.observations.recordModelCall(usage);
    return { ...result, mode };
  } catch (error) {
    if (app.commandAbort?.signal.aborted) throw error;
    // The call may have reached the provider: its usage is unknown.
    app.observations.recordUntrackedModelUse();
    return { status: "error", reason: `the acceptance check failed: ${error instanceof Error ? error.message : String(error)}`, mode };
  } finally { phase(app, "acceptance", "end"); }
}

/** After the checks pass on a fix or feature: with verification.review: true, one requirements-review
 * round (the model checks every stated requirement, fixes gaps and reports them) and the checks again;
 * then the proof. */
export async function finishChange(app: CasperApp, input: {
  baseline?: ChangeBaseline; baselineUnavailable?: string; before: Map<string, string>; root: string; command: string;
  request: string; checks: readonly CheckName[]; verification: VerificationReport; session: RuntimeSession;
  initialReview?: { done: string[]; open: string[] };
}): Promise<{ verification: VerificationReport; proof?: ChangeProof; review?: RequirementsReview }> {
  const context = app.projectContext!;
  const stopped = () => app.closing || Boolean(app.commandAbort?.signal.aborted) || app.taskRuntimeFailed || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined;
  const max = context.repair.maxAttempts;
  let verification = input.verification;
  // The review is opt-in (verification.review: true): pinned benchmarks showed no first-time-right gain
  // for 40% of the wall time. With it on, the first turn is not asked for a checklist; with it off
  // (the default), the first turn asks for one and only the first answer's own, if any, is kept.
  const initialReview = input.initialReview;
  if (context.verification.review !== true) {
    if (verification.status !== "pass" || stopped()) return { verification, review: initialReview };
    phase(app, "proof", "start");
    const result = await proveChange(app, { ...input, verification });
    phase(app, "proof", "end");
    return { ...result, review: initialReview };
  }
  app.events.ensureLineBreak();
  phase(app, "review", "start");
  app.output.write("↻ review: checking the work against every requirement\n");
  app.lastAnswer = "";
  const unreviewed = await app.snapshotWorkspace(input.root);
  await prepareCapabilities(app, input.request);
  const cutOff = await promptRound(app, input.session, requirementsReviewPrompt(input.request), input.request);
  if (stopped()) return { verification };
  if (cutOff) app.output.write(`↻ review: stopped at its ${ROUND_MAX_TURNS}-turn budget\n`);
  const review: RequirementsReview = { ...(parseReview(app.lastAnswer) ?? { missing: true as const }), ...(cutOff ? { incomplete: true as const } : {}) };
  // Checks rerun only when the review edited (or the tree cannot be compared); failures get the remaining repairs.
  const after = unreviewed && await app.snapshotWorkspace(input.root);
  const edited = !unreviewed || !after || [...Object.values(diffSnapshots(unreviewed, after))].some((paths) => paths.length);
  if (edited) {
    const reviewed = await runVerification(app, input.checks, true, input.request, app.checkTask, Math.max(0, max - verification.repairAttempts));
    verification = { ...reviewed, repairAttempts: verification.repairAttempts + reviewed.repairAttempts };
  }
  phase(app, "review", "end");
  if (verification.status !== "pass" || stopped()) return { verification, review };
  phase(app, "proof", "start");
  const result = await proveChange(app, { ...input, verification });
  phase(app, "proof", "end");
  return { ...result, review };
}

/** Compare the tests with and without the change. An unproven change gets one repair round,
 * within the repair budget, to add a test that fails without it; checks and comparison rerun. */
export async function proveChange(app: CasperApp, input: {
  baseline?: ChangeBaseline; baselineUnavailable?: string; before: Map<string, string>; root: string; command: string;
  request: string; checks: readonly CheckName[]; verification: VerificationReport; session: RuntimeSession;
}): Promise<{ verification: VerificationReport; proof?: ChangeProof }> {
  const context = app.projectContext!;
  const compare = async (): Promise<ChangeProof | undefined> => {
    const now = await app.snapshotWorkspace(input.root);
    if (!now) return { status: "unavailable", check: "test", reason: "Casper could not compare the workspace" };
    const changes = diffSnapshots(input.before, now);
    if (!input.baseline) {
      return changes.added.length || changes.modified.length || changes.removed.length
        ? { status: "unavailable", check: "test", reason: input.baselineUnavailable ?? "Casper could not copy the workspace" } : undefined;
    }
    app.events.ensureLineBreak();
    app.output.write("… Casper checking that the tests fail without the change\n");
    return input.baseline.prove({ root: input.root, changes, check: "test", command: input.command,
      timeoutMs: context.verification.timeoutMs, signal: app.commandAbort?.signal, onCleanupFailure: app.blockOnCleanupFailure });
  };
  let verification = input.verification;
  let proof = await compare();
  const stopped = () => app.closing || Boolean(app.commandAbort?.signal.aborted) || app.taskRuntimeFailed || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined;
  const max = context.repair.maxAttempts;
  if (proof?.status !== "unproven" || verification.repairAttempts >= max || stopped()) return { verification, proof };
  const attempt = verification.repairAttempts + 1;
  app.output.write(`↻ repair ${attempt}/${max}: add a test that fails without the change\n`);
  await prepareCapabilities(app, input.request);
  // A round cut off by its own budget needs no mark: the checks and the comparison below decide.
  await promptRound(app, input.session, proofRepairPrompt(input.request, proof), input.request);
  if (stopped()) return { verification: { ...verification, repairAttempts: attempt }, proof };
  const again = await runVerification(app, input.checks, true, input.request, app.checkTask, max - attempt);
  verification = { ...again, repairAttempts: attempt + again.repairAttempts };
  if (verification.status === "pass" && !stopped()) proof = await compare();
  return { verification, proof };
}

/**
 * The page look: after a UI change whose checks pass, a model that sees pictures is shown the page screenshots once
 * (showPages: ask once a session, on, off), so it can fix what loads but looks wrong. When it edits, the checks
 * run again with the repairs left. Never a check itself. `shown` is how many pictures it was shown.
 */
export async function lookAtPages(app: CasperApp, session: RuntimeSession, request: string, checks: readonly CheckName[], verification: VerificationReport,
  root: string): Promise<{ verification: VerificationReport; shown?: number }> {
  const stopped = () => app.closing || Boolean(app.commandAbort?.signal.aborted) || app.taskRuntimeFailed || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined;
  if (verification.status !== "pass" || !verification.pages?.pages.some((page) => page.screenshots) || stopped()) return { verification };
  let sees: boolean | undefined;
  try { sees = session.getStatus?.()?.images; } catch { sees = undefined; }
  if (sees !== true || !await showPagesAllowed(app)) return { verification };
  const look = await pageLook(verification.pages.pages);
  if (!look || stopped()) return { verification };
  app.events.ensureLineBreak();
  app.output.write(`↻ look: the AI looks at ${look.images.length} screenshot${look.images.length === 1 ? "" : "s"} of ${look.shown.map((page) => terminalText(page.path)).join(", ")}\n`);
  const before = await app.snapshotWorkspace(root);
  await prepareCapabilities(app, request);
  await promptRound(app, session, lookPrompt(request, look), request, look.images);
  if (stopped()) return { verification, shown: look.images.length };
  const after = before && await app.snapshotWorkspace(root);
  const edited = !before || !after || [...Object.values(diffSnapshots(before, after))].some((paths) => paths.length);
  if (!edited) return { verification, shown: look.images.length };
  const max = app.projectContext!.repair.maxAttempts;
  const again = await runVerification(app, checks, true, request, app.checkTask, Math.max(0, max - verification.repairAttempts));
  return { verification: { ...again, repairAttempts: verification.repairAttempts + again.repairAttempts }, shown: look.images.length };
}

/** showPages: on or off as set; ask (the default) asks once a session, and only a person answers it (1 No). */
export async function showPagesAllowed(app: CasperApp): Promise<boolean> {
  const setting = app.projectContext?.showPages ?? "ask";
  if (setting !== "ask") return setting === "on";
  if (app.showPagesAnswer !== undefined) return app.showPagesAnswer;
  if (!app.interactive || !app.terminal.canAsk) return false;
  app.events.ensureLineBreak();
  const picked = await app.terminal.pick(SHOW_PAGES_QUESTION, [...SHOW_PAGES_CHOICES], app.commandAbort?.signal);
  if (app.commandAbort?.signal.aborted) return false;
  app.showPagesAnswer = picked === SHOW_PAGES_CHOICES[1].label;
  return app.showPagesAnswer;
}

/** A round after the task turn (review, proof repair) with its own ROUND_MAX_TURNS budget. A --max-turns
 * at or below it wins and stays the task's stop (taskTurnLimit, exit 2). The round's own budget ending it
 * is not the task's stop: Casper goes on with the checks and the proof. True when that budget ended it. */
export async function promptRound(app: CasperApp, session: RuntimeSession, text: string, request: string, images?: RuntimeImage[]): Promise<boolean> {
  const roundBudget = app.maxTurns === undefined || ROUND_MAX_TURNS < app.maxTurns;
  await session.prompt(text, app.commandAbort?.signal, { request, maxTurns: roundBudget ? ROUND_MAX_TURNS : app.maxTurns, ...(images?.length ? { images } : {}) });
  if (!roundBudget || app.taskTurnLimit === undefined) return false;
  app.taskTurnLimit = undefined;
  return true;
}

export async function recordTaskOutcome(app: CasperApp, input: { task: string; skills: string[]; modelStatus: TaskOutcome["modelStatus"]; verification?: VerificationReport }): Promise<void> {
  // Shutdown is not a completed task. Never launch a late persistence operation.
  if (app.closing) return;
  app.memoryWork = new ProjectMemory(app.projectContext!.stateDirectory).recordOutcome(input).then(() => {}, () => {
    app.output.write("[memory] Task outcome was not recorded (invalid, locked, full, or unavailable state); no acceptance inferred.\n");
  });
  try { await app.memoryWork; }
  finally { app.memoryWork = undefined; }
}

/** The row under the receipt: numbered, plain, and never waited on. A source that throws offers nothing. */
export async function offerNextSteps(app: CasperApp, task: TaskResult, request?: string, classification?: TaskClassification): Promise<void> {
  let undo: NextItem | undefined, diff: NextItem | undefined;
  const more: NextItem[] = [];
  for (const source of app.nextSteps) {
    let offered;
    try { offered = source(task); } catch { continue; }
    undo ??= offered?.undo; diff ??= offered?.diff;
    more.push(...offered?.more ?? []);
  }
  // Suggested flows follow the other steps; nothing about them waits or asks.
  let hint: string | undefined;
  if (request !== undefined && classification && app.projectContext) {
    const suggested = await app.suggestions.items({ context: app.projectContext, task, request, classification,
      interactive: app.interactive, taken: more.length }).catch(() => ({ items: [] as NextItem[], hint: undefined }));
    more.push(...suggested.items);
    hint = suggested.hint;
  }
  if (app.closing) return;
  // Undo and Show diff of this task, unless a source offered its own.
  const own = app.taskUndo.nextItems(task);
  undo ??= own.undo; diff ??= own.diff;
  app.terminal.offerNext(buildNextRow({ undo, diff, more, ...(hint ? { hint } : {}) }));
}

/** A bundled flow, or the user's own trusted replacement. Warnings about a user flow are said once. */
export async function loadFlow(app: CasperApp, rule: FlowRule): Promise<Flow | undefined> {
  const catalog = await loadFlowCatalog(app.skillRegistry).catch(() => undefined);
  for (const warning of catalog?.warnings ?? []) {
    if (app.flowWarnings.has(warning)) continue;
    app.flowWarnings.add(warning);
    app.output.write(`${terminalText(warning)}\n`);
  }
  return catalog ? findFlow(catalog, rule) : undefined;
}

/** `/suggestion <id>`: the key under a receipt that picked a suggestion. Only one on offer right then runs. */
export async function runSuggestion(app: CasperApp, id: string): Promise<VerificationReport | undefined> {
  const picked = app.suggestions.take(id);
  if (!picked) {
    app.output.write("[suggestions] That suggestion is not on offer now. Suggestions are picked by their number right after a receipt.\n");
    return undefined;
  }
  const { action } = picked.choice;
  if (action.kind === "remember-command") {
    const context = app.projectContext!;
    try {
      const written = await saveProjectCommand(context.info.root, action.name, action.command);
      // The write is undoable: its own receipt holds the file's text before and after.
      const saved = await app.taskUndo.recordSetting(context.info.root, `Remember ${action.command} as this project's ${action.name} command`,
        { file: PROJECT_YAML, line: written.line, before: written.before, after: written.after }).catch(() => undefined);
      app.output.write(`[project] Saved ${terminalText(written.line)} in ${PROJECT_YAML}${saved ? `. /undo ${saved} takes it back` : ""}\n`);
      if (saved && app.interactive) app.terminal.offerNext(buildNextRow({ undo: { label: "Undo", command: `/undo ${saved}` } }));
      // The next task checks with it.
      try { app.projectContext = await app.loadProjectContextFn(context.info); }
      catch (error) { app.output.write(`[project] ${PROJECT_YAML} could not be read again (${terminalText(error instanceof Error ? error.message : String(error))}); restart Casper to use it.\n`); }
    } catch (error) {
      app.output.write(`[project] Not saved: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
    }
    return undefined;
  }
  if (action.kind === "save-check") { await saveFoundCheck(app, action.name); return undefined; }
  if (action.kind === "run") {
    const text = await action.run();
    if (text && !app.closing) app.output.write(`${terminalText(text)}\n`);
    return undefined;
  }
  const flow = await loadFlow(app, action.flow);
  if (!flow) { app.output.write(`[suggestions] The ${action.flow} flow could not be loaded.\n`); return undefined; }
  const request = action.flow === "prove-fix"
    ? `Add a test that proves this bug stays fixed: the test must fail without the fix and pass with it. The fix was for: ${picked.request}`
    : picked.request;
  return runModelTask(app, request, { flow });
}

/** Next commands in a receipt are slash commands in a session, casper invocations otherwise. */
export function receiptSurface(app: CasperApp): "interactive" | "one-shot" {
  return app.interactive ? "interactive" : "one-shot";
}

/** A one-shot run in another folder (`--cd`): its undo command names that folder. */
export function receiptFolder(app: CasperApp, root: string): { folder?: string } {
  if (app.interactive) return {};
  // The working folder is always a real path; the project may be named through a link (macOS's /var).
  let real = root;
  try { real = realpathSync(root); } catch { /* gone: compare as named */ }
  const inside = [root, real].some((base) => {
    const relative = path.relative(base, process.cwd());
    return relative === "" || !isOutside(relative);
  });
  if (inside) return {};
  // cmd and Windows PowerShell never expand ~, so on Windows the command names the folder in full.
  return { folder: process.platform === "win32" ? root : tildePath(root, app.sessionHomeDir ?? os.homedir()) };
}

/** Whether the task's code may differ from its start. A shell command's effect is unknown, so the tree is
 * compared to the start; an uncomparable tree counts as changed. */
export async function changedSinceTaskStart(app: CasperApp, edits: NonNullable<CasperApp["taskEdits"]>): Promise<boolean> {
  if (edits.edited || edits.turnEnded) return true;
  if (!edits.shell) return false;
  const now = edits.before && await app.snapshotWorkspace(app.activeWorkspaceRoot());
  return !now || Object.values(diffSnapshots(edits.before!, now)).some((paths) => paths.length > 0);
}

/** Why a change whose checks passed was not compared with and without it, in plain words for the receipt. */
/** The verdict's reason when only page checks passed: they show the pages load, not that the change works. */
export const PAGES_ONLY_PROOF = "pages load, but no test fails without the change";
/** The same without Chrome: a page that answers over HTTP may still fail once its scripts run. */
export const PAGES_ANSWER_ONLY_PROOF = "pages answer, but their console was not checked and no test fails without the change";

export function proofSkipReason(options: { intent: string; testCommand?: string; snapshot: boolean; changedCode: boolean; testsAddedNow?: boolean }): string {
  if (options.intent === "refactor") return "a refactor should not change behavior, so no test is expected to fail without it";
  if (["document", "inspect", "visualize", "configure"].includes(options.intent)) return `Casper does not compare ${options.intent} requests with and without the change`;
  if (!options.testCommand && options.testsAddedNow) return "the tests came with this change, so there is no version without it to compare with";
  if (!options.testCommand) return 'there are no tests yet to compare with; say "add tests"';
  if (!options.snapshot) return "Casper could not record the workspace before the change";
  if (!options.changedCode) return "only non-code files changed";
  return "Casper did not compare the tests with and without the change";
}
