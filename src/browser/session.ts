import { createHash, randomUUID } from "node:crypto";
import { BrowserServer } from "./server";
import { readReferenceFile, referenceText } from "../references/files";
import { workspaceState } from "../verify/workspace-state";
import { parseScenario, viewport, type BrowserScenario, type BrowserCheck, type BrowserReport } from "./scenario";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "puppeteer-core";
import type { ArtifactDirectory } from "../visualize/artifacts";
import { isolatedEnvironment } from "../platform/environment";
import { discoverBrowser } from "./discovery";
import { ownSpawnedTree, type OwnedProcesses, ProcessCleanupError, terminateTree } from "../platform/processes";

export interface BrowserSessionOptions {
  projectRoot: string;
  stateDirectory: string;
  /** Host/user configuration only; never a model-supplied executable or profile. */
  executablePath?: string;
  confirm?: (request: BrowserApproval, signal: AbortSignal) => Promise<boolean>;
}
export interface BrowserApproval { action: string; url: string; selector: string; target: string; value?: string; reason: string; impact: string }
const INTERACTIONS = ["click", "fill", "press"];
const DANGEROUS = /\b(delete|remove|destroy|purchase|pay|checkout|buy|send|publish|deploy|sign.?in|log.?in|password|credit.?card)\b/i;
function localURL(source: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(source).hostname); } catch { return false; }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function text(value: unknown, label: string, limit = 2048): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid browser ${label}`);
  return value;
}
function webURL(value: unknown): string {
  const url = new URL(text(value, "URL"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser navigation requires an HTTP(S) URL without credentials");
  return url.href;
}

/** One task's disposable browser. No user profiles, arbitrary evaluation or browser installation. */
export class BrowserSession {
  private readonly controller = new AbortController();
  private browser?: Browser;
  private chromeOwner?: OwnedProcesses;
  private page?: Page;
  private startup?: Promise<Page>;
  private profile?: string;
  private work?: Promise<Record<string, unknown>>;
  private closeWork?: Promise<void>;
  private cleanupError?: ProcessCleanupError;
  private artifacts?: ArtifactDirectory;
  private server?: BrowserServer;
  private readonly runId = randomUUID();
  private screenshotCount = 0;
  private readonly logs: Array<{ type: string; text: string }> = [];
  private readonly requests: Array<{ url: string; status?: number; error?: string }> = [];
  private dropped = 0;
  private revision = 0;
  private operations = 0;
  private readonly scenarios = new Map<string, { scenario: BrowserScenario; check: BrowserCheck; fingerprint?: string; revision: number }>();
  constructor(private readonly options: BrowserSessionOptions) {}

  assertCleanup(): void { if (this.cleanupError) throw this.cleanupError; }

  status() { return { state: this.cleanupError ? "failed" : this.controller.signal.aborted ? "closed" : this.page ? "ready" : this.startup ? "starting" : "idle",
    ownedProcessCleanup: this.cleanupError ? "unknown" : undefined,
    runId: this.runId, screenshots: this.screenshotCount, ownedBrowserPid: this.browser?.process()?.pid }; }

  run(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.controller.signal.aborted) return Promise.reject(new Error("Browser session is closed"));
    if (this.work) return Promise.reject(new Error("Browser is busy; wait for the current operation"));
    if (++this.operations > 64) return Promise.reject(new Error("Browser operation limit reached (64 per session)"));
    const work = this.perform(input, signal);
    this.work = work;
    void work.finally(() => { if (this.work === work) this.work = undefined; }).catch(() => {});
    return work;
  }

  private async perform(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!record(input) || !["open", "inspect", "screenshot", "diagnostics", "viewport", "check", "replay", "serve", ...INTERACTIONS].includes(String(input.action))) throw new Error("Unknown browser action");
    if (Buffer.byteLength(JSON.stringify(input)) > 20_000) throw new Error("Browser arguments exceed 20 KiB");
    const interaction = INTERACTIONS.includes(String(input.action));
    const allowed = interaction ? ["action", "selector", "value", "impact", "reason"] : input.action === "open" ? ["action", "url"]
      : input.action === "serve" ? ["action", "script", "url", "impact", "reason"] : input.action === "check" ? ["action", "scenario"] : input.action === "replay" ? ["action", "id"] : input.action === "viewport" ? ["action", "width", "height"] : ["action"];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unexpected browser arguments");
    const url = input.action === "open" ? webURL(input.url) : undefined;
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    combined.throwIfAborted();
    const stop = () => { void this.close().catch(() => {}); };
    combined.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, input.action === "check" || input.action === "replay" ? 30_000 : 15_000);
    try {
      if (input.action === "check" || input.action === "replay") return await this.check(input, combined);
      if (input.action === "serve") return await this.serve(input, combined);
      if (input.action === "diagnostics") return { console: structuredClone(this.logs), network: structuredClone(this.requests), dropped: this.dropped,
        server: this.server?.diagnostics(), guidance: "Bounded diagnostics, not verification. URL queries/fragments are omitted; content may still be sensitive." };
      const page = url ? await this.start() : this.page;
      if (!page) throw new Error("Open a browser URL before inspecting it");
      combined.throwIfAborted();
      if (url) {
        this.logs.length = 0; this.requests.length = 0; this.dropped = 0;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
        combined.throwIfAborted();
        return { url: page.url(), title: (await page.title()).slice(0, 512) };
      }
      if (interaction) return await this.interact(input, combined);
      if (input.action === "viewport") { const size = viewport({ width: input.width, height: input.height }); await page.setViewport(size); return { viewport: size }; }
      if (input.action === "inspect") {
        const observation = await page.evaluate(() => ({ title: document.title.slice(0, 512),
          text: (document.body?.innerText ?? "").slice(0, 8000), url: location.href,
          viewport: { width: innerWidth, height: innerHeight }, width: document.documentElement.scrollWidth,
          elements: [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")].slice(0, 40).map(el => ({
            tag: el.tagName, id: el.id.slice(0, 128), name: (el.getAttribute("name") ?? "").slice(0, 128), type: el.getAttribute("type"),
            label: (el.getAttribute("aria-label") ?? el.textContent ?? "").slice(0, 128),
            selector: el.id ? `#${CSS.escape(el.id)}` : undefined,
          })) }));
        return observation;
      }
      if (this.screenshotCount >= 16) throw new Error("Browser screenshot limit reached (16 per session)");
      const bytes = await page.screenshot({ type: "png", fullPage: false });
      combined.throwIfAborted();
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("Browser screenshot exceeds 4 MiB");
      if (!this.artifacts) {
        const { ArtifactDirectory } = await import("../visualize/artifacts");
        this.artifacts = await ArtifactDirectory.open(path.join(this.options.stateDirectory, "browser", this.runId), this.options.projectRoot, () => combined.throwIfAborted());
      }
      await this.artifacts.assertCurrent();
      const name = `${++this.screenshotCount}.png`;
      const file = await this.artifacts.create(name);
      try { await file.writeFile(bytes); combined.throwIfAborted(); }
      catch (error) { this.artifacts.remove(name); throw error; }
      finally { await file.close(); }
      return { path: path.join(this.options.stateDirectory, "browser", this.runId, name), bytes: bytes.byteLength,
        url: page.url(), viewport: page.viewport(), guidance: "Use the native read tool on this PNG to view it. Capture alone is not verification or proof the model viewed it." };
    } finally { clearTimeout(timer); combined.removeEventListener("abort", stop); }
  }

  private async serve(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.server) throw new Error("Only one development server is allowed per browser session");
    if (input.script !== "dev" && input.script !== "start") throw new Error("Browser server script must be dev or start");
    if (!["local-test", "consequential", "uncertain"].includes(String(input.impact))) throw new Error("Server start requires explicit impact");
    const reason = text(input.reason, "reason", 512), url = webURL(input.url);
    if (!localURL(url)) throw new Error("Development server URL must be loopback");
    const source = referenceText(await readReferenceFile(path.join(this.options.projectRoot, "package.json"), 65_536));
    const manifest: unknown = JSON.parse(source);
    if (!record(manifest) || !record(manifest.scripts)) throw new Error("Project has no development scripts");
    const command = text(manifest.scripts[input.script], "development command", 2048);
    const risky = DANGEROUS.test(command) || /\b(install|add|npx|dlx|sudo|rm|curl|wget)\b/.test(command);
    if (input.impact !== "local-test" || risky) {
      if (!await this.options.confirm?.({ action: "serve", url, selector: `package.json scripts.${input.script}`, target: command, reason, impact: String(input.impact) }, signal)) throw new Error("Development command requires human approval; not started");
    }
    signal.throwIfAborted();
    const server = new BrowserServer(); this.server = server;
    try { return await server.start(command, this.options.projectRoot, url, signal); }
    catch (error) { await server.close(); this.server = undefined; throw error; }
  }

  invalidate(): void { this.revision++; }

  async report(): Promise<BrowserReport> {
    const checks: BrowserCheck[] = [];
    for (const entry of this.scenarios.values()) {
      const check = structuredClone(entry.check);
      if (entry.revision !== this.revision) { check.freshness = "stale"; check.reason = "Code/tool writes observed after this browser check."; }
      else if (entry.fingerprint) {
        const current = await workspaceState(this.options.projectRoot, entry.scenario.scope);
        if (!current.fingerprint) { check.freshness = "unavailable"; check.reason = current.reason; }
        else if (current.fingerprint !== entry.fingerprint) { check.freshness = "stale"; check.reason = "Declared local inputs changed after this browser check."; }
      }
      checks.push(check);
    }
    return { status: checks.some(check => check.status === "fail") ? "fail" : !checks.length || checks.some(check => check.status !== "pass" || check.freshness !== "fresh") ? "incomplete" : "pass",
      checks, guidance: "Only these browser assertions were checked. Freshness covers declared local inputs, not the server build, external services or all requested behavior. Screenshots and model claims are not acceptance. Run relevant repository checks too." };
  }

  private async check(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    let id: string;
    if (input.action === "check") {
      const scenario = parseScenario(input.scenario);
      if (this.scenarios.size >= 8) throw new Error("Browser scenario limit reached (8 per session)");
      id = randomUUID();
      this.scenarios.set(id, { scenario, revision: this.revision, check: { id, name: scenario.name,
        scenarioSha256: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"), url: scenario.url, viewport: scenario.viewport,
        status: "incomplete", baseline: "incomplete", freshness: "unavailable", scope: scenario.scope, assertions: [] } });
    } else {
      id = text(input.id, "scenario ID", 64);
      if (!this.scenarios.has(id)) throw new Error("Unknown browser scenario ID; record a check first");
    }
    const entry = this.scenarios.get(id)!;
    const { scenario } = entry;
    const check: BrowserCheck = { ...entry.check, status: "incomplete", freshness: "unavailable", assertions: [], reason: undefined };
    entry.check = check; entry.fingerprint = undefined; entry.revision = this.revision;
    try {
      const before = await workspaceState(this.options.projectRoot, scenario.scope, signal);
      await this.start(); signal.throwIfAborted();
      await this.page!.browserContext().close();
      const page = await this.newPage();
      this.logs.length = 0; this.requests.length = 0; this.dropped = 0;
      await page.setViewport(scenario.viewport);
      await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: 10_000 });
      for (const step of scenario.steps) { signal.throwIfAborted(); await this.interact({ ...step }, signal); }
      for (const assertion of scenario.assertions) {
        signal.throwIfAborted();
        const evaluate = () => page.evaluate(a => {
          if (a.kind === "no-horizontal-overflow") return { pass: document.documentElement.scrollWidth <= innerWidth, actual: { width: document.documentElement.scrollWidth, viewport: innerWidth } };
          const matches = document.querySelectorAll(a.selector);
          if (matches.length !== 1) return { pass: false, actual: `Expected one element; found ${matches.length}` };
          const el = matches[0]!;
          if (a.kind === "text") return { pass: (el.textContent ?? "").trim() === a.expected, actual: (el.textContent ?? "").trim().slice(0, 1024) };
          const r = el.getBoundingClientRect();
          const visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width > 0 && r.height > 0;
          if (a.kind === "visible") return { pass: visible, actual: visible };
          const other = document.querySelectorAll(a.other);
          if (other.length !== 1) return { pass: false, actual: `Expected one other element; found ${other.length}` };
          const b = other[0]!.getBoundingClientRect();
          const overlap = r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
          return { pass: visible && b.width > 0 && b.height > 0 && !overlap, actual: { overlap } };
        }, assertion);
        let result = await evaluate();
        const deadline = performance.now() + 1000;
        while (!result.pass && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); signal.throwIfAborted(); result = await evaluate(); }
        check.assertions.push({ kind: assertion.kind, status: result.pass ? "pass" : "fail", actual: result.actual });
      }
      check.status = check.assertions.every(a => a.status === "pass") ? "pass" : "fail";
      const after = await workspaceState(this.options.projectRoot, scenario.scope, signal);
      if (before.fingerprint && after.fingerprint && before.fingerprint === after.fingerprint && entry.revision === this.revision) {
        check.freshness = "fresh"; entry.fingerprint = after.fingerprint;
      } else { check.freshness = before.fingerprint && after.fingerprint ? "stale" : "unavailable"; check.reason = before.reason ?? after.reason ?? "Declared inputs changed during browser reproduction."; }
      if (input.action === "check") check.baseline = check.status;
      return structuredClone(check) as unknown as Record<string, unknown>;
    } catch (error) {
      check.status = "incomplete"; check.reason = "Browser reproduction did not finish; no passing evidence.";
      throw error;
    }
  }

  private async interact(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const selector = text(input.selector, "selector", 512);
    if (!["local-test", "consequential", "uncertain"].includes(String(input.impact))) throw new Error("Browser interaction requires explicit impact: local-test, consequential or uncertain");
    const reason = text(input.reason, "reason", 512);
    const action = String(input.action);
    const value = action === "click" ? undefined : text(input.value, "value", 1024);
    if (action === "click" && input.value !== undefined) throw new Error("Click does not accept a value");
    if (action === "press" && !["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space", "Backspace"].includes(value!)) throw new Error("Unsupported browser key");
    const page = this.page!;
    const describe = () => page.evaluate((selector) => {
      const matches = document.querySelectorAll(selector);
      if (matches.length !== 1) throw new Error("Browser selector must match exactly one element");
      const el = matches[0]!;
      return { url: location.href, tag: el.tagName, type: el.getAttribute("type") ?? "", autocomplete: el.getAttribute("autocomplete") ?? "",
        target: [el.getAttribute("aria-label"), el.textContent, el.getAttribute("name"), el.getAttribute("href")].filter(Boolean).join(" ").slice(0, 1024) };
    }, selector);
    const before = await describe();
    if (/^(password|file)$/i.test(before.type) || /password|one-time-code|cc-/i.test(before.autocomplete)) throw new Error("Credential, payment and file-upload inputs are outside this browser slice");
    if (action === "fill" && (before.tag !== "TEXTAREA" && (before.tag !== "INPUT" || !["", "text", "search", "tel", "url"].includes(before.type.toLowerCase())))) throw new Error("Fill requires a text/search/tel/url input or textarea");
    const automatic = input.impact === "local-test" && localURL(before.url) && !DANGEROUS.test(before.target);
    if (!automatic) {
      const approved = await this.options.confirm?.({ action, selector, url: before.url, target: before.target,
        ...(value === undefined ? {} : { value }), reason, impact: String(input.impact) }, signal);
      signal.throwIfAborted();
      if (!approved) throw new Error("Browser action requires human approval; not executed");
      if (JSON.stringify(await describe()) !== JSON.stringify(before)) throw new Error("Browser target changed during approval; inspect it again");
    }
    signal.throwIfAborted();
    const element = await page.$(selector);
    if (!element) throw new Error("Browser target disappeared");
    try {
      // No automatic retry after a potentially consequential action.
      if (action === "click") await element.click();
      else if (action === "press") await element.press(value as import("puppeteer-core").KeyInput);
      else {
        await element.focus();
        await element.evaluate(el => { if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select(); });
        await element.press("Backspace"); await element.type(value!);
      }
    } finally { await element.dispose(); }
    signal.throwIfAborted();
    return { action, url: page.url(), executed: true, guidance: "Action execution is not proof of the expected result. Inspect or replay assertions." };
  }

  private start(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return Promise.resolve(this.page);
    return this.startup ??= (async () => {
      const supplied = this.options.executablePath ?? process.env.CASPER_BROWSER_EXECUTABLE;
      const executablePath = await discoverBrowser(supplied);
      if (!executablePath || !path.isAbsolute(executablePath)) throw new Error("Browser unavailable: install Chrome yourself or set CASPER_BROWSER_EXECUTABLE to an absolute executable path");
      this.controller.signal.throwIfAborted();
      this.profile = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-")));
      const { default: puppeteer } = await import("puppeteer-core");
      this.controller.signal.throwIfAborted();
      this.browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, userDataDir: this.profile,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, signal: this.controller.signal, timeout: 10_000,
        env: isolatedEnvironment(this.profile, process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) });
      const chrome = this.browser.process();
      if (chrome) this.chromeOwner = ownSpawnedTree(chrome.pid, () => chrome.exitCode === null && chrome.signalCode === null);
      this.browser.on("disconnected", () => { if (!this.controller.signal.aborted) { this.invalidate(); void this.close(); } });
      this.controller.signal.throwIfAborted();
      return this.newPage();
    })();
  }
  private async newPage(): Promise<Page> {
      const context = await this.browser!.createBrowserContext({ downloadBehavior: { policy: "deny" } });
      this.page = await context.newPage();
      this.page.setDefaultTimeout(5000);
      await this.page.setViewport({ width: 1280, height: 800 });
      this.page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
      this.page.on("console", message => this.log({ type: message.type(), text: message.text().slice(0, 1024) }));
      this.page.on("pageerror", error => this.log({ type: "exception", text: String(error).slice(0, 1024) }));
      this.page.on("error", () => { this.invalidate(); void this.close(); });
      this.page.on("response", response => this.request(response.url(), { status: response.status() }));
      this.page.on("requestfailed", request => this.request(request.url(), { error: "Network request failed" }));
      return this.page;
  }
  private log(entry: { type: string; text: string }): void {
    if (this.logs.length >= 30) { this.logs.shift(); this.dropped++; } this.logs.push(entry);
  }
  private request(source: string, detail: { status?: number; error?: string }): void {
    if (this.requests.length >= 30) { this.requests.shift(); this.dropped++; }
    try { const url = new URL(source); this.requests.push({ url: `${url.origin}${url.pathname}`.slice(0, 512), ...detail }); } catch {}
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closeWork = Promise.resolve().then(() => this.finishClose()).catch(error => {
      if (error instanceof ProcessCleanupError) this.cleanupError = error;
      throw error;
    });
    // Disconnect/crash/abort can initiate cleanup outside an awaited command.
    // Keep the rejected result for close() callers without an unhandled rejection.
    void this.closeWork.catch(() => {});
    this.controller.abort();
    return this.closeWork;
  }
  private async finishClose(): Promise<void> {
    const serverClose = this.server?.close();
    void serverClose?.catch(() => {});
    // launch's lifetime signal closes partially started browsers too.
    await this.startup?.catch(() => {});
    const child = this.browser?.process();
    // Capture while the root still retains parentage, before graceful close can
    // orphan its descendants. Cleanup runs even when browser.close succeeds fast.
    await this.chromeOwner?.captureCurrent();
    const kill = () => terminateTree(this.chromeOwner, child?.pid, "SIGKILL");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.browser?.close().catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 200); }),
      ]);
    } finally { clearTimeout(timer); }
    const outcome = await kill();
    await this.work?.catch(() => {});
    if (outcome === "unknown") {
      await this.browser?.disconnect().catch(() => {});
      for (const stream of child?.stdio ?? []) stream?.destroy();
      child?.unref();
    }
    await this.artifacts?.close();
    await serverClose;
    if (outcome === "unknown") throw new ProcessCleanupError();
    if (this.profile) await rm(this.profile, { recursive: true, force: true });
  }
}
