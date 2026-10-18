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
  /** Offer mode deliberately leaves this observation for /verify, not an unfinished attempt. */
  deferred?: true;
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
    return Object.assign(report, await requestApp(manager.origin(name), target.path, signal, target.rootGuess));
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

/** One bounded GET, without starting, restarting or stopping the service that owns the origin.
 * When `/` is only a guess, a JSON 404/405 is an API answering that it has no page there: the app is up. */
export async function requestApp(origin: string | undefined, requestPath: string, signal: AbortSignal, rootGuess = false): Promise<Pick<AppSmokeReport, "status" | "httpStatus" | "reason">> {
  try {
    if (!origin) throw new Error("the app stopped before the request");
    const response = await fetch(new URL(requestPath, origin), { method: "GET", redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) });
    await response.body?.cancel();
    if (rootGuess && (response.status === 404 || response.status === 405) && /\bjson\b/i.test(response.headers.get("content-type") ?? ""))
      return { status: "pass", httpStatus: response.status, reason: "the API answered; it has no page at /" };
    const status = response.status >= 200 && response.status < 300 ? "pass" : "fail";
    return { status, httpStatus: response.status, ...(status === "fail" ? { reason: `HTTP ${response.status}, expected 2xx` } : {}) };
  } catch (error) {
    return { status: signal.aborted ? "not-run" : "fail", reason: `the request did not finish: ${message(error)}` };
  }
}

/** Files a running app writes as it works (its data store, logs), not code or configuration it loads.
 * Manifests, lockfiles and tool configs are inputs even though they are JSON. */
export function appDataFile(file: string): boolean {
  const name = file.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (/^(?:package|package-lock|composer|deno|bun|tsconfig.*|jsconfig.*|.*\.config|\..*rc|manifest|app|appsettings.*)\.jsonc?$/.test(name)) return false;
  return /\.(?:json|jsonl|ndjson|csv|log|db|sqlite3?|db-(?:wal|shm|journal)|sqlite3?-(?:wal|shm|journal))$/.test(name);
}

/** Like sameRuntimeInputs, but the app's own data writes during a smoke do not count as changed inputs. */
export function sameAppInputs(a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string> | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const code = (map: ReadonlyMap<string, string>) => new Map([...map].filter(([file]) => !appDataFile(file)));
  return sameRuntimeInputs(code(a), code(b));
}

/** Snapshot equality, not a tool's claim of freshness. Unknown inputs never reuse a result. */
export function sameRuntimeInputs(a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string> | undefined): boolean {
  return a !== undefined && b !== undefined && a.size === b.size && [...a].every(([file, hash]) => b.get(file) === hash);
}
