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
import { MetadataGuard, type Lookup } from "./metadata";
import { actionUsage, browserArguments, text, webURL, type BrowserAction } from "./arguments";
import { ownSpawnedTree, type OwnedProcesses, ProcessCleanupError, terminateTree } from "../platform/processes";

export interface BrowserSessionOptions {
  projectRoot: string;
  stateDirectory: string;
  /** Host/user configuration only; never a model-supplied executable or profile. */
  executablePath?: string;
  confirm?: (request: BrowserApproval, signal: AbortSignal) => Promise<boolean>;
  /** Page navigation deadline (default 10 s); a test seam, never model-supplied. */
  navigationTimeoutMs?: number;
  /**
   * Asked once before the AI's browser reaches a cloud metadata address (metadata.ts), by the page itself, a
   * redirect, a frame or a fetch. Without it nobody can say yes, and those addresses are not opened.
   */
  confirmMetadata?: (request: MetadataApproval, signal: AbortSignal) => Promise<boolean>;
  /** Browser clicks (browser_clicks, on unless turned off): every action runs without asking. Read at each action. */
  allowActions?: () => boolean;
  /** Test seams, never model-supplied: the metadata addresses and the name lookup. */
  metadataHosts?: readonly string[];
  lookup?: Lookup;
}
export interface MetadataApproval { address: string; url: string }
export interface BrowserApproval { action: string; url: string; selector: string; target: string; value?: string; reason: string; impact: string }
const INTERACTIONS = ["click", "fill", "press"];
const DANGEROUS = /\b(delete|remove|destroy|purchase|pay|checkout|buy|send|publish|deploy|sign.?in|log.?in|password|credit.?card)\b/i;
function localURL(source: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(source).hostname); } catch { return false; }
}
/** Whether a click, fill or press asks first: undefined runs it; `word` is the known label that held a local test.
 * With browser clicks on (allowAll), every action runs; off, only a local test on a local page without a known label does. */
