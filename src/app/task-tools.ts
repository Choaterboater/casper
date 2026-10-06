/** What a task works with besides the model: the tools it is offered (MCP, LSP, references, web, browser, services,
 * helpers), the browser, dev servers and debugger it starts (/tasks lists them), and its page and smoke checks.
 * Moved from src/app.ts. */

import type { CasperApp } from "../app";
import { BrowserSession } from "../browser/session";
import { browserDefaults } from "../browser/discovery";
import { ServiceManager } from "../services/manager";
import { SmokeChecks, type SmokeReport } from "../services/smoke";
import { serviceTool } from "../services/tool";
import { formatPagesNotChecked, formatSkippedPage, PageChecks, planPageCheck, type PageCheckPlan, type PageReport } from "../services/page-checks";
import { formatTerminalJSON } from "../tui/json";
import { redactPreview, terminalText } from "../tui/format";
import { formatProjectContext, type ProjectContext } from "../project/context";
import type { RuntimeTool } from "../runtime/types";
import { diffSnapshots, type TreeChanges } from "../task/changes";
import { assembleTaskTools } from "./capabilities";
import { webTools } from "../web/tools";
import type { BackgroundTask } from "./background";
import { opened } from "./new-project";
import { askToolFor } from "./approvals";
import { phase } from "./footer";
import { appReaderTool } from "./reader";
import { projectPrivatePaths } from "./wiring";

export async function prepareCapabilities(app: CasperApp, task: string): Promise<void> {
  app.browserInstalled ??= browserDefaults.installed().catch(() => false);
  const nextTools = await assembleTaskTools(task, {
    broker: app.broker!, delegate: delegateTool(app), ask: askToolFor(app),
    check: app.checkTask?.tool(), lsp: app.lsp!, confirmRename: app.confirmRename,
    references: app.references!, ...(app.web ? { web: webTools(app.web, app.commandAbort?.signal) } : {}), visualization: app.visualization!, projectRoot: app.activeWorkspaceRoot(),
    reader: appReaderTool({ context: app.projectContext, session: () => app.session, shell: app.shell, broker: app.broker, root: app.activeWorkspaceRoot(), home: app.homeDir(), privatePaths: projectPrivatePaths(app), onUsage: (usage) => app.observations.recordModelCall(usage), signal: app.commandAbort?.signal }),
    browserReady: app.browser?.status().state === "ready", browserInstalled: await app.browserInstalled, browser: () => browserSession(app),
    browserSignal: app.commandAbort?.signal,
    services: { declared: Object.keys(app.projectContext?.services ?? {}).length > 0, live: app.services?.live({ detected: false }) ?? false },
    serviceTool: () => serviceTool(() => serviceManager(app), app.commandAbort?.signal, () => app.smokeTask,
      app.shell?.approve ? (command, signal, options) => app.shell!.approve!(command, signal, options) : undefined),
    offered: app.offeredTools,
  });
  if (app.closing) return;
  if (app.session) {
    if ((nextTools.length || app.runtimeTools.length) && !app.session.setTools) throw new Error("Runtime does not support custom capabilities");
    app.session.setTools?.(nextTools);
  }
  app.runtimeTools = nextTools;
  for (const tool of nextTools) app.offeredTools.add(tool.name);
}

export function delegateTool(app: CasperApp): RuntimeTool {
  // The child's usage joins the current task's totals (observations are replaced per task).
  app.delegateToolForTask ??= app.subagents.createTool(() => ({
    cwd: app.activeWorkspaceRoot(),
    projectContext: formatProjectContext(app.projectContext!),
  }), (usage) => app.observations.recordDelegatedUsage(usage));
  return app.delegateToolForTask;
}

export function browserSession(app: CasperApp): BrowserSession {
  if (!app.browser || app.browser.status().state === "closed") app.browser = new BrowserSession({
    projectRoot: app.activeWorkspaceRoot(), stateDirectory: app.projectContext!.stateDirectory,
    confirm: (request, signal) => app.sessionYes.approve("browser", `Browser action:\n${formatTerminalJSON(request)}\n`, "Allow this browser action?", signal),
  });
  // Capture the instance: the field is cleared after explicit closes (revoke, /clear),
  // but the registered close must still close the session it was registered for.
  const session = app.browser;
  app.lifecycle.add({ name: "browser", close: () => session.close() });
  return app.browser;
}

/** The session's service manager, created on first use for the active workspace's declared services. */
export function serviceManager(app: CasperApp): ServiceManager {
  if (!app.services || app.services.closed) {
    const services = app.services = new ServiceManager({ projectRoot: app.activeWorkspaceRoot(), services: app.projectContext!.services ?? {} });
    app.lifecycle.add({ name: "services", close: () => services.close() });
  }
  return app.services;
}

export async function stopDebugger(app: CasperApp): Promise<void> {
  await app.debugSession?.close();
  if (app.debugSession?.status().ownedProcessCleanup === "unknown") {
    throw new Error("Debugger process cleanup is unconfirmed. Inspect /debug and owned processes before starting more work; restarting does not prove cleanup.");
  }
}

