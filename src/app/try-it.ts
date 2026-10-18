import path from "node:path";
import type { CasperApp } from "../app";
import { ProcessCleanupError } from "../platform/processes";
import type { ProjectContext } from "../project/context";
import type { ChildProject } from "../project/child";
import { planAppSmoke, runtimeChanges, type AppSmokeTarget } from "../services/detect";
import { requestApp, sameAppInputs, sameRuntimeInputs, tryApp, type AppSmokeReport } from "../services/try-it";
import { diffSnapshots } from "../task/changes";
import { redactPreview } from "../tui/format";
import type { VerificationReport } from "../verify/evidence";
import { phase } from "./footer";

function reuse(app: CasperApp, target: AppSmokeTarget, now: Map<string, string>, verification?: VerificationReport): AppSmokeReport | undefined {
  const base = { label: redactPreview(target.service.label), command: redactPreview(target.service.spec.command), path: redactPreview(target.path), cleanup: "not-started" as const, reused: true as const };
  const service = app.services?.status().find(service => service.name === target.service.name);
  const pages = verification?.pages;
  if (service?.command === target.service.spec.command && pages?.server.command === target.service.spec.command && sameRuntimeInputs(app.runtimeCheckInputs.get(pages), now)) {
    const page = pages.pages.find(page => page.path === target.path);
    if (page) return { ...base, status: page.status === "incomplete" ? "not-run" : page.status,
      ...(page.httpStatus !== null ? { httpStatus: page.httpStatus } : {}),
      ...(page.status !== "pass" ? { reason: redactPreview(page.reason ?? page.overlay ?? page.serverError ?? page.consoleErrors[0] ?? "the page failed its load check") } : {}) };
    if (pages.status === "incomplete") return { ...base, status: "not-run", reason: redactPreview(pages.reason ?? "the app could not start") };
  }
  const smoke = verification?.smoke;
  if (smoke && service?.command === target.service.spec.command
    && sameRuntimeInputs(app.runtimeCheckInputs.get(smoke), now)) {
    const check = smoke.checks.find(check => check.service === target.service.name && check.request.method === "GET" && check.request.path === target.path)
      ?? smoke.checks.find(check => check.service === target.service.name);
    // A matching response is evidence of a run, not proof that this task's behavior works.
    if (check) return { ...base, path: redactPreview(check.request.path), method: check.request.method, status: check.status === "incomplete" ? "not-run" : check.status,
      ...(check.actual ? { httpStatus: check.actual.status } : {}), ...(check.reason ? { reason: redactPreview(check.reason) } : {}) };
  }
  return undefined;
}

/** Stop only services started during this task, never /preview or a service intentionally up beforehand. */
async function stopAutomaticServices(app: CasperApp, preserve: ReadonlySet<string>): Promise<boolean> {
  const manager = app.services;
  if (!manager || manager.closed) return true;
  let confirmed = true;
  for (const service of manager.status()) {
    if (!app.automaticServices.has(service.name) || preserve.has(service.name) || manager.casperOnly(service.name)) continue;
    try { await manager.stop(service.name); }
    catch (error) {
      confirmed = false;
      if (error instanceof ProcessCleanupError) app.cleanupRecovery.queue(error);
    }
  }
  // Automatic servers no longer last for the session; the next start must announce its command again.
  app.pageNotice.shown = false;
  return confirmed;
}

export interface AppSmokeTask { context: ProjectContext; root: string; before?: Map<string, string>; child?: ChildProject }

