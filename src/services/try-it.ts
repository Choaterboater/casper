import { ManagedProcessError } from "../platform/managed-process";
import { ProcessCleanupError } from "../platform/processes";
import { redactPreview } from "../tui/format";
import type { AppSmokeTarget } from "./detect";
import { ServiceManager } from "./manager";

/** One completion observation, never proof that the requested behavior works. */
export interface AppSmokeReport {
  status: "pass" | "fail" | "not-run" | "off";
  label?: string;
  command?: string;
  path?: string;
  method?: string;
  httpStatus?: number;
  reason?: string;
  cleanup: "stopped" | "not-started" | "preserved" | "unconfirmed";
  reused?: true;
}

export const APP_SMOKE_START_MS = 15_000;
const REQUEST_MS = 10_000;
const message = (error: unknown) => redactPreview((error instanceof Error ? error.message : String(error)).split("\nLog tail:")[0]!).slice(0, 500);

/** A private service owner: start, one GET, check its status, stop the entire owned tree in finally.
 * Readiness polling is not a smoke check. No browser, suite, crawl, installer or repair round is started. */
export async function tryApp(root: string, target: AppSmokeTarget, signal: AbortSignal,
  options: { manager?: ServiceManager; onCleanupError?: (error: ProcessCleanupError) => void } = {}): Promise<AppSmokeReport> {
  const { name, label, spec } = target.service;
  const manager = options.manager ?? new ServiceManager({ projectRoot: root,
    services: { [name]: { ...spec, timeoutMs: Math.min(spec.timeoutMs, APP_SMOKE_START_MS) } } });
  const report: AppSmokeReport = { status: "not-run", label: redactPreview(label), command: redactPreview(spec.command), path: redactPreview(target.path), method: "GET", cleanup: "not-started" };
  let started = false;
  try {
    try {
      signal.throwIfAborted();
      await manager.start(name, signal);
      started = true;
    } catch (error) {
      report.reason = signal.aborted ? "cancelled before the app was ready"
        : error instanceof ManagedProcessError && error.reason === "timeout" ? `the app did not become ready within ${Math.min(spec.timeoutMs, APP_SMOKE_START_MS) / 1000} s`
        : `the app could not start: ${message(error)}`;
      return report;
    }
    try {
      const origin = manager.origin(name);
      if (!origin) throw new Error("the app stopped before the request");
      const response = await fetch(new URL(target.path, origin), { method: "GET", redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) });
      await response.body?.cancel();
      report.httpStatus = response.status;
      report.status = response.status >= 200 && response.status < 300 ? "pass" : "fail";
      if (report.status === "fail") report.reason = `HTTP ${response.status}, expected 2xx`;
    } catch (error) {
      report.status = signal.aborted ? "not-run" : "fail";
      report.reason = `the request did not finish: ${message(error)}`;
    }
    return report;
  } finally {
    try {
      await manager.close();
      manager.assertCleanup();
      // A failed startup is cleaned up by the same owner too.
      report.cleanup = started || manager.status().some(service => service.state !== "idle") ? "stopped" : "not-started";
    } catch (error) {
      if (error instanceof ProcessCleanupError) options.onCleanupError?.(error);
      report.cleanup = "unconfirmed";
      if (report.status === "pass") report.status = "not-run";
      report.reason = [report.reason, "Casper could not confirm the app's processes stopped"].filter(Boolean).join("; ");
    }
  }
}

/** Snapshot equality, not a tool's claim of freshness. Unknown inputs never reuse a result. */
export function sameRuntimeInputs(a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string> | undefined): boolean {
  return a !== undefined && b !== undefined && a.size === b.size && [...a].every(([file, hash]) => b.get(file) === hash);
}
