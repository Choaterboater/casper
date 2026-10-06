import { discoverBrowser } from "../browser/discovery";
import { BrowserSession, type PageLoad } from "../browser/session";
import { ManagedProcessError } from "../platform/managed-process";
import { scrubText } from "../secrets/scrub";
import { terminalText } from "../tui/format";
import type { ServiceSpec } from "./config";
import { detectWebService, isDetectedWebService, type DetectedWebService, type DetectInput } from "./detect";
import type { ServiceManager } from "./manager";
import { changedPages, type PagePlan, type PagesSetting } from "./pages";
import { a11yNotes, formatOpeningLine, formatServerLine, pageStatus, type PageReport, type PageResult, type PageStatus } from "./page-report";

export * from "./page-report";

export type { PageLoad } from "../browser/session";

/** Opens one page and says what went wrong. Tests use a fake; Casper uses Chrome, or plain HTTP without it. */
export interface PageOpener {
  /** False for the HTTP-only fallback: it sees the status, never the console. */
  readonly consoleChecked: boolean;
  load(url: string, signal: AbortSignal, options?: { settle?: "streamlit"; screenshots?: boolean }): Promise<PageLoad>;
  close(): Promise<void>;
}

/** Shared across the session's tasks, so the dev-server lines are printed once. */
export interface DevServerNotice { shown: boolean }

const TAIL_LINES = 12;
const TAIL_CHARS = 2048;
const ERROR_TEXT = 300;

/** Page and log text may echo tokens or device secrets: they are hidden before the text is kept anywhere.
 * Like redactPreview, but a secret word needs `=` or `:` after it, because "Unexpected token (3:4)" is an
 * ordinary error the user needs to read. */
const hide = (text: string) => terminalText(scrubText(text).text)
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
  .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, "$1 <redacted>")
  .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w-]*)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&,)]+)/gi, "$1<redacted>")
  .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_\w{8,}|github_pat_\w{8,}|AKIA[A-Z0-9]{16}|xox[abprs]-[\w-]{8,})\b/g, "<redacted>");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\nLog tail:")[0]!.slice(0, 500);

/** The text a log ring gained between two reads, even after the ring dropped its oldest bytes. */
function appended(before: string, after: string): string {
  if (after.startsWith(before)) return after.slice(before.length);
  const anchor = before.slice(-256);
  const at = anchor ? after.lastIndexOf(anchor) : -1;
  return at >= 0 ? after.slice(at + anchor.length) : after;
}

/** The exception line of the last Python traceback in a log ("KeyError: 'site'"). Streamlit shows app
 * exceptions in the page, not the console, and logs them on the server as a traceback. */
export function serverTraceback(log: string): string | undefined {
  const lines = log.split(/\r?\n/);
  let found: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    if (!/Traceback \(most recent call last\):/.test(lines[index]!)) continue;
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next]!;
      if (line.trim() && !/^\s/.test(line) && !/^(Traceback|During handling|The above exception)/.test(line)) { found = line.trim(); index = next; break; }
    }
  }
  return found?.slice(0, ERROR_TEXT);
}

/**
 * Casper's host-run page check (costs no model tokens): starts or reuses the dev server through the
 * ServiceManager (a detected server gets its own session-long slot), opens each planned page with the
 * opener, and reports what each page showed. A server that does not start makes the check incomplete,
 * never a pass. A pass means the page loads; it never means the change works.
 */
export class PageChecks {
  constructor(private readonly manager: () => ServiceManager, private readonly service: DetectedWebService,
    private readonly opener: PageOpener, private readonly pages: PagePlan | (() => PagePlan),
    private readonly options: { announce?: (line: string) => void; notice?: DevServerNotice;
      /** Save a desktop and a phone picture of each page (no tokens). Unset: on. */
      screenshots?: boolean } = {}) {}

  plan(): PagePlan { return typeof this.pages === "function" ? this.pages() : this.pages; }

