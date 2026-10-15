/** Uncertain teardown is a recoverable incident, not a session-wide command lock. */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CasperApp } from "../app";
import { ProcessCleanupError, type CleanupOutcome } from "../platform/processes";
import type { CleanupReport } from "../task/result";
import { cleanupReceiptLines } from "../task/result";
import { lineText, redactPreview } from "../tui/format";

// Structural compatibility with older embedders' ownerless cleanup errors.
type RecoverableError = ProcessCleanupError & {
  running?: () => Promise<CleanupReport["processes"]>;
  stop?: () => Promise<CleanupOutcome>;
};

export class CleanupRecovery {
  private readonly pending = new Set<RecoverableError>();
  private readonly acknowledged = new WeakSet<ProcessCleanupError>();
  private readonly gates = new WeakMap<object, ProcessCleanupError>();

  get hasPending(): boolean { return this.pending.size > 0; }

  queue(error: ProcessCleanupError = new ProcessCleanupError()): void {
    if (!this.acknowledged.has(error)) this.pending.add(error);
  }

  /** Owners retain an incident's error identity; a different error is a new incident. */
  preflight(source: { assertCleanup(): void }): void {
    try { source.assertCleanup(); this.gates.delete(source); }
    catch (error) {
      if (!(error instanceof ProcessCleanupError)) throw error;
      if (this.gates.get(source) !== error) { this.queue(error); this.gates.set(source, error); }
    }
  }

  async resolve(app: CasperApp): Promise<void> {
    if (!this.pending.size) return;
    const errors = [...this.pending];
    this.pending.clear();
    // A cancelled picker, failed retry or repeated teardown must never ask about this incident again.
    for (const error of errors) this.acknowledged.add(error);
    const running = async (error: RecoverableError) => {
      try {
        if (!error.running) return { known: false, processes: [] };
        const processes = await Promise.all((await error.running()).map(async process => ({ ...process,
          command: lineText(redactPreview((await app.scrubber.scrubText(process.command)).text)) })));
        return { known: true, processes };
      } catch { return { known: false, processes: [] }; }
    };
    const before = await Promise.all(errors.map(running));
    app.events.ensureLineBreak();
    app.output.write("Owned process cleanup is unconfirmed.\n");
    for (const { processes } of before) {
      for (const process of processes) {
        const line = `PID ${process.pid} · ${process.command}`;
        const columns = app.terminal.columns;
        app.output.write(`${columns ? truncateToWidth(line, Math.max(1, columns - 1), "…") : line}\n`);
      }
    }
    if (before.every(({ processes }) => !processes.length)) app.output.write("Live process details are unavailable; cleanup is still unconfirmed.\n");
    const unattended = !app.interactive || !app.terminal.canAsk || app.onEvent !== undefined;
    let choice: string | undefined;
    if (!unattended && !app.closing) {
      // Do not reuse an aborted task signal: recovery must remain answerable after task cancellation.
      try {
        choice = await app.terminal.pick("Processes may still be running", [
          { label: "Stop them" }, { label: "Leave them running" },
        ]);
      } catch { /* A closed/unavailable picker leaves an unconfirmed receipt, never a command lock. */ }
    }
    const reports: CleanupReport[] = [];
    for (const [index, error] of errors.entries()) {
      let state: CleanupReport["state"] = choice === "Leave them running" ? "left-running" : "unconfirmed";
      let processes = before[index]!.processes;
      if (choice === "Stop them") {
        let outcome: CleanupOutcome = "unknown";
        try { outcome = await error.stop?.() ?? "unknown"; } catch { /* report uncertainty, never reprompt */ }
        const after = await running(error);
        if (outcome === "stopped" && after.known && !after.processes.length) { state = "stopped"; }
        else if (after.processes.length) processes = after.processes;
      }
      error.acknowledge();
      reports.push({ state, processes, ...(unattended ? { unattended: true as const } : {}) });
    }
    app.cleanupReports.push(...reports);
    for (const line of cleanupReceiptLines(reports)) app.output.write(`${line}\n`);
  }
}

/** Drain independent task owners even if one teardown is uncertain. Preserve unrelated failures. */
export async function finishTaskCleanup(app: CasperApp, closeBrowser: boolean): Promise<void> {
  let failure: unknown;
  const opener = app.taskPageOpener;
  app.taskPageOpener = undefined;
  for (const close of [() => app.checkTask?.close(), ...(closeBrowser ? [() => app.browser?.close()] : []),
    () => opener?.close().catch(error => { if (error instanceof ProcessCleanupError) throw error; })]) {
    try { await close(); }
    catch (error) {
      if (error instanceof ProcessCleanupError) app.cleanupRecovery.queue(error);
      else failure ??= error;
    }
  }
  await app.cleanupRecovery.resolve(app);
  if (failure) throw failure;
}