/** Last runtime observation, after every model/review/repair edit and final command check. */
export async function finishAppSmoke(app: CasperApp, options: AppSmokeTask & {
  preserve: ReadonlySet<string>; verification?: VerificationReport; mode: "auto" | "offer" | "off"; signal?: AbortSignal }): Promise<AppSmokeReport | undefined> {
  let report: AppSmokeReport | undefined;
  let stopped = false;
  const signal = options.signal ?? app.commandAbort?.signal ?? new AbortController().signal;
  try {
    if (app.closing || signal.aborted || app.taskRuntimeCancelled || app.taskRuntimeFailed || app.checkTask?.signal.aborted
      || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined) return undefined;
    const now = await app.snapshotWorkspace(options.root, signal);
    const changes = options.before && now ? diffSnapshots(options.before, now) : undefined;
    const files = changes ? [...changes.added, ...changes.modified, ...changes.removed] : [];
    if (!runtimeChanges(files).length) return undefined;
    let context = await app.loadProjectContextFn(options.context.info);
    let root = options.root, relative = files;
    if (options.child) {
      root = options.child.dir;
      relative = files.map(file => path.relative(root, path.join(options.root, file)).split(path.sep).join("/"));
      context = await app.loadProjectContextFn({ ...context.info, cwd: root, root, name: options.child.model.project.name });
    }
    const plan = await planAppSmoke(root, { frameworks: context.model.frameworks, packageManager: context.model.packageManager, services: context.services }, relative, context.pages);
    if (!plan) return undefined;
    if (options.mode === "off" || context.pages === "off") return report = { status: "off", cleanup: "not-started", reason: options.mode === "off" ? "checks are off for this run" : "page checks are off" };
    if (options.mode === "offer") {
      app.offeredAppSmoke = { context: options.context, root: options.root, before: options.before, child: options.child };
      return report = { status: "not-run", deferred: true, cleanup: "not-started", reason: "/verify to try it" };
    }
    if ("reason" in plan) return report = { status: "not-run", cleanup: "not-started", reason: plan.reason };
    report = now && !options.child ? reuse(app, plan, now, options.verification) : undefined;
    const reused = Boolean(report);
    if (!reused) phase(app, "smoke", "start");
    try {
      // Free automatically owned fixed ports before a fresh launch. Never stop a pre-existing user service.
      const confirmed = await stopAutomaticServices(app, options.preserve);
      stopped = true;
      if (!confirmed) return report = { status: "not-run", cleanup: "unconfirmed", reason: "Casper could not confirm the previous app's processes stopped" };
      if (report) {
        const state = app.services?.status().find(service => service.name === plan.service.name)?.state;
        report.cleanup = state === "ready" ? "preserved" : state === "stopped" ? "stopped" : "not-started";
        const after = await app.snapshotWorkspace(options.root, signal);
        if (report.status === "pass" && !sameAppInputs(now, after)) {
          report.status = "not-run";
          report.reason = "files changed while stopping the app; the result does not cover the final files";
        }
        return report;
      }
      app.events.ensureLineBreak();
      app.output.write(`• Casper trying the app: ${redactPreview(plan.service.label)} · GET ${redactPreview(plan.path)}\n`);
      const running = app.services?.root === root && options.preserve.has(plan.service.name)
        && app.services.status().some(service => service.name === plan.service.name && service.state === "ready" && service.command === plan.service.spec.command);
      if (running) {
        report = { status: "not-run", label: redactPreview(plan.service.label), command: redactPreview(plan.service.spec.command), path: redactPreview(plan.path), method: "GET", cleanup: "not-started" };
        await app.services!.ensureFresh(plan.service.name, signal);
        Object.assign(report, { cleanup: "preserved" }, await requestApp(app.services!.origin(plan.service.name), plan.path, signal, plan.rootGuess));
      } else report = await tryApp(root, plan, signal, { onCleanupError: error => app.cleanupRecovery.queue(error) });
      const after = await app.snapshotWorkspace(options.root, signal);
      if (report.status === "pass" && !sameAppInputs(now, after)) {
        report.status = "not-run";
        report.reason = "files changed while trying the app; the result does not cover the final files";
      }
      return report;
    } finally { if (!reused) phase(app, "smoke", "end"); }
  } catch (error) {
    if (error instanceof ProcessCleanupError) app.cleanupRecovery.queue(error);
    return report = { ...report, status: "not-run", cleanup: error instanceof ProcessCleanupError ? "unconfirmed" : report?.cleanup ?? "not-started", reason: `Casper could not check the app: ${redactPreview(error instanceof Error ? error.message : String(error)).slice(0, 500)}` };
  } finally {
    if (!stopped && !await stopAutomaticServices(app, options.preserve) && report) {
      report.cleanup = "unconfirmed";
      if (report.status === "pass") report.status = "not-run";
      report.reason = [report.reason, "Casper could not confirm the app's processes stopped"].filter(Boolean).join("; ");
    }
  }
}
