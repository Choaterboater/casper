/** One uncached sweep of the selected project checks on the crew's combined, final tree. No model/repair turn. */
import type { CasperApp } from "../app";
import type { TaskResult } from "../task/result";
import { verificationStatus, type CheckName, type VerificationReport, type VerificationResult } from "../verify/evidence";
import { diffSnapshots } from "../task/changes";
import { selectedChecks } from "../verify/mode";
import { autoDetectedChecks } from "../verify/migrations-check";
import { withHostChecks } from "../verify/repair-loop";
import { phase } from "./footer";

function fullSelection(app: CasperApp): CheckName[] {
  const context = app.projectContext!;
  return [...new Set(selectedChecks(context.verification.checks, context.model.commands, context.model.namedChecks,
    autoDetectedChecks(context.model).map(check => check.name)))];
}

type SweepStart = { tree: Map<string, string>; revision: number };

export async function crewSweepStart(app: CasperApp): Promise<SweepStart | undefined> {
  if (!app.crewParts?.size || !app.taskEdits?.turnEnded) return;
  const tree = await app.snapshotWorkspace(app.activeWorkspaceRoot(), app.commandAbort?.signal);
  return tree ? { tree, revision: app.crewParts.revision } : undefined;
}

/** A real full batch already run by ordinary verification counts once, never a collection of per-part passes. */
export async function rememberCrewSweep(app: CasperApp, rounds: VerificationResult[][], before?: SweepStart): Promise<void> {
  if (!before || !app.crewParts?.size || before.revision !== app.crewParts.revision) return;
  const checks = fullSelection(app);
  const last = rounds.at(-1);
  if (!checks.length || !last || last.length !== checks.length
    || checks.some(name => !last.some(result => result.name === name && !result.testPhase && !result.reused && result.freshness !== "stale"))) return;
  // A later check may have invalidated an earlier entry in the historical round.
  const current = await app.checkTask!.refresh(app.commandAbort?.signal);
  if (checks.some(name => !current.some(result => result.name === name && result.freshness !== "stale"))) return;
  const tree = await app.snapshotWorkspace(app.activeWorkspaceRoot(), app.commandAbort?.signal);
  // Also covers unscoped checks: no batch that changed the project can certify its post-batch tree.
  if (tree && !Object.values(diffSnapshots(before.tree, tree)).some(paths => paths.length)) {
    app.crewSweep = { tree, revision: app.crewParts.revision, checks };
  }
}

function sweepStatus(results: VerificationResult[]): VerificationReport["status"] {
  const failures = results.filter(result => result.status === "fail" && result.kind !== "report");
  // Timeouts, spawn failures and sandbox refusals are unfinished checks, not failing code.
  if (failures.length && failures.every(result => result.ended && result.kind !== "lab")) return "incomplete";
  const status = verificationStatus(results);
  return status === "pass" && results.some(result => result.freshness === "stale") ? "incomplete" : status;
}

export async function finishCrewChecks(app: CasperApp, mode: TaskResult["verificationMode"], previous?: VerificationReport):
  Promise<{ verification?: VerificationReport; crewChecks?: TaskResult["crewChecks"] }> {
  if (!app.crewParts?.size) return { verification: previous };
  const notRun = (reason: string) => ({ verification: previous, crewChecks: { status: "not-run" as const, checks: [], reason } });
  if (app.closing || app.commandAbort?.signal.aborted || app.taskRuntimeCancelled || app.taskRuntimeFailed
    || app.checkTask?.signal.aborted || app.taskTurnLimit !== undefined || app.taskSpendStop !== undefined) return notRun("the task stopped");
  if (mode !== "auto" || !app.checkTask) return notRun(`verification is ${mode ?? "off"}`);
  // Respect the project's selection and automatic/manual split, but never prune for changed paths or prose.
  const checks = fullSelection(app);
  // Even an explicitly selected device check must not become an automatic device call.
  const automatic = checks.filter(name => app.checkTask!.kindOf(name) !== "lab");
  const earlier = app.crewSweep;
  const tree = earlier && earlier.revision === app.crewParts.revision && JSON.stringify(earlier.checks) === JSON.stringify(checks)
    ? await app.snapshotWorkspace(app.activeWorkspaceRoot(), app.commandAbort?.signal) : undefined;
  const same = earlier && tree && !Object.values(diffSnapshots(earlier.tree, tree)).some(paths => paths.length);
  if (same && previous && automatic.length === checks.length) return { verification: previous,
    crewChecks: { status: sweepStatus(previous.results.filter(result => checks.includes(result.name))), checks } };
  app.events.ensureLineBreak();
  app.output.write(`• Casper checking the crew's combined result: ${automatic.join(", ") || "no checks configured"}\n`);
  phase(app, "checks", "start");
  try {
    const before = tree ?? await app.snapshotWorkspace(app.activeWorkspaceRoot(), app.commandAbort?.signal);
    // Force an actual run even when earlier per-part/scoped passes still have matching inputs.
    await app.checkTask.run(automatic, app.commandAbort?.signal, { force: true, phase: "final" });
    const results = await app.checkTask.refresh(app.commandAbort?.signal);
    const final = results.filter(result => automatic.includes(result.name));
    const after = before && await app.snapshotWorkspace(app.activeWorkspaceRoot(), app.commandAbort?.signal);
    const changed = !before || !after || Object.values(diffSnapshots(before, after)).some(paths => paths.length);
    const incomplete = changed || final.length !== checks.length || final.some(result => result.freshness === "stale")
      || app.commandAbort?.signal.aborted || app.checkTask.signal.aborted;
    const status = sweepStatus(final);
    const crewStatus = status === "fail" ? "fail" : incomplete ? "incomplete" : status;
    const verification: VerificationReport = { ...previous, status: withHostChecks(
      crewStatus === "pass" ? sweepStatus(results) : crewStatus, results, previous?.smoke, previous?.pages),
      repairAttempts: previous?.repairAttempts ?? 0, results, rounds: [...app.checkTask.rounds] };
    return { verification, crewChecks: { status: crewStatus, checks: automatic,
      ...(changed ? { reason: "the combined files changed during the sweep or could not be compared" }
        : !automatic.length ? { reason: "no automatic project checks configured" }
        : automatic.length !== checks.length ? { reason: "device checks require your own /verify" } : {}) } };
  } finally { phase(app, "checks", "end"); }
}