  async run(signal: AbortSignal): Promise<PageReport> {
    const plan = this.plan();
    const { name, spec, label } = this.service;
    const server: PageReport["server"] = { name, label, command: spec.command };
    const base = { pages: [] as PageResult[], skipped: plan.skipped, server };
    if (!plan.open.length) return { status: "incomplete", ...base, reason: "no changed page to open" };
    const manager = this.manager();
    const notice = this.options.notice ?? { shown: false };
    let restarted: boolean;
    try {
      const before = manager.ensureSlot(name, spec);
      if (!notice.shown && before.state !== "ready") this.options.announce?.(`… Starting dev server: ${label} (it runs your project's code)`);
      ({ restarted } = await manager.ensureFresh(name, signal));
    } catch (error) {
      signal.throwIfAborted();
      const status = manager.status().find(entry => entry.name === name);
      const tail = (status?.tail ?? (error instanceof ManagedProcessError ? error.tail : "")).split("\n").filter(Boolean).slice(-TAIL_LINES).join("\n");
      return { status: "incomplete", ...base, reason: startFailure(error, spec, status?.exit?.code),
        ...(tail ? { logTail: hide(tail).slice(-TAIL_CHARS) } : {}) };
    }
    const origin = manager.origin(name);
    if (!origin) return { status: "incomplete", ...base, reason: "the dev server is not ready" };
    server.origin = origin;
    if (restarted) server.restarted = true;
    if (!notice.shown) { notice.shown = true; this.options.announce?.(formatServerLine(label, origin)); }
    this.options.announce?.(formatOpeningLine(plan.open));

    const streamlit = this.service.frameworks.includes("streamlit");
    const pages: PageResult[] = [];
    for (const page of plan.open) {
      signal.throwIfAborted();
      const logBefore = manager.logs(name).text;
      let load: PageLoad;
      try { load = await this.opener.load(new URL(page, origin).href, signal, { ...(streamlit ? { settle: "streamlit" as const } : {}), screenshots: this.options.screenshots ?? true }); }
      catch (error) {
        signal.throwIfAborted();
        pages.push({ path: page, status: "incomplete", httpStatus: null, consoleChecked: this.opener.consoleChecked, consoleErrors: [], failedRequests: [],
          reason: `it did not finish loading: ${hide(message(error))}` });
        continue;
      }
      const logged = streamlit ? serverTraceback(appended(logBefore, manager.logs(name).text)) : undefined;
      pages.push(judge(page, origin, load, logged));
    }
    const report: PageReport = { status: pageStatus(pages), ...base, pages };
    // A dev server tree Casper could not confirm stopped may still answer beside the new one.
    try { manager.assertCleanup(); }
    catch { return { ...report, status: report.status === "fail" ? "fail" : "incomplete", reason: "Casper could not confirm the old dev server's processes were stopped" }; }
    return report;
  }
}

function startFailure(error: unknown, spec: ServiceSpec, code: number | null | undefined): string {
  if (error instanceof ManagedProcessError && error.reason === "exited") return `the dev server stopped before it was ready (exit ${code ?? "unknown"})`;
  if (error instanceof ManagedProcessError && error.reason === "timeout") {
    return `the dev server didn't answer on its port within ${Math.round(spec.timeoutMs / 1000)} s. Tell Casper how to start it: services.web in .casper/project.yaml`;
  }
  return `the dev server did not start: ${hide(message(error))}`;
}