export function actionHold(action: { impact: string; url: string; target: string; allowAll?: boolean }): { word?: string } | undefined {
  if (action.allowAll) return undefined;
  if (!localURL(action.url) || action.impact !== "local-test") return {};
  const word = DANGEROUS.exec(action.target)?.[0];
  return word ? { word } : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/** What one host page load saw. `failedRequests` holds every request that failed or answered 400 or more,
 * from any origin; the page check decides which ones count. */
export interface PageLoad {
  /** The main document's HTTP status; null when there was no response. */
  status: number | null;
  /** False for the HTTP-only fallback, which cannot see the console. */
  consoleChecked: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{ url: string; status?: number; error?: string }>;
  /** The first line of a framework error overlay or in-page exception. */
  overlay?: string;
  /** The same page at phone width. Absent for the HTTP-only fallback. */
  phone?: PhoneFit;
  /** Accessibility basics at desktop width. Absent for the HTTP-only fallback, or when the page could not be read. */
  a11y?: A11yFindings;
  /** Pictures of the visible page at desktop and phone width (PNG paths outside the project), when asked for and
   * they could be saved (not on Windows yet). */
  screenshots?: { desktop?: string; phone?: string };
}
/** Counts of common accessibility misses on a loaded page. They are notes for the person, never a failure. */
export interface A11yFindings {
  /** The page names its language (`<html lang>`). */
  lang: boolean;
  /** Visible images with no alt attribute (alt="" is fine: decoration). */
  images: number;
  /** Visible fields with no label, aria-label, aria-labelledby or title (a placeholder is not a label). */
  inputs: number;
  /** Visible buttons with no name: no text, aria-label, title, or alt/title inside. */
  buttons: number;
  /** Text items below 3:1 against their background, and the lowest ratio seen (0 when none). */
  contrast: { count: number; worst: number };
}
/** How a page fits a phone screen: its width against the screen's, and the text fields too squashed to show a line. */
export interface PhoneFit { viewport: number; pageWidth: number; squashed: string[] }
/** A common phone screen, in CSS pixels. */
const PHONE = { width: 390, height: 844 };
/** The page's visible text fields in document order: a name, the height, and whether a line of text fits inside. */
const FIELD_HEIGHTS = () => {
  const skip = ["hidden", "checkbox", "radio", "range", "color", "file", "submit", "button", "reset", "image"];
  return Array.from(document.querySelectorAll("input, textarea, select")).flatMap(element => {
    const field = element as HTMLElement;
    if (field instanceof HTMLInputElement && skip.includes(field.type)) return [];
    if (!field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return [];
    const box = field.getBoundingClientRect();
    // A visually hidden (screen-reader only) field is 1px on purpose.
    if (box.width <= 1 && box.height <= 1) return [];
    const style = getComputedStyle(field);
    const font = parseFloat(style.fontSize) || 16;
    const inner = { height: field.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      width: field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    const id = field.id ? `#${field.id}` : field.getAttribute("name") ? `[name="${field.getAttribute("name")}"]` : field.classList[0] ? `.${field.classList[0]}` : "";
    return [{ name: `${field.tagName.toLowerCase()}${id}`.slice(0, 80), height: Math.round(box.height), textFits: inner.height >= font * 0.8 && inner.width >= font * 2 }];
  });
};
/** Runs in the page: a few built-in accessibility rules (no third-party script). Bounded to the first 400 text items. */
const A11Y_NOTES = (): A11yFindings => {
  const visible = (element: Element) => (element as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  const text = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const labelledBy = (element: Element) => text((element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent ?? "").join(" "));
  const ariaName = (element: Element) => text(element.getAttribute("aria-label")) || labelledBy(element) || text(element.getAttribute("title"));
  const images = Array.from(document.querySelectorAll("img")).filter(image => visible(image) && !image.hasAttribute("alt")).length;
  const skip = ["hidden", "submit", "button", "reset", "image"];
  const inputs = Array.from(document.querySelectorAll("input, select, textarea")).filter(field => {
    if (field instanceof HTMLInputElement && skip.includes(field.type)) return false;
    if (!visible(field)) return false;
    const labels = (field as HTMLInputElement).labels;
    return !(labels && Array.from(labels).some(label => text(label.textContent))) && !ariaName(field);
  }).length;
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"]')).filter(button => {
    if (!visible(button)) return false;
    if (button instanceof HTMLInputElement) return !text(button.value) && !ariaName(button);
    const inner = Array.from(button.querySelectorAll("img[alt], svg title, [aria-label]"))
      .map(child => child.getAttribute("alt") ?? child.getAttribute("aria-label") ?? child.textContent).some(value => text(value));
    return !text((button as HTMLElement).innerText ?? button.textContent) && !ariaName(button) && !inner;
  }).length;
  let paint: OffscreenCanvasRenderingContext2D | null | undefined;
  /** A computed color as sRGB and alpha. Chrome keeps oklch(), lab() and color(display-p3 ...) as they are (Tailwind
   * v4's palette is oklch), so anything but rgb() is painted on one pixel and read back. */
  const rgba = (value: string): [number, number, number, number] | undefined => {
    const match = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+%?))?\)/.exec(value);
    if (match) {
      const alpha = match[4] === undefined ? 1 : match[4].endsWith("%") ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
      return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
    }
    paint ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    if (!paint) return undefined;
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "transparent";
    paint.fillStyle = value;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const luminance = ([r, g, b]: number[]) => {
    const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  };
  /** The color behind an element: the first painted background up the tree, else white; undefined over an image. */
  const background = (start: Element): number[] | undefined => {
    for (let element: Element | null = start; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.backgroundImage && style.backgroundImage !== "none") return undefined;
      const color = rgba(style.backgroundColor);
      if (color && color[3] > 0) return color[3] >= 1 ? color.slice(0, 3) : color.slice(0, 3).map(value => value * color[3] + 255 * (1 - color[3]));
    }
    return [255, 255, 255];
  };
  let count = 0, worst = 0, seen = 0;
  for (const element of Array.from(document.body?.querySelectorAll("*") ?? [])) {
    if (seen >= 400) break;
    if (!Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && text(node.textContent))) continue;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TITLE", "OPTION"].includes(element.tagName) || !visible(element)) continue;
    if ((element as HTMLButtonElement).disabled) continue;
    seen++;
    const style = getComputedStyle(element);
    const fore = rgba(style.color), back = background(element);
    if (!fore || !back) continue;
    const blended = fore.slice(0, 3).map((value, index) => value * fore[3] + back[index]! * (1 - fore[3]));
    const [high, low] = [luminance(blended), luminance(back)].sort((a, b) => b - a) as [number, number];
    const ratio = (high + 0.05) / (low + 0.05);
    if (ratio < 3) { count++; worst = worst === 0 ? ratio : Math.min(worst, ratio); }
  }
  return { lang: Boolean(text(document.documentElement.getAttribute("lang"))), images, inputs, buttons,
    contrast: { count, worst: Math.round(worst * 10) / 10 } };
};
const LOAD_LIMIT = 10;
/** Page checks save at most this many pictures per session: 5 pages, desktop and phone, a few rounds. */
const PAGE_PICTURE_LIMIT = 40;
const LOAD_TEXT = 300;

