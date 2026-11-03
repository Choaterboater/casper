import { ManagedProcessError } from "../platform/managed-process";
import { ProcessCleanupError } from "../platform/processes";
import { redactPreview } from "../tui/format";
import type { AppSmokeTarget } from "./detect";
import { ServiceManager } from "./manager";
import { appDataFile, settingsFile } from "./app-data";

export { appDataFile };

/** One completion observation, never proof that the requested behavior works. */
export interface AppSmokeReport {
  status: "pass" | "fail" | "not-run" | "off";
  label?: string;
  command?: string;
  path?: string;
  method?: string;
  httpStatus?: number;
  /** Where a redirect within the app led (`/login`): the status is that page's. */
  redirectedTo?: string;
  reason?: string;
  cleanup: "stopped" | "not-started" | "preserved" | "unconfirmed";
  reused?: true;
  /** Offer mode deliberately leaves this observation for /verify, not an unfinished attempt. */
  deferred?: true;
  /** Nothing in the folder starts the app (no command or service): a note, not an unfinished attempt. */
  nothingToStart?: true;
  /** The start command ended with exit code 0 within EXITED_EARLY_MS, before serving: not checked, rather than unfinished. */
  exitedEarly?: true;
}
/** How soon a clean exit counts as a start command that ended before serving. */
const EXITED_EARLY_MS = 5_000;

export const APP_SMOKE_START_MS = 15_000;
const REQUEST_MS = 10_000;
/** Redirects followed within the app before the smoke gives up (decision 67). */
const MAX_REDIRECTS = 5;
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
    const startedAt = performance.now();
    try {
      signal.throwIfAborted();
      await manager.start(name, signal);
      started = true;
    } catch (error) {
      const took = performance.now() - startedAt;
      if (!signal.aborted && error instanceof ManagedProcessError && error.reason === "exited" && /\(exit code 0\)/.test(error.message) && took < EXITED_EARLY_MS) {
        report.exitedEarly = true;
        report.reason = `the start command exited before serving (exit code 0 after ${(took / 1000).toFixed(1)} s)`;
        return report;
      }
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

/** One bounded GET, without starting, restarting or stopping the service that owns the origin. A redirect within the
 * app (a signed-out visitor sent from / to /login) is followed, at most MAX_REDIRECTS hops, and the page it leads to is
 * judged; one to another origin, a loop or too many hops fails (decision 67).
 * When `/` is only a guess, a JSON 404/405 is an API answering that it has no page there: the app is up. */
export async function requestApp(origin: string | undefined, requestPath: string, signal: AbortSignal, rootGuess = false): Promise<Pick<AppSmokeReport, "status" | "httpStatus" | "reason" | "redirectedTo">> {
  try {
    if (!origin) throw new Error("the app stopped before the request");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);
    let url = new URL(requestPath, origin);
    const seen = [url.href];
    let response: Response;
    for (let hops = 0; ; hops++) {
      response = await fetch(url, { method: "GET", redirect: "manual", signal: deadline });
      await response.body?.cancel();
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) break;
      const next = new URL(location, url);
      const shown = (target: URL) => redactPreview(target.origin === url.origin ? `${target.pathname}${target.search}` : target.href);
      if (next.origin !== url.origin) return { status: "fail", httpStatus: response.status, reason: `it redirects off the app, to ${shown(next)}` };
      if (seen.includes(next.href)) return { status: "fail", httpStatus: response.status, reason: `it redirects in a loop (${shown(url)} → ${shown(next)})` };
      if (hops >= MAX_REDIRECTS - 1) return { status: "fail", httpStatus: response.status, reason: `it redirects more than ${MAX_REDIRECTS} times` };
      seen.push(next.href);
      url = next;
    }
    const redirect = seen.length > 1 ? { redirectedTo: redactPreview(`${url.pathname}${url.search}`) } : {};
    if (rootGuess && !redirect.redirectedTo && (response.status === 404 || response.status === 405) && /\bjson\b/i.test(response.headers.get("content-type") ?? ""))
      return { status: "pass", httpStatus: response.status, reason: "the API answered; it has no page at /" };
    const status = response.status >= 200 && response.status < 300 ? "pass" : "fail";
    return { status, httpStatus: response.status, ...redirect, ...(status === "fail" ? { reason: `HTTP ${response.status}, expected 2xx` } : {}) };
  } catch (error) {
    return { status: signal.aborted ? "not-run" : "fail", reason: `the request did not finish: ${message(error)}` };
  }
}

/** Like sameRuntimeInputs, but the app's own data writes during a smoke do not count as changed inputs. */
export function sameAppInputs(a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string> | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  // The app's own writes as it runs: its data and logs, and the settings it creates or saves (config/*.yaml).
  const code = (map: ReadonlyMap<string, string>) => new Map([...map].filter(([file]) => !appDataFile(file) && !settingsFile(file)));
  return sameRuntimeInputs(code(a), code(b));
}

/** Snapshot equality, not a tool's claim of freshness. Unknown inputs never reuse a result. */
export function sameRuntimeInputs(a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string> | undefined): boolean {
  return a !== undefined && b !== undefined && a.size === b.size && [...a].every(([file, hash]) => b.get(file) === hash);
}