function judge(path: string, origin: string, load: PageLoad, serverError: string | undefined): PageResult {
  const self = new URL(path, origin);
  const failedRequests = load.failedRequests.filter(request => {
    try {
      const address = new URL(request.url);
      if (address.origin !== origin || address.pathname === self.pathname) return false;
    } catch { return false; }
    return request.error !== undefined || (request.status ?? 0) >= 500;
  }).slice(0, 10);
  const consoleErrors = [...load.pageErrors, ...load.consoleErrors].slice(0, 10).map(text => hide(text).slice(0, ERROR_TEXT));
  const result: PageResult = { path, status: "pass", httpStatus: load.status, consoleChecked: load.consoleChecked, consoleErrors, failedRequests,
    ...(load.overlay ? { overlay: hide(load.overlay).slice(0, ERROR_TEXT) } : {}), ...(serverError ? { serverError: hide(serverError) } : {}),
    ...(load.screenshots && (load.screenshots.desktop || load.screenshots.phone) ? { screenshots: { ...load.screenshots } } : {}) };
  if (load.status === null) return { ...result, status: "incomplete", reason: "it did not answer" };
  // Accessibility notes ride along; they never change the page's status.
  const notes = load.a11y ? a11yNotes(load.a11y) : [];
  if (notes.length) result.a11y = notes;
  if (load.phone) {
    result.phoneChecked = true;
    const { viewport, pageWidth, squashed } = load.phone;
    if (pageWidth > viewport + 1 || squashed.length) result.phone = { viewport, pageWidth, squashed: squashed.map(name => hide(name).slice(0, 80)) };
  }
  const failed = result.overlay !== undefined || result.serverError !== undefined || load.status >= 400 || consoleErrors.length > 0 || failedRequests.length > 0
    || result.phone !== undefined;
  return failed ? { ...result, status: "fail" } : result;
}

/** Chrome for page loads, one disposable session per task. */
export class BrowserPageOpener implements PageOpener {
  readonly consoleChecked = true;
  constructor(private readonly session: BrowserSession) {}
  load(url: string, signal: AbortSignal, options?: { settle?: "streamlit"; screenshots?: boolean }): Promise<PageLoad> { return this.session.load(url, signal, options); }
  close(): Promise<void> { return this.session.close(); }
}

const HTTP_TIMEOUT_MS = { first: 30_000, later: 10_000 };
/** Without Chrome: a GET that sees only the status. Redirects are followed on the same origin only. */
export class HttpPageOpener implements PageOpener {
  readonly consoleChecked = false;
  private loads = 0;
  async load(url: string, signal: AbortSignal): Promise<PageLoad> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.loads++ === 0 ? HTTP_TIMEOUT_MS.first : HTTP_TIMEOUT_MS.later)]);
    let target = new URL(url);
    for (let hop = 0; hop < 5; hop++) {
      const response = await fetch(target, { redirect: "manual", signal: deadline, headers: { accept: "text/html" } });
      await response.body?.cancel();
      const location = response.headers.get("location");
      const next = response.status >= 300 && response.status < 400 && location ? new URL(location, target) : undefined;
      if (!next || next.origin !== target.origin) return { status: response.status, consoleChecked: false, consoleErrors: [], pageErrors: [], failedRequests: [] };
      target = next;
    }
    return { status: null, consoleChecked: false, consoleErrors: [], pageErrors: [], failedRequests: [] };
  }
  async close(): Promise<void> {}
}

/** Chrome when one is installed (or CASPER_BROWSER_EXECUTABLE is set), else the HTTP-only fallback. Never downloads a browser. */
export async function pageOpener(options: { projectRoot: string; stateDirectory: string; executablePath?: string }): Promise<PageOpener> {
  const executablePath = await discoverBrowser(options.executablePath ?? process.env.CASPER_BROWSER_EXECUTABLE);
  if (!executablePath) return new HttpPageOpener();
  return new BrowserPageOpener(new BrowserSession({ projectRoot: options.projectRoot, stateDirectory: options.stateDirectory, executablePath }));
}

/** What a page check would do for these changes, decided only by project facts (never the prompt). */
export type PageCheckPlan = { service: DetectedWebService; pages: PagePlan } | { reason: string };

/**
 * Plans the page check: undefined when this is not a web project, pages are off, or no change
 * reaches a page; a reason when it is a web project Casper cannot start (a missing install).
 */
export async function planPageCheck(root: string, input: DetectInput, changedPaths: readonly string[], configured?: PagesSetting): Promise<PageCheckPlan | undefined> {
  if (configured === "off" || !changedPaths.length) return undefined;
  const detected = await detectWebService(root, input);
  if (!detected) return undefined;
  const pages = changedPages(detected.frameworks, changedPaths, configured);
  if (!pages.open.length && !pages.skipped.length) return undefined;
  return isDetectedWebService(detected) ? { service: detected, pages } : { reason: detected.reason };
}