/** Fields fill types into, like a person would. Password and file stay out (checked before this). */
const TYPED_FIELDS = ["", "text", "search", "tel", "url", "email", "number"];
/** Fields a person sets through a picker: fill sets their value and fires input and change. */
const PICKED_FIELDS = ["date", "time", "datetime-local", "month", "week", "color", "range"];

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
  /** Page-check pictures taken this session (their own limit; the model's 16 screenshots are apart). */
  private pagePictures = 0;
  private readonly logs: Array<{ type: string; text: string }> = [];
  private readonly requests: Array<{ url: string; status?: number; error?: string }> = [];
  private dropped = 0;
  private revision = 0;
  private operations = 0;
  /** Host page loads: serialized, and the first one gets the longer first-compile deadline. */
  private loading: Promise<void> = Promise.resolve();
  private loads = 0;
  /** Page loads that took pictures, for their file names. */
  private pageLoads = 0;
  private readonly scenarios = new Map<string, { scenario: BrowserScenario; check: BrowserCheck; fingerprint?: string; revision: number }>();
  /** Metadata addresses the person said yes to for the action now running (a session yes is kept by confirmMetadata). */
  private readonly metadataAllowed = new Set<string>();
  private guard?: MetadataGuard;
  /** The running action's deadline, held while a question waits for the person. */
  private deadline?: { hold: () => void; resume: () => void };
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
    if (!record(input)) throw new Error("Browser arguments must be an object with an action");
    if (Buffer.byteLength(JSON.stringify(input)) > 20_000) throw new Error("Browser arguments exceed 20 KiB");
    const { args, ignored } = browserArguments(input);
    const result = await this.dispatch(args, signal);
    return ignored.length ? { ...result, ignoredArguments: ignored, note: `${actionUsage(args.action as BrowserAction)}; the other fields were not applied.` } : result;
  }

  private async dispatch(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const interaction = INTERACTIONS.includes(String(input.action));
    const url = input.action === "open" ? webURL(input.url) : undefined;
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    combined.throwIfAborted();
    const stop = () => { void this.close().catch(() => {}); };
    combined.addEventListener("abort", stop, { once: true });
    const limit = input.action === "check" || input.action === "replay" ? 30_000 : 15_000;
    let timer = setTimeout(stop, limit);
    this.deadline = { hold: () => clearTimeout(timer), resume: () => { clearTimeout(timer); timer = setTimeout(stop, limit); } };
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
        await this.askMetadata(url, combined);
        const notOpened = await this.navigate(page, url, combined);
        // Loaded again after a yes, the page can still report the error page it replaced for a moment: ask the page.
        const here = page.url().startsWith("chrome-error:") ? await page.evaluate(() => location.href).catch(() => page.url()) : page.url();
        return { url: here, title: (await page.title()).slice(0, 512), ...notOpened };
      }
      if (interaction) return { ...await this.interact(input, combined), ...await this.metadataAfter(page, combined) };
      // The page reached for a metadata address since the last action (a script, a timer): asked about here.
      const held = await this.metadataAfter(page, combined);
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
        return { ...observation, ...held };
      }
      if (this.screenshotCount >= 16) throw new Error("Browser screenshot limit reached (16 per session)");
      const bytes = await page.screenshot({ type: "png", fullPage: false });
      combined.throwIfAborted();
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("Browser screenshot exceeds 4 MiB");
      const saved = await this.savePicture(`${this.screenshotCount + 1}.png`, bytes, combined);
      this.screenshotCount++;
      return { path: saved, bytes: bytes.byteLength,
        url: page.url(), viewport: page.viewport(), guidance: "Use the native read tool on this PNG to view it. Capture alone is not verification or proof the model viewed it.", ...held };
    } finally { clearTimeout(timer); this.deadline = undefined; this.metadataAllowed.clear(); combined.removeEventListener("abort", stop); }
  }

  /** The person's answer for one metadata address; the action's deadline waits for it. No one to ask is a no. */
  private async metadataYes(address: string, url: string, signal: AbortSignal): Promise<boolean> {
    if (this.metadataAllowed.has(address)) return true;
    this.deadline?.hold();
    try {
      const yes = await this.options.confirmMetadata?.({ address, url }, signal) ?? false;
      signal.throwIfAborted();
      if (yes) this.metadataAllowed.add(address);
      return yes;
    } finally { this.deadline?.resume(); }
  }

  /** Before the AI's browser opens a URL itself: one question when it is a cloud metadata address. */
  private async askMetadata(url: string, signal: AbortSignal): Promise<void> {
    const address = await this.metadataGuard().address(url);
    if (address && !await this.metadataYes(address, url, signal)) {
      throw new Error(`Not opened: ${address} is a cloud metadata address, and the person said no (or nobody was there to ask)`);
    }
  }

  /** Opens a URL; a redirect or page part held back at a metadata address is asked about, then loaded again. */
  private async navigate(page: Page, url: string, signal: AbortSignal): Promise<{ notOpened?: string[]; note?: string }> {
    this.guard?.take();
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs ?? 10_000 }); }
    catch (error) { if (!this.guard?.blocked.some(entry => entry.mainFrame)) throw error; }
    signal.throwIfAborted();
    return this.metadataAfter(page, signal, url);
  }

  /**
   * What the page tried to reach at a metadata address while it loaded or acted: one question per address. On a yes
   * the page loads again (at the held-back address when the page itself went there); on a no it stays held back.
   */
  private async metadataAfter(page: Page, signal: AbortSignal, reload?: string): Promise<{ notOpened?: string[]; note?: string }> {
    const notOpened: string[] = [];
    for (let round = 0; round < 3; round++) {
      const blocked = this.guard?.take() ?? [];
      if (!blocked.length) break;
      let again: string | undefined;
      for (const address of [...new Set(blocked.map(entry => entry.address))]) {
        const first = blocked.find(entry => entry.address === address)!;
        const top = blocked.find(entry => entry.address === address && entry.mainFrame);
        if (!await this.metadataYes(address, first.url, signal)) { notOpened.push(address); continue; }
        again = top?.url ?? again ?? reload;
      }
      if (!again) break;
      try { await page.goto(again, { waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs ?? 10_000 }); }
      catch (error) { if (!this.guard?.blocked.some(entry => entry.mainFrame)) throw error; }
      signal.throwIfAborted();
    }
    return notOpened.length ? { notOpened: [...new Set(notOpened)], note: "Cloud metadata address not opened: the person said no, or nobody was there to ask." } : {};
  }

  private metadataGuard(): MetadataGuard {
    return this.guard ??= new MetadataGuard({ allowed: address => this.metadataAllowed.has(address), hosts: this.options.metadataHosts, lookup: this.options.lookup });
  }

  /** Saves a PNG in this run's folder outside the project (0700 folders, 0600 files); its full path. */
  private async savePicture(name: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    if (!this.artifacts) {
      const { ArtifactDirectory } = await import("../visualize/artifacts");
      this.artifacts = await ArtifactDirectory.open(path.join(this.options.stateDirectory, "browser", this.runId), this.options.projectRoot, () => signal.throwIfAborted());
    }
    await this.artifacts.assertCurrent();
    const file = await this.artifacts.create(name);
    try { await file.writeFile(bytes); signal.throwIfAborted(); }
    catch (error) { this.artifacts.remove(name); throw error; }
    finally { await file.close(); }
    return path.join(this.options.stateDirectory, "browser", this.runId, name);
  }

  /** A page check's picture of the visible page; undefined when it can't be taken or saved (never a failure). */
  private async pagePicture(page: Page, name: string, signal: AbortSignal): Promise<string | undefined> {
    if (this.pagePictures >= PAGE_PICTURE_LIMIT) return undefined;
    try {
      const { artifactFilesystemSupported } = await import("../visualize/artifacts");
      if (!artifactFilesystemSupported) return undefined;
      const bytes = await page.screenshot({ type: "png", fullPage: false });
      signal.throwIfAborted();
      if (bytes.byteLength > 4 * 1024 * 1024) return undefined;
      this.pagePictures++;
      return await this.savePicture(name, bytes, signal);
    } catch (error) {
      signal.throwIfAborted();
      return undefined;
    }
  }

  private async serve(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.server) throw new Error("Only one development server is allowed per browser session");
    if (input.script !== "dev" && input.script !== "start") throw new Error("Browser serve needs script: \"dev\" or \"start\" (a package.json script name)");
    if (!["local-test", "consequential", "uncertain"].includes(String(input.impact))) throw new Error("Browser serve needs impact: local-test, consequential or uncertain");
    const reason = text(input.reason, "reason", 512), url = webURL(input.url);
    if (!localURL(url)) throw new Error("Browser serve url must be a loopback address like http://127.0.0.1:3000");
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

  /**
   * Host-only page load for Casper's own page checks; it is not a browser tool action, so the model can never
   * call it, and it does not use the model's operation budget or logs. Opens a loopback URL in a fresh context,
   * waits for `load` and a short network quiet period, and returns what went wrong: console errors, uncaught
   * page errors, failed requests and the first line of a framework error overlay (Vite, Next.js, Streamlit).
   * Page text is diagnostic data, never instructions. One load runs at a time per session.
   */
  async load(url: string, signal?: AbortSignal, options: { settle?: "streamlit"; screenshots?: boolean } = {}): Promise<PageLoad> {
    const target = webURL(url);
    if (!localURL(target)) throw new Error("Page checks only open loopback addresses");
    if (this.controller.signal.aborted) throw new Error("Browser session is closed");
    const previous = this.loading;
    let release!: () => void;
    this.loading = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    const stop = () => { void this.close().catch(() => {}); };
    combined.addEventListener("abort", stop, { once: true });
    let context: import("puppeteer-core").BrowserContext | undefined;
    try {
      combined.throwIfAborted();
      await this.start();
      combined.throwIfAborted();
      context = await this.browser!.createBrowserContext({ downloadBehavior: { policy: "deny" } });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.setViewport({ width: 1280, height: 800 });
      const consoleErrors: string[] = [], pageErrors: string[] = [], failedRequests: PageLoad["failedRequests"] = [];
      const keep = (list: string[], entry: string) => { if (list.length < LOAD_LIMIT) list.push(entry.slice(0, LOAD_TEXT)); };
      page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
      // Resource failures are reported as requests (with their origin), not as console text.
      page.on("console", message => { if (message.type() === "error" && !/^Failed to load resource\b/.test(message.text())) keep(consoleErrors, message.text()); });
      page.on("pageerror", error => keep(pageErrors, error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
      const failed = (source: string, detail: { status?: number; error?: string }) => {
        if (failedRequests.length >= LOAD_LIMIT * 2) return;
        try { const address = new URL(source); failedRequests.push({ url: `${address.origin}${address.pathname}`.slice(0, 512), ...detail }); } catch {}
      };
      page.on("response", response => { if (response.status() >= 400) failed(response.url(), { status: response.status() }); });
      page.on("requestfailed", request => failed(request.url(), { error: (request.failure()?.errorText ?? "request failed").slice(0, 200) }));
      const timeout = this.options.navigationTimeoutMs ?? (this.loads++ === 0 ? 30_000 : 10_000);
      const response = await page.goto(target, { waitUntil: "load", timeout });
      combined.throwIfAborted();
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
      // Streamlit renders after the page loads, over a websocket: wait until its script run has finished.
      if (options.settle === "streamlit") await page.waitForSelector('[data-testid="stApp"][data-test-script-state="notRunning"]', { timeout: 10_000 }).catch(() => {});
      combined.throwIfAborted();
      const overlay = await page.evaluate(() => {
        const firstLine = (text: string | null | undefined) => (text ?? "").split("\n").map(line => line.trim()).find(Boolean);
        const within = (root: Document | ShadowRoot, selectors: string) => root.querySelector(selectors);
        const vite = document.querySelector("vite-error-overlay");
        if (vite) return firstLine((vite.shadowRoot?.querySelector(".message-body, .message") as HTMLElement | null)?.innerText ?? vite.textContent) ?? "error overlay";
        // Next.js keeps nextjs-portal on every dev page for its indicator; only an open error dialog counts.
        const portal = document.querySelector("nextjs-portal")?.shadowRoot;
        const dialog = within(document, "[data-nextjs-dialog]") ?? (portal ? within(portal, "[data-nextjs-dialog]") : null);
        if (dialog) {
          const description = dialog.querySelector("#nextjs__container_errors_desc, .nextjs__container_errors_desc, [data-nextjs-dialog-header] + *") as HTMLElement | null;
          return firstLine(description?.innerText ?? (dialog as HTMLElement).innerText) ?? "error overlay";
        }
        const streamlit = document.querySelector('[data-testid="stException"]') as HTMLElement | null;
        if (streamlit) return firstLine(streamlit.innerText) ?? "exception";
        return undefined;
      });
      // A picture of the page as a person sees it first, for the receipt and, when you allow it, the AI.
      const shot = options.screenshots ? ++this.pageLoads : 0;
      const desktopPicture = shot ? await this.pagePicture(page, `page-${shot}-desktop.png`, combined) : undefined;
      // Accessibility basics, at desktop width: notes for the person, never a failure. A page that can't be read gives none.
      const a11y = await page.evaluate(A11Y_NOTES).catch(() => undefined);
      // The same page on a phone: layouts that only break there (a column that squashes an input, a wide table)
      // never show at the desktop size above. Each text field is compared with its own desktop height.
      const desktop = await page.evaluate(FIELD_HEIGHTS);
      await page.setViewport(PHONE);
      await new Promise(resolve => setTimeout(resolve, 150));
      combined.throwIfAborted();
      const phoneHeights = await page.evaluate(FIELD_HEIGHTS);
      const squashed = phoneHeights.flatMap((field, index) => {
        const wide = desktop[index]?.name === field.name ? desktop[index]!.height : undefined;
        if (field.textFits && (wide === undefined || field.height >= wide * 0.6)) return [];
        return [`${field.name} (${field.height}px tall${wide !== undefined && wide > field.height ? `; ${wide}px on a wider screen` : ""})`];
      }).slice(0, 5);
      const phone = { viewport: PHONE.width, pageWidth: await page.evaluate(() => Math.round(document.documentElement.scrollWidth)), squashed };
      const phonePicture = shot ? await this.pagePicture(page, `page-${shot}-phone.png`, combined) : undefined;
      const screenshots = { ...(desktopPicture ? { desktop: desktopPicture } : {}), ...(phonePicture ? { phone: phonePicture } : {}) };
      return { status: response?.status() ?? null, consoleChecked: true, consoleErrors, pageErrors, failedRequests,
        ...(overlay ? { overlay: overlay.slice(0, LOAD_TEXT) } : {}), phone, ...(a11y ? { a11y } : {}), ...(desktopPicture || phonePicture ? { screenshots } : {}) };
    } finally {
      combined.removeEventListener("abort", stop);
      await context?.close().catch(() => {});
      release();
    }
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
      await this.askMetadata(scenario.url, signal);
      if (this.scenarios.size >= 8) throw new Error("Browser scenario limit reached (8 per session)");
      id = randomUUID();
      this.scenarios.set(id, { scenario, revision: this.revision, check: { id, name: scenario.name,
        scenarioSha256: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"), url: scenario.url, viewport: scenario.viewport,
        status: "incomplete", baseline: "incomplete", freshness: "unavailable", scope: scenario.scope, assertions: [] } });
    } else {
      id = text(input.id, "id", 64);
      if (!this.scenarios.has(id)) throw new Error("Unknown browser check id; replay an id a check returned in this session, or record a check first");
      await this.askMetadata(this.scenarios.get(id)!.scenario.url, signal);
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
      const notOpened = await this.navigate(page, scenario.url, signal);
      if (notOpened.notOpened) throw new Error(`The page reached for a cloud metadata address (${notOpened.notOpened.join(", ")}) and the person said no`);
      for (const step of scenario.steps) {
        signal.throwIfAborted(); await this.interact({ ...step }, signal);
        const after = await this.metadataAfter(page, signal);
        if (after.notOpened) throw new Error(`The page reached for a cloud metadata address (${after.notOpened.join(", ")}) and the person said no`);
      }
      for (const assertion of scenario.assertions) {
        signal.throwIfAborted();
        const evaluate = () => page.evaluate(a => {
          if (a.kind === "no-horizontal-overflow" && !a.selector) return { pass: document.documentElement.scrollWidth <= innerWidth, actual: { width: document.documentElement.scrollWidth, viewport: innerWidth } };
          const matches = document.querySelectorAll(a.selector!);
          if (matches.length !== 1) return { pass: false, actual: `Expected one element; found ${matches.length}` };
          const el = matches[0]!;
          const r = el.getBoundingClientRect();
          // One element: content wider than the box (a table cut off behind a scroller), or the box past the viewport.
          if (a.kind === "no-horizontal-overflow") return { pass: el.scrollWidth <= el.clientWidth + 1 && r.right <= innerWidth + 1,
            actual: { contentWidth: el.scrollWidth, boxWidth: el.clientWidth, right: Math.round(r.right), viewport: innerWidth } };
          if (a.kind === "text") return { pass: (el.textContent ?? "").trim() === a.expected, actual: (el.textContent ?? "").trim().slice(0, 1024) };
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
    if (!["local-test", "consequential", "uncertain"].includes(String(input.impact))) throw new Error(`Browser ${String(input.action)} needs impact: local-test, consequential or uncertain`);
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
    const type = before.type.toLowerCase();
    if (action === "fill" && before.tag !== "TEXTAREA" && (before.tag !== "INPUT" || !(TYPED_FIELDS.includes(type) || PICKED_FIELDS.includes(type)))) {
      throw new Error(`Fill takes a textarea or an input of type ${[...TYPED_FIELDS.filter(Boolean), ...PICKED_FIELDS].join(", ")}`);
    }
    const hold = actionHold({ impact: String(input.impact), url: before.url, target: before.target, allowAll: this.options.allowActions?.() });
    if (hold) {
      const approved = await this.options.confirm?.({ action, selector, url: before.url, target: before.target,
        ...(value === undefined ? {} : { value }), reason, impact: String(input.impact) }, signal);
      signal.throwIfAborted();
      if (!approved) throw new Error(`Browser action requires human approval; not executed. ${!localURL(before.url) ? "It is on a page that is not on this computer."
        : hold.word ? `Its label has "${hold.word}", so it asks even as a local test; other local-test actions on this page run without asking.`
        : "It is not marked local-test."} Browser clicks are off (/settings), and a run that can't ask says no.`);
      if (JSON.stringify(await describe()) !== JSON.stringify(before)) throw new Error("Browser target changed during approval; inspect it again");
    }
    signal.throwIfAborted();
    const element = await page.$(selector);
    if (!element) throw new Error("Browser target disappeared");
    try {
      // No automatic retry after a potentially consequential action.
      if (action === "click") await element.click();
      else if (action === "press") await element.press(value as import("puppeteer-core").KeyInput);
      else if (before.tag === "INPUT" && PICKED_FIELDS.includes(type)) {
        // A date, time, color or range field is set by its picker, not by keystrokes: set the value as the picker would.
        const set = await element.evaluate((el, next) => {
          const input = el as HTMLInputElement;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
          input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
          return input.value;
        }, value!);
        if (set !== value) throw new Error(`The ${type} field did not take ${JSON.stringify(value!.slice(0, 40))}; it holds ${JSON.stringify(set.slice(0, 40))}`);
      } else {
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
      const cdp = await this.page.createCDPSession();
      await this.metadataGuard().attach({ send: (method, params) => cdp.send(method as never, params as never), on: (event, handler) => cdp.on(event as never, handler) });
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