/** /tasks: dev servers, the browser, the debugger, helpers and checks that run now, each with its own stop. */
export function backgroundTasks(app: CasperApp): BackgroundTask[] {
  const tasks: BackgroundTask[] = [];
  const services = app.services && !app.services.closed ? app.services : undefined;
  for (const service of services?.status() ?? []) {
    if (service.state !== "ready" && service.state !== "starting") continue;
    tasks.push({ kind: "dev server", name: service.name, ...(service.startedAt !== undefined ? { startedAt: service.startedAt } : {}),
      status: `${service.state === "ready" ? "running" : "starting"}${service.origin ? ` at ${service.origin}` : ""}${service.stale ? " · stale (restarts before next use)" : ""}`,
      stop: async () => await services!.stop(service.name) ? `Stopped ${service.name}.` : `${service.name} had already stopped.` });
  }
  const browser = app.browser;
  const browserState = browser?.status().state;
  if (browser && (browserState === "ready" || browserState === "starting")) {
    tasks.push({ kind: "browser", name: "for page checks", status: browserState === "ready" ? "open" : "starting",
      stop: async () => { await browser.close(); if (app.browser === browser) app.browser = undefined; return "Closed the browser."; } });
  }
  const debugState = app.debugSession?.status().state;
  if (app.debugSession && debugState && !["idle", "closing", "closed", "failed"].includes(debugState)) {
    tasks.push({ kind: "debugger", name: app.debugSession.status().target ?? "session", status: debugState,
      stop: async () => { await stopDebugger(app); return "Stopped the debugger."; } });
  }
  for (const run of app.subagents.runs()) {
    tasks.push({ kind: "helper", name: `${run.role}: ${run.goal}`, status: "running", startedAt: run.startedAt,
      stop: async () => app.subagents.cancelRun(run.id) ? `Stopped the ${run.role} helper.` : `The ${run.role} helper had already finished.` });
  }
  if (app.verificationWork) {
    tasks.push({ kind: "checks", name: "after the last change", status: "running",
      stop: async () => { app.verificationAbort?.abort(); return "Stopped the checks; the receipt says they did not finish."; } });
  }
  return tasks;
}

/** The page check for these changed files, from project facts only: undefined when this is not a web project,
 * pages are off, or no change reaches a page; a reason when the dev server can't be started (a missing install). */
export async function planPages(app: CasperApp, context: ProjectContext, changedPaths: readonly string[] | undefined): Promise<PageCheckPlan | undefined> {
  if (!changedPaths?.length || context.pages === "off") return undefined;
  try {
    return await planPageCheck(app.activeWorkspaceRoot(), { frameworks: context.model.frameworks, packageManager: context.model.packageManager,
      services: context.services ?? {} }, changedPaths, context.pages);
  } catch { return undefined; }
}

/** The receipt lines for pages that were not opened: why the dev server can't start, or pages that need a value. */
export function pageNotesFor(app: CasperApp, plan: PageCheckPlan | undefined): string[] | undefined {
  if (!plan) return undefined;
  if ("reason" in plan) return [formatPagesNotChecked(plan.reason)];
  return plan.pages.skipped.length ? plan.pages.skipped.map(formatSkippedPage) : undefined;
}

/** One page check against the dev server, timed as the `pages` phase. The pages are planned again from every
 * change since the task started, so a repair's edits count. Cancellation is reported by the loop. */
export function pageRun(app: CasperApp, task: NonNullable<CasperApp["pageTask"]>): (signal: AbortSignal) => Promise<PageReport | undefined> {
  return async (signal) => {
    const now = await app.snapshotWorkspace(task.root, signal);
    const plan = now ? await planPages(app, task.context, pagePaths(diffSnapshots(task.before, now))) : undefined;
    if (signal.aborted || !plan || !("service" in plan) || !plan.pages.open.length) return undefined;
    phase(app, "pages", "start");
    try {
      app.taskPageOpener ??= await app.pageOpenerFn({ projectRoot: task.root, stateDirectory: task.context.stateDirectory });
      app.events.ensureLineBreak();
      const checks = new PageChecks(() => serviceManager(app), plan.service, app.taskPageOpener, plan.pages,
        { announce: (line) => { if (!app.closing) app.output.write(`${terminalText(line)}\n`); }, notice: app.pageNotice });
      return await checks.run(signal);
    } catch (error) {
      if (signal.aborted) return undefined;
      const { name, label, spec } = plan.service;
      return { status: "incomplete", pages: [], skipped: plan.pages.skipped, server: { name, label, command: spec.command },
        reason: `Casper could not open the pages: ${redactPreview(error instanceof Error ? error.message : String(error)).slice(0, 300)}` };
    } finally { phase(app, "pages", "end"); }
  };
}

/** One smoke run against fresh services, timed as the `smoke` phase. Cancellation is reported by the loop. */
export function smokeRun(app: CasperApp, smoke: SmokeChecks): (signal: AbortSignal) => Promise<SmokeReport> {
  return async (signal) => {
    phase(app, "smoke", "start");
    try { return await smoke.run(signal); }
    catch (error) {
      if (signal.aborted) return { status: "incomplete", checks: [] };
      throw error;
    } finally { phase(app, "smoke", "end"); }
  };
}

/** The files a page check plans from: added and changed ones (a removed page is not opened). */
export function pagePaths(changes: TreeChanges): string[] { return [...changes.added, ...changes.modified].sort(); }
