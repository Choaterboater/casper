import { createHash, randomUUID } from "node:crypto";
import { BrowserServer, SlotServer } from "./server";
import { StaticServer } from "./static-server";
import type { ServiceManager } from "../services/manager";
import { readReferenceFile, referenceText } from "../references/files";
import { type InputState, workspaceState } from "../verify/workspace-state";
import { parseScenario, scopeOf, viewport, type BrowserScenario, type BrowserCheck, type BrowserReport, type BrowserStep } from "./scenario";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import type { ArtifactDirectory } from "../visualize/artifacts";
import { isolatedEnvironment } from "../platform/environment";
import { discoverBrowser } from "./discovery";
import { MetadataGuard, type Lookup } from "./metadata";
import { actionUsage, browserArguments, text, webURL, type BrowserAction } from "./arguments";
import { ownSpawnedTree, type OwnedProcesses, ProcessCleanupError, terminateTree } from "../platform/processes";

/** A screenshot result's picture (base64 PNG), under a key JSON leaves out, so the browser tool can send it as an image. */
export const SCREENSHOT_PNG = Symbol("screenshot png");

export interface BrowserSessionOptions {
  projectRoot: string;
  stateDirectory: string;
  /** Host/user configuration only; never a model-supplied executable or profile. */
  executablePath?: string;
  confirm?: (request: BrowserApproval, signal: AbortSignal) => Promise<boolean>;
  /** Page navigation deadline (default 10 s); a test seam, never model-supplied. */
  navigationTimeoutMs?: number;
  /** How long a first Chrome start may take before one fresh start replaces it (default 8 s); a test seam. */
  firstStartMs?: number;
  /**
   * Asked once before the AI's browser reaches a cloud metadata address (metadata.ts), by the page itself, a
   * redirect, a frame or a fetch. Without it nobody can say yes, and those addresses are not opened.
   */
  confirmMetadata?: (request: MetadataApproval, signal: AbortSignal) => Promise<boolean>;
  /** Whether a check or replay sends the final page's picture (showPages: off turns it off). Read at each check; unset: yes. */
  checkPictures?: () => boolean;
  /** Browser clicks (browser_clicks, on unless turned off): every action runs without asking. Read at each action. */
  allowActions?: () => boolean;
  /** The session's services: serve then runs in the same slot as Casper's page checks (one owner for the dev server). */
  services?: () => ServiceManager;
  /** Test seams, never model-supplied: the metadata addresses and the name lookup. */
  metadataHosts?: readonly string[];
  lookup?: Lookup;
}
/** The ServiceManager slot of the dev server Casper found for page checks (detect.ts names it so too). */
const DEV_SLOT = "web";
export interface MetadataApproval { address: string; url: string }
export interface BrowserApproval { action: string; url: string; selector: string; target: string; value?: string; reason: string; impact: string }
const INTERACTIONS = ["click", "fill", "press", "select"];
const DANGEROUS = /\b(delete|remove|destroy|purchase|pay|checkout|buy|send|publish|deploy|sign.?in|log.?in|password|credit.?card)\b/i;
function localURL(source: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(source).hostname); } catch { return false; }
}
/** Whether starting a package.json dev or start script asks first. With browser clicks on (allowAll) only a script
 * that runs a download through a shell or uses sudo asks, as Claude Code's auto mode also stops those; off, any
 * effect other than local-test and any obvious risky command asks. */
export function serveHolds(script: { command: string; impact: string; allowAll?: boolean }): boolean {
  if (script.allowAll) return /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(script.command) || /\bsudo\b/.test(script.command);
  return script.impact !== "local-test" || DANGEROUS.test(script.command) || /\b(install|add|npx|dlx|sudo|rm|curl|wget)\b/.test(script.command);
}

/** Whether a click, fill, press or select asks first: undefined runs it; `word` is the known label that held a local test.
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
/** How a page check opens a page. `light`: a page the changed one links to, only checked to answer without errors and
 * show something; `choices`: with `light`, the choices the link's query made, to check the page shows them as chosen. */
export interface PageLoadOptions { settle?: "streamlit"; screenshots?: boolean; light?: boolean; choices?: Array<[string, string]> }
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
  /** Exact facts about the look: images and drawn pictures (art) at desktop width, then (at phone width) what runs past the screen and small tap targets. */
  look?: LookFacts;
  /** What makes the page feel wrong to use: developer text, layout jumps, a focus ring on load, a huge phone footer, controls under a fixed layer. */
  feel?: FeelFacts;
  /** Pictures of the page at desktop (the whole page, up to 4000 px) and phone width (the visible screen) (PNG paths outside the project), when asked for and
   * they could be saved (not on Windows yet). */
  screenshots?: { desktop?: string; phone?: string };
  /** Same-origin paths the page links to that are safe to open with a GET (see `followableLinks`), up to 20. Absent in a light load. */
  links?: string[];
  /** Same-origin links whose query makes a choice (`/book?staff=ana-sousa`, see `choiceLinks`), up to 20. Absent in a light load. */
  choiceLinks?: string[];
  /** A light load only: the page shows nothing (no text, picture or control). */
  blank?: boolean;
  /** A light load given `choices` only: the chosen values the page does not show as chosen. */
  unchosen?: string[];
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
  /** Text items below WCAG AA against their background (4.5:1, or 3:1 for large text), the lowest ratio seen
   * (0 when none) and that pair's colors ("#bbbbbb on #ffffff"). */
  contrast: { count: number; worst: number; colors?: string };
}
/** Facts a person would see wrong on the page. Notes, never a failure. */
export interface LookFacts {
  /** Visible images that did not load, by src. */
  brokenImages: string[];
  /** One image src on two or more items of a repeated group (cards, list items). */
  repeatedImages: Array<{ src: string; items: number }>;
  /** At phone width, the first elements whose right edge runs past the screen. */
  overflow: string[];
  /** At phone width, links, buttons and inputs smaller than 44x44 px, and the first few. */
  smallTargets: { count: number; names: string[] };
  /** Drawn pictures at desktop width: inline `<svg>` and same-origin `.svg` images. */
  art: ArtFacts;
}
/** What a hand-drawn SVG gets wrong, each list naming the first few (`svg#hero`, `/img/bean.svg`). A rich
 * illustration (many shapes, gradients, words such as a gauge's numbers) is never a fault. */
export interface ArtFacts {
  /** Pictures at least 48 px each way with no `viewBox`, so they don't scale. */
  noViewBox: string[];
  /** Inline pictures with no `<title>`, `aria-label` or `aria-labelledby`, not hidden with `aria-hidden` and not inside
   * a link, button or label (whose own words name it). */
  noName: string[];
  /** Inline icons (under 64 px each way) whose colors stay the same when the page itself turns dark (only checked when it does). */
  fixedColors: string[];
  /** The same for icon files shown with `<img>`, which the page's CSS can't reach. */
  fixedFiles: string[];
}
/** What a person using the page would feel is wrong. Notes, never a failure. Lists name the first 3. */
export interface FeelFacts {
  /** At desktop width, developer or broken text people can see ("[object Object]", a UUID, "1 bags"), quoted and cut to 30 characters. */
  devText: string[];
  /** At desktop width, how far the layout jumped while loading (CLS, its largest window), what moved and the images with no size. */
  shift: { score: number; moved: string[]; unsized: string[] };
  /** At desktop width, a page region (main, the heading, a big box) drawn with a focus ring as the page opens. */
  focusRing?: string;
  /** At phone width, the page footer's height when it is over half the screen. */
  footer?: number;
  /** At phone width, controls a fixed or sticky layer covers at the top or the bottom of the page: `button "Pay" (under div.toast)`. */
  covered: string[];
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
  const hex = (color: number[]) => `#${color.map(value => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
  let count = 0, worst = 0, seen = 0, colors = "";
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
    // WCAG AA: large text is 24px, or 18.66px (14pt) bold.
    const size = parseFloat(style.fontSize) || 16, large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio >= (large ? 3 : 4.5)) continue;
    count++;
    if (worst === 0 || ratio < worst) { worst = ratio; colors = `${hex(blended)} on ${hex(back)}`; }
  }
  return { lang: Boolean(text(document.documentElement.getAttribute("lang"))), images, inputs, buttons,
    // Floored, so text just below AA never prints as passing (4.48:1 shows as 4.4, not 4.5).
    contrast: { count, worst: Math.floor(worst * 10) / 10, ...(count ? { colors } : {}) } };
};
/** Runs in the page: images at any width; at phone width, what runs past the screen's right edge and small tap targets. */
const LOOK_FACTS = (phone: boolean): Omit<LookFacts, "art"> => {
  const visible = (element: Element) => (element as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  const words = (element: Element) => ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  const name = (element: Element) => {
    const tag = element.tagName.toLowerCase(), label = words(element).slice(0, 20);
    return (element.id ? `${tag}#${element.id}` : element.classList[0] ? `${tag}.${element.classList[0]}` : label ? `${tag} "${label}"` : tag).slice(0, 60);
  };
  const source = (value: string) => {
    try { const address = new URL(value); return (address.origin === location.origin ? address.pathname : `${address.origin}${address.pathname}`).slice(0, 120); }
    catch { return value.slice(0, 120); }
  };
  const images = Array.from(document.images).filter(image => visible(image) && image.getAttribute("src"));
  const brokenImages = [...new Set(images.filter(image => image.complete && image.naturalWidth === 0).map(image => source(image.src)))].slice(0, 5);
  // A repeated group: siblings with the same tag and class, each a list item, an article or with a class (plain boxes
  // like a header and a footer logo are not items). Each picture (icons left out) counts once per item.
  const shape = (element: Element) => `${element.tagName}.${element.getAttribute("class") ?? ""}`;
  const itemLike = (element: Element) => ["LI", "ARTICLE"].includes(element.tagName) || Boolean(element.getAttribute("class")?.trim());
  const groups = new Map<Element, Map<string, Set<Element>>>();
  for (const image of images) {
    const box = image.getBoundingClientRect();
    if (box.width < 48 || box.height < 48 || image.naturalWidth === 0) continue;
    for (let item: Element = image; item.parentElement && item.parentElement !== document.documentElement; item = item.parentElement) {
      const parent = item.parentElement;
      if (!itemLike(item) || Array.from(parent.children).filter(child => shape(child) === shape(item)).length < 2) continue;
      const bySource = groups.get(parent) ?? new Map<string, Set<Element>>();
      groups.set(parent, bySource);
      const src = source(image.currentSrc || image.src);
      bySource.set(src, (bySource.get(src) ?? new Set()).add(item));
      break;
    }
  }
  const repeatedImages = Array.from(groups.values()).flatMap(bySource => Array.from(bySource, ([src, items]) => ({ src, items: items.size })))
    .filter(entry => entry.items >= 2).sort((a, b) => b.items - a.items).slice(0, 3);
  if (!phone) return { brokenImages, repeatedImages, overflow: [], smallTargets: { count: 0, names: [] } };
  const width = document.documentElement.clientWidth;
  // Inside a box that scrolls or clips sideways on purpose (a carousel) is not past the screen.
  const clipped = (element: Element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) if (getComputedStyle(parent).overflowX !== "visible") return true;
    return false;
  };
  const overflow: string[] = [], named: Element[] = [];
  for (const element of Array.from(document.body?.querySelectorAll("*") ?? [])) {
    if (overflow.length >= 3) break;
    const box = element.getBoundingClientRect();
    // A drawer parked off screen (left at or past the edge) is hidden on purpose.
    if (box.width === 0 || box.right <= width + 1 || box.left >= width || !visible(element) || clipped(element)) continue;
    if (named.some(outer => outer.contains(element))) continue;
    named.push(element); overflow.push(name(element));
  }
  const small = Array.from(document.querySelectorAll('a[href], button, input, [role="button"]')).filter(target => {
    if (target instanceof HTMLInputElement && target.type === "hidden") return false;
    if (!visible(target)) return false;
    const box = target.getBoundingClientRect();
    if (box.width === 0 || (box.width >= 44 && box.height >= 44)) return false;
    // A link inside a sentence (words of its own right beside it, not a menu's spaces or "|") and a box with its own
    // label are exempt, as in WCAG's target-size rule.
    const sentence = Array.from(target.parentElement?.childNodes ?? [])
      .some(node => node.nodeType === Node.TEXT_NODE && /[\p{L}\p{N}]/u.test(node.textContent ?? ""));
    if (target.tagName === "A" && getComputedStyle(target).display === "inline" && sentence) return false;
    if (target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type) && target.labels?.length) return false;
    return true;
  });
  return { brokenImages, repeatedImages, overflow, smallTargets: { count: small.length, names: small.slice(0, 3).map(name) } };
};
/** One drawn picture as read in the page: an inline one by its place among the page's top-level `<svg>`s, a file by its
 * own dark-mode rule. `big` is at least 48 px each way, `icon` under 64. */
interface ArtItem { name: string; big: boolean; icon: boolean; viewBox: boolean; named: boolean; index?: number; fixedInFile?: boolean }
/** Runs in the page: the background and each top-level `<svg>`'s colors (fill, stroke, gradient stops); unless only
 * colors are asked for, the drawn pictures too (at most 40 inline and 10 same-origin files of up to 256 KB). */
const ART_FACTS = async (colorsOnly: boolean): Promise<{ background: string; colors: string[]; items: ArtItem[] }> => {
  const shapes = "path, rect, circle, ellipse, line, polyline, polygon";
  const blank = (color: string) => /^(none|transparent|rgba\(0, 0, 0, 0\))$/.test(color);
  const background = [document.body, document.documentElement].map(element => element ? getComputedStyle(element).backgroundColor : "")
    .find(color => color && !blank(color)) ?? "";
  const inline = Array.from(document.querySelectorAll("svg")).filter(svg => !svg.parentElement?.closest("svg"));
  const colors = inline.map(svg => Array.from(svg.querySelectorAll(`${shapes}, text, stop`)).slice(0, 300).flatMap(element => {
    const style = getComputedStyle(element);
    return element.tagName === "stop" ? [style.stopColor] : [style.fill, style.stroke];
  }).filter(color => !blank(color)).join(" "));
  const items: ArtItem[] = [];
  if (colorsOnly) return { background, colors, items };
  /** Its size when it shows, else undefined. */
  const size = (element: Element) => {
    const box = element.getBoundingClientRect();
    const shown = box.width > 0 && box.height > 0 && ((element as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
    return shown ? { big: box.width >= 48 && box.height >= 48, icon: box.width < 64 && box.height < 64 } : undefined;
  };
  inline.forEach((svg, index) => {
    const shown = size(svg);
    if (items.length >= 40 || !shown) return;
    const title = svg.querySelector(":scope > title")?.textContent?.trim();
    const name = svg.id ? `svg#${svg.id}` : svg.classList[0] ? `svg.${svg.classList[0]}` : title ? `svg "${title.slice(0, 20)}"` : `svg no. ${index + 1}`;
    const role = svg.getAttribute("role");
    // A link, button or label is named by its own words (the accessibility check notes one that has none).
    const named = Boolean(title || svg.getAttribute("aria-label")?.trim() || svg.getAttribute("aria-labelledby")?.trim())
      || Boolean(svg.closest('[aria-hidden="true"], a[href], button, label, summary, [role="button"], [role="link"]')) || role === "presentation" || role === "none";
    items.push({ name: name.slice(0, 60), ...shown, viewBox: svg.hasAttribute("viewBox"), named, index });
  });
  const address = (image: HTMLImageElement) => new URL(image.currentSrc || image.src, location.href);
  // An image that didn't load is already a broken image (and a failed request): it is not read again.
  const files = Array.from(document.images).filter(image => size(image) && !(image.complete && image.naturalWidth === 0)
    && address(image).origin === location.origin && /\.svg$/i.test(address(image).pathname));
  for (const image of [...new Map(files.map(image => [address(image).href, image])).values()].slice(0, 10)) {
    try {
      // Marked as the check's own read, so one it gives up on (past the size or time limit) is not a failed request.
      const response = await fetch(address(image), { signal: AbortSignal.timeout(2000), headers: { "x-casper-check": "art" } });
      if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > 256_000) continue;
      // Read in parts and stop past the limit, so a file with no length (or one that never ends) is never held whole.
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let source = "";
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        source += decoder.decode(part.value, { stream: true });
        if (source.length > 256_000) break;
      }
      if (source.length > 256_000) { void reader.cancel().catch(() => {}); continue; }
      const svg = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
      if (svg.tagName.toLowerCase() !== "svg") continue;
      // Inside an <img> the page's CSS can't reach the picture: only its own dark-mode rule changes its colors.
      const colored = /(?:fill|stroke|stop-color)\s*(?:=\s*["']|:\s*)(?!none|currentColor|transparent|inherit|url)[#a-z]/i.test(source);
      // An <img> is named by its alt, which the accessibility check reads.
      items.push({ name: address(image).pathname.slice(0, 120), ...size(image)!, viewBox: svg.hasAttribute("viewBox"), named: true,
        fixedInFile: colored && !source.includes("prefers-color-scheme") });
    } catch {}
  }
  return { background, colors, items };
};
/** Runs in each new page before its own scripts: keeps the layout shifts not caused by input, with what moved. */
const WATCH_SHIFTS = () => {
  const name = (node: Node | null | undefined) => {
    if (!(node instanceof Element)) return "";
    const tag = node.tagName.toLowerCase();
    return (node.id ? `${tag}#${node.id}` : node.classList[0] ? `${tag}.${node.classList[0]}` : tag).slice(0, 60);
  };
  const shifts: Array<{ value: number; time: number; moved: string[] }> = [];
  Object.defineProperty(window, "__casperShifts", { value: shifts });
  type Shift = { value: number; startTime: number; hadRecentInput: boolean; sources?: Array<{ node?: Node | null }> };
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as unknown as Shift[]) {
        if (!entry.hadRecentInput && shifts.length < 500) shifts.push({ value: entry.value, time: entry.startTime, moved: (entry.sources ?? []).map(source => name(source.node)).filter(Boolean) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
};
/** Runs in the page: what makes it feel wrong to use. At desktop width, developer or broken text, layout jumps and a
 * focus ring drawn round a page region on load; at phone width, a huge footer and controls a fixed layer covers. */
const FEEL_FACTS = (phone: boolean): FeelFacts => {
  const visible = (element: Element) => (element as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  const words = (element: Element) => ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  const name = (element: Element) => {
    const tag = element.tagName.toLowerCase(), label = words(element).slice(0, 20);
    return (element.id ? `${tag}#${element.id}` : element.classList[0] ? `${tag}.${element.classList[0]}` : label ? `${tag} "${label}"` : tag).slice(0, 60);
  };
  const facts: FeelFacts = { devText: [], shift: { score: 0, moved: [], unsized: [] }, covered: [] };
  if (!phone) {
    // Developer or broken text: never inside code, a form's own value or a script.
    const always = [/\[object Object\]/, /\bInvalid Date\b/, /\bNaN\b/, /\{\{[^{}]{0,60}\}\}/, /\$\{[^{}]{0,60}\}/, /^(?:\[\s*)?\{\s*"[^"]{1,40}"\s*:/,
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, /&(?:amp|lt|gt|quot|apos|nbsp|copy|mdash|ndash|hellip|[lr][sd]quo|#\d{2,5}|#x[\da-f]{2,4});/i, /\blorem ipsum\b/i,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, /^(?:undefined|null)$/, /[:$€£¥]\s*(?:undefined|null)\b/];
    const hexId = /\b[0-9a-f]{24,}\b/i;
    const zone = /\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?\b/;
    // "1 bags": a 1 that is not part of a number, a price ("$1 drinks") or a name ("Step 1 is"), then a plural that is
    // not a verb ("table 1 seats 4", "option 1 gives").
    const one = /(?<![\p{L}\p{N}.,#/$€£¥₹+\-–−:]|\b\p{Lu}\p{L}*\s+)1\s+(\p{Ll}{2,}s)\b(?!\s+\d)/u;
    const singular = new Set(["news", "series", "species", "yes", "its", "this", "was", "has", "does", "goes", "plus", "minus", "always", "perhaps", "sometimes",
      "means", "lens", "gas", "bus", "vs", "as", "kudos", "physics", "maths", "mathematics", "economics", "ethics", "politics", "analytics", "pants", "jeans",
      "scissors", "thanks", "whereas", "besides", "towards", "afterwards", "gets", "takes", "gives", "makes", "seats", "sleeps", "costs", "needs", "includes",
      "wins", "starts", "ends", "runs", "opens", "closes", "shows", "leads", "comes", "holds", "covers", "offers", "contains", "requires", "allows", "lets",
      "says", "works", "looks", "seems", "becomes", "remains", "stays", "lasts", "applies", "saves", "earns", "pays", "counts", "fits", "serves", "feeds"]);
    const found = new Set<string>();
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(), seen = 0; node && found.size < 3 && seen < 3000; node = walker.nextNode()) {
      const parent = node.parentElement, text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!parent || !text || parent.closest("code, pre, kbd, samp, var, script, style, noscript, template, textarea, [contenteditable]") || !visible(parent)) continue;
      seen++;
      let at = -1, length = 0;
      for (const pattern of always) { const match = pattern.exec(text); if (match) { at = match.index; length = match[0].length; break; } }
      const hex = at < 0 ? hexId.exec(text) : null;
      if (hex && /\d/.test(hex[0]) && /[a-f]/i.test(hex[0])) { at = hex.index; length = hex[0].length; }
      const place = at < 0 && !parent.closest("select, datalist, option") ? zone.exec(text) : null;
      if (place) { at = place.index; length = place[0].length; }
      const plural = at < 0 ? one.exec(text) : null;
      if (plural && !singular.has(plural[1]!) && !/(?:ss|us|is)$/.test(plural[1]!)) { at = plural.index; length = plural[0].length; }
      if (at < 0) continue;
      const start = text.length <= 30 || length >= 30 ? Math.min(at, Math.max(0, text.length - 30)) : Math.max(0, at - Math.floor((30 - length) / 2));
      found.add(text.slice(start, start + 30));
    }
    facts.devText = [...found];
    // Layout shifts in session windows (a gap under 1 s, at most 5 s long), as Chrome's CLS counts them.
    const shifts = ((window as unknown as { __casperShifts?: Array<{ value: number; time: number; moved: string[] }> }).__casperShifts ?? []);
    let best = { score: 0, moved: [] as string[] }, current = { score: 0, moved: [] as string[], start: -Infinity, last: -Infinity };
    for (const shift of shifts) {
      if (shift.time - current.last >= 1000 || shift.time - current.start >= 5000) current = { score: 0, moved: [], start: shift.time, last: shift.time };
      current.score += shift.value; current.last = shift.time; current.moved.push(...shift.moved);
      if (current.score > best.score) best = { score: current.score, moved: [...current.moved] };
    }
    const unsized = best.score <= 0 ? [] : Array.from(document.images).filter(image => visible(image) && image.getAttribute("src") && !(image.hasAttribute("width") && image.hasAttribute("height"))
      && getComputedStyle(image).aspectRatio === "auto").map(image => {
      try { const address = new URL(image.currentSrc || image.src); return (address.origin === location.origin ? address.pathname : `${address.origin}${address.pathname}`).slice(0, 60); }
      catch { return image.src.slice(0, 60); }
    });
    facts.shift = { score: Math.round(best.score * 100) / 100, moved: [...new Set(best.moved)].slice(0, 3), unsized: [...new Set(unsized)].slice(0, 3) };
    // A focus ring round a page region as the page opens. A field or button focused on load is fine.
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement && visible(active)
      && !active.matches('input, select, textarea, button, a[href], summary, iframe, [contenteditable], [role="button"]')) {
      const box = active.getBoundingClientRect(), style = getComputedStyle(active);
      const region = active.matches('main, h1, [role="main"]') || box.width * box.height >= 0.25 * innerWidth * innerHeight;
      const ring = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && !/^(?:transparent|rgba\(.*,\s*0\))$/.test(style.outlineColor);
      if (region && ring) facts.focusRing = name(active);
    }
    return facts;
  }
  // The page footer, not one inside a card, an article or a section.
  const footers = Array.from(document.querySelectorAll('footer, [role="contentinfo"]')).filter(footer => visible(footer)
    && !footer.parentElement?.closest('article, aside, section, nav, li, dialog, footer, [role="dialog"], [class*="card" i]'));
  const tallest = Math.max(0, ...footers.map(footer => footer.getBoundingClientRect().height));
  if (tallest > innerHeight * 0.5) facts.footer = Math.round(tallest);
  // Fixed and sticky layers, not dialogs: a dialog is meant to cover the page.
  const screen = innerWidth * innerHeight;
  const layers: Element[] = [];
  for (const element of Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, 5000)) {
    const position = getComputedStyle(element).position;
    if ((position !== "fixed" && position !== "sticky") || layers.some(layer => layer.contains(element)) || !visible(element)) continue;
    const box = element.getBoundingClientRect();
    const shown = Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0)) * Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
    if (!shown || shown >= 0.6 * screen || element.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) continue;
    layers.push(element);
  }
  if (!layers.length) return facts;
  const controls = Array.from(document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]'))
    .filter(control => visible(control) && !layers.some(layer => layer.contains(control)));
  const covered = new Set<string>();
  // At the top only a layer at the top is checked, at the bottom one at the bottom: anywhere else a person scrolls the control out from under it.
  for (const where of ["top", "bottom"] as const) {
    window.scrollTo({ top: where === "top" ? 0 : document.documentElement.scrollHeight, behavior: "instant" });
    for (const control of controls) {
      if (covered.size >= 3) break;
      const box = control.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      if (!box.width || !box.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || control.contains(hit) || hit.contains(control)) continue;
      const layer = layers.find(candidate => candidate.contains(hit));
      if (!layer) continue;
      const area = layer.getBoundingClientRect();
      if ((area.top + area.height / 2 < innerHeight / 2) !== (where === "top")) continue;
      covered.add(`${name(control)} (under ${name(layer)})`);
    }
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  facts.covered = [...covered];
  return facts;
};
/** Runs in the page: scrolls down a screen at a time (at most 12) so lazy images start loading, then back to the top. */
const SCROLL_THROUGH = async () => {
  for (let step = 1; step <= 12 && window.innerHeight * step < document.documentElement.scrollHeight; step++) {
    window.scrollTo({ top: window.innerHeight * step, behavior: "instant" });
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  window.scrollTo({ top: 0, behavior: "instant" });
};
/** Runs in the page: waits for animations that end (fade-ins, reveals) to finish, at most a second. */
const ANIMATIONS_DONE = async () => {
  const ending = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity);
  await Promise.race([Promise.all(ending.map(animation => animation.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 1000))]);
};
/** Runs in the page: the links a person can follow, resolved, leaving out downloads and `rel="nofollow"`. */
const PAGE_LINKS = () => [...document.querySelectorAll("a[href]")]
  .filter(link => !link.hasAttribute("download") && !/\bnofollow\b/i.test(link.getAttribute("rel") ?? ""))
  .map(link => link.getAttribute("href")!.includes("#") ? "" : (link as HTMLAnchorElement).href).filter(Boolean).slice(0, 200);
/** Runs in the page: the chosen values (from a link's query) the page does not show as chosen: not a selected option,
 * a checked box or its label, a field's value, nor visible text in the first screen and a half. A value under 3
 * characters, an id-like value (any digit, unless a date) or an id key counts only where a field is named after its
 * key, and then only that field's value. */
const CHOICES_SHOWN = (choices: Array<[string, string]>): string[] => {
  const plain = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const visible = (element: Element) => (element as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  const held = (field: Element): string[] => {
    if (field instanceof HTMLSelectElement) return [...field.selectedOptions].flatMap(option => [option.value, option.text]);
    if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) {
      return field.checked ? [field.value, ...[...field.labels ?? []].map(label => label.innerText)] : [];
    }
    return [(field as HTMLInputElement).value];
  };
  const fields = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(visible);
  const shown: string[] = fields.flatMap(held);
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(), seen = 0; node && seen < 3000; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || parent.closest("script, style, noscript, template, option") || !visible(parent)) continue;
    seen++;
    if (parent.getBoundingClientRect().top < innerHeight * 1.5) shown.push(node.textContent);
  }
  const page = plain(shown.join(" | "));
  return choices.filter(([key, value]) => {
    // An id the page need not print (7, a1b2c3, a UUID; a key such as id or user_id) counts only in a field named after its key.
    if (value.length < 3 || (/\d/.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) || /(?:^|[_-])id$|[a-z]Id$|^uuid$/i.test(key)) {
      const named = fields.filter(field => field.getAttribute("name") === key || field.id === key);
      return named.length > 0 && !named.flatMap(held).some(text => text.trim().toLowerCase() === value.toLowerCase());
    }
    const wanted = [value];
    // A date is shown as a date: "12 October", "Oct 12", "12/10/2026".
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = new Date(`${value}T12:00:00`);
      for (const locale of [document.documentElement.lang || "en", "en-GB", "en-US"]) {
        for (const style of [{ day: "numeric", month: "long" }, { day: "numeric", month: "short" }, { day: "numeric", month: "numeric", year: "numeric" }] as const) {
          try { wanted.push(date.toLocaleDateString(locale, style)); } catch {}
        }
      }
    }
    return !wanted.some(text => plain(text).trim() && page.includes(plain(text)));
  }).map(([, value]) => value.slice(0, 40)).slice(0, 3);
};
/** Runs in the page: nothing shows, no text and no visible picture or control. */
const BLANK_PAGE = () => {
  const body = document.body;
  if (!body) return true;
  if (body.innerText.trim()) return false;
  return ![...body.querySelectorAll("img, svg, canvas, video, iframe, input, button, select, textarea")].some(element => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
};
/** Paths a link sweep never opens: they may sign out, delete or change something with a plain GET. */
const UNSAFE_LINK = /(log|sign)[-_]?(out|off)|delete|remove|destroy|reset|unsubscribe|cancel|clear|admin|purge|revoke/i;
/** Words for an action, as a whole part of a path (`/cart/add/3`, `/orders/7/confirm`): a GET to one may change something. */
const ACTION_WORDS = new Set(["add", "toggle", "complete", "done", "mark", "approve", "confirm", "accept", "decline", "reject", "archive", "restore",
  "vote", "like", "unlike", "follow", "unfollow", "subscribe", "wipe", "erase", "deactivate", "disable", "enable", "exit", "kill", "stop", "start",
  "restart", "shutdown", "seed", "flush", "send", "empty", "drop", "ban", "block", "publish", "unpublish", "increment", "decrement", "pay", "buy"]);
/** Query keys that steer an action, a redirect or a secret: a link with one is never followed. */
const ACTION_KEY = /^(?:_?method|action|do|cmd|command|op|operation|task|redirect\w*|return\w*|next|continue|callback|url|goto|token|csrf\w*|nonce|sig|signature|key|api_?key|session\w*|sid|auth\w*|code|state)$/i;
/** Query keys that page, sort, track or style rather than choose: they are not checked. */
const NOT_A_CHOICE = /^(?:utm_\w+|mc_\w+|ref|src|source|fbclid|gclid|page|p|offset|limit|per_?page|sort\w*|order\w*|dir|direction|view|tab|lang|locale|hl|theme|mode|format|v|ver|version|t|ts|_|cache|embed|debug|preview|q|query|search|s|from|to|back)$/i;
/** Files that are not pages. A path with no extension, or .html/.htm, is a page. */
const PAGE_FILE = /\.html?$/i;
/** The same-origin page paths among these links that a light GET can open: never one with a query or a fragment, an
 * API path, a file that isn't a page, or a path that may sign out, delete, reset, cancel or do another action. The page itself and
 * repeats are left out; at most 20. */
export function followableLinks(hrefs: readonly string[], pageUrl: string): string[] {
  const page = new URL(pageUrl);
  const paths = new Set<string>();
  for (const href of hrefs) {
    if (paths.size >= 20) break;
    let link: URL;
    try { link = new URL(href, page); } catch { continue; }
    if (link.origin !== page.origin || href.includes("?") || href.includes("#") || link.search || link.hash) continue;
    const path = link.pathname;
    const last = path.split("/").pop() ?? "";
    let plain = path;
    try { plain = decodeURIComponent(path); } catch {}
    if (path === page.pathname || /(^|\/)api(\/|$)/i.test(plain) || UNSAFE_LINK.test(plain) || plain.toLowerCase().split(/[/_.-]+/).some(word => ACTION_WORDS.has(word))) continue;
    if (last.includes(".") && !PAGE_FILE.test(last)) continue;
    paths.add(path);
  }
  return [...paths];
}
/** The choices a same-origin link's query makes (`/book?staff=ana-sousa` chooses staff ana-sousa), decoded, at most 5;
 * undefined for a link that is not a safe page link with a choice: a `#`, an API path, a file, an unsafe or action
 * word in its path, keys or values, or a key that steers an action, a redirect or a secret. Keys that page, sort or
 * track are left out. */
export function linkChoices(href: string, pageUrl: string): { link: string; choices: Array<[string, string]> } | undefined {
  const page = new URL(pageUrl);
  let link: URL;
  try { link = new URL(href, page); } catch { return undefined; }
  if (link.origin !== page.origin || href.includes("#") || link.hash || !link.search) return undefined;
  let plain = link.pathname;
  try { plain = decodeURIComponent(link.pathname); } catch {}
  const last = plain.split("/").pop() ?? "";
  if (/(^|\/)api(\/|$)/i.test(plain) || (last.includes(".") && !PAGE_FILE.test(last))) return undefined;
  const pairs = [...link.searchParams].map(([key, value]) => [key.trim(), value.trim()] as [string, string]);
  const words = [plain, ...pairs.flat()].join("/");
  if (UNSAFE_LINK.test(words) || words.toLowerCase().split(/[/_.\-\s=&]+/).some(word => ACTION_WORDS.has(word))) return undefined;
  if (pairs.some(([key]) => ACTION_KEY.test(key) || !/^[a-z][\w.\-[\]]{0,39}$/i.test(key))) return undefined;
  const choices = pairs.filter(([key, value]) => value && !NOT_A_CHOICE.test(key)).slice(0, 5);
  return choices.length ? { link: `${link.pathname}${link.search}`, choices } : undefined;
}
/** The same-origin links among these whose query makes a choice (see `linkChoices`), path and query, at most 20, taking
 * turns by the keys they set (staff, service, staff, service), so the first few cover every kind of choice. */
export function choiceLinks(hrefs: readonly string[], pageUrl: string): string[] {
  const groups = new Map<string, string[]>(), seen = new Set<string>();
  for (const href of hrefs) {
    const found = linkChoices(href, pageUrl);
    if (!found || seen.has(found.link)) continue;
    seen.add(found.link);
    const keys = `${new URL(found.link, pageUrl).pathname}?${found.choices.map(([key]) => key).sort().join("&")}`;
    groups.set(keys, [...groups.get(keys) ?? [], found.link]);
  }
  const links: string[] = [];
  for (let turn = 0; links.length < 20 && [...groups.values()].some(group => group.length > turn); turn++)
    for (const group of groups.values()) if (group[turn] && links.length < 20) links.push(group[turn]!);
  return links;
}
/** The desktop picture's height cap, in CSS pixels. */
const PICTURE_HEIGHT = 4000;
const LOAD_LIMIT = 10;
/** Page checks save at most this many pictures per session: 5 pages, desktop and phone, a few rounds. */
const PAGE_PICTURE_LIMIT = 40;
const LOAD_TEXT = 300;
/** A check or replay ends with the page as it was left: its text up to this many characters and this many controls,
 * so the model has no open, inspect or screenshot to do next. */
const FINAL_TEXT = 1500;
const FINAL_ELEMENTS = 20;
/** Final-page pictures a session's checks and replays may send (their own limit; the model's 16 screenshots are apart). */
const FINAL_PICTURE_LIMIT = 30;
/** The final page gets at most this long, and none when the check has used most of its 30 s, so it never makes a check overrun. */
const FINAL_PAGE_MS = 3_000;
const FINAL_PAGE_AFTER_MS = 25_000;
/** A check's result with its final page stays this small (JSON bytes), under the 16 KiB result cap, so it is never cut. */
const FINAL_RESULT_BYTES = 14_000;
/** What inspect reads (and, shorter, a check's final page): title, visible text, size and the page's controls with a selector. */
const PAGE_SUMMARY = (textLimit: number, elementLimit: number) => ({ title: document.title.slice(0, 512),
  text: (document.body?.innerText ?? "").slice(0, textLimit), url: location.href,
  viewport: { width: innerWidth, height: innerHeight }, width: document.documentElement.scrollWidth,
  elements: [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")].slice(0, elementLimit).map(el => ({
    tag: el.tagName, id: el.id.slice(0, 128), name: (el.getAttribute("name") ?? "").slice(0, 128), type: el.getAttribute("type"),
    label: (el.getAttribute("aria-label") ?? el.textContent ?? "").slice(0, 128),
    selector: el.id ? `#${CSS.escape(el.id)}` : undefined,
  })) });

/** Fields fill types into, like a person would. Password and file stay out (checked before this). */
const TYPED_FIELDS = ["", "text", "search", "tel", "url", "email", "number"];
/** Fields a person sets through a picker: fill sets their value and fires input and change. */
const PICKED_FIELDS = ["date", "time", "datetime-local", "month", "week", "color", "range"];

/** Scrolls a control to the middle of the screen at once (a page's smooth scrolling aside), then waits up to a
 * second for its box to have a size and hold still: a section that grows or fades in once scrolled to has finished. */
async function settleInView(element: import("puppeteer-core").ElementHandle): Promise<void> {
  await element.evaluate(async el => {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = () => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 ? `${r.x},${r.y},${r.width},${r.height}` : ""; };
    let last = box();
    for (const end = performance.now() + 1000; performance.now() < end;) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const now = box();
      if (now && now === last) return;
      last = now;
    }
  });
}

/**
 * The element as a person would name it (button "Save"), and what covers its center if another element does (a toast,
 * a cookie bar). Not a cover: the element itself or anything inside it, an element round it (a dialog that holds it),
 * or a label for it.
 */
async function coverOf(element: import("puppeteer-core").ElementHandle): Promise<{ target: string; by?: string }> {
  return element.evaluate(el => {
    const words = (e: Element) => (e.getAttribute("aria-label") || (e as HTMLElement).innerText || (e as HTMLInputElement).value
      || e.getAttribute("placeholder") || e.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const target = `${el.tagName.toLowerCase()}${words(el) ? ` "${words(el)}"` : ""}`;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (r.width < 1 || r.height < 1 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { target };
    const hit = document.elementFromPoint(x, y);
    if (!hit || el.contains(hit) || hit.contains(el) || (hit.closest("label") as HTMLLabelElement | null)?.control === el) return { target };
    // Named by its layer (the fixed toast, not the span inside it).
    let layer: Element = hit;
    for (let up: Element | null = hit; up && up !== document.body; up = up.parentElement)
      if (["fixed", "sticky", "absolute"].includes(getComputedStyle(up).position)) { layer = up; break; }
    const name = `${layer.tagName.toLowerCase()}${layer.id ? `#${layer.id}` : ""}${[...layer.classList].slice(0, 2).map(c => `.${c}`).join("")}`;
    return { target, by: `${name}${words(layer) ? ` "${words(layer)}"` : ""}` };
  });
}

/** What the page's state looks like now, to tell whether an action changed anything; undefined on a new document. */
function watchState(key: string): string | undefined {
  const watch = (window as unknown as Record<string, { changes: number; el: Element; active: Element | null } | undefined>)[key];
  if (!watch) return undefined;
  const active = document.activeElement;
  const control = watch.el instanceof HTMLLabelElement ? watch.el.control : watch.el;
  const form = control instanceof HTMLInputElement ? `${control.checked}:${control.value}` : control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement ? control.value : "";
  // Focus moving onto the clicked element itself is not a change, unless it is a field to type in: focusing it is the point.
  const typing = active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement || (active as HTMLElement | null)?.isContentEditable
    || (active instanceof HTMLInputElement && !["button", "submit", "reset", "checkbox", "radio", "image", "file", "range", "color"].includes(active.type));
  const focus = active === watch.active || (active && watch.el.contains(active) && !typing) ? "same" : "moved";
  return `${watch.changes}|${location.href}|${focus}|${scrollX},${scrollY}|${form}`;
}

interface PageOutline { title: string; text: string[]; controls: string[]; focus: string; target?: string }

/** A compact outline of what a person sees: the title, visible text lines, controls by role and name (button "Save"),
 * the focused element and the action's target, named the same way; at most 400 entries, so it stays cheap on a long page. */
function pageOutline(target?: Element): PageOutline {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }); };
  const role = (el: Element) => el.getAttribute("role") ?? ({ A: "link", BUTTON: "button", SELECT: "select", TEXTAREA: "textbox", SUMMARY: "button" } as Record<string, string>)[el.tagName]
    ?? (el.tagName === "INPUT" ? (({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button", range: "slider" } as Record<string, string>)[(el as HTMLInputElement).type] ?? "textbox") : el.tagName.toLowerCase());
  const name = (el: Element) => clean(el.getAttribute("aria-label") || (el as HTMLInputElement).labels?.[0]?.innerText || (el as HTMLElement).innerText
    || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || (["submit", "button"].includes((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : "")).slice(0, 60);
  const describe = (el: Element) => `${role(el)}${name(el) ? ` "${name(el)}"` : ""}`;
  const outline: PageOutline = { title: document.title, text: [], controls: [], focus: "" };
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(), seen = 0; node && seen < 5000 && outline.text.length + outline.controls.length < 400; node = walker.nextNode(), seen++) {
    if (node.nodeType === Node.TEXT_NODE) {
      const line = clean(node.textContent);
      if (line && node.parentElement && !node.parentElement.closest("script, style, noscript, template, button, a, select, textarea, label, option") && shown(node.parentElement)) outline.text.push(line.slice(0, 200));
    } else if ((node as Element).matches("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=switch], [contenteditable=true]") && shown(node as Element))
      outline.controls.push(describe(node as Element));
  }
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) outline.focus = describe(active);
  if (target) outline.target = describe(target);
  return outline;
}

/** What an action changed on the page, from outlines before and after: the title, text that appeared (a toast, an
 * error, a status), controls added or removed (up to 5 each) and where focus moved. Undefined when none of these did. */
function outlineChanges(before: PageOutline, after: PageOutline): Record<string, unknown> | undefined {
  const minus = (a: string[], b: string[]) => { const left = new Map<string, number>(); for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
    return a.filter(x => { const n = left.get(x) ?? 0; if (n) left.set(x, n - 1); return !n; }); };
  const appeared = minus(after.text, before.text).join(" | ");
  const added = [...new Set(minus(after.controls, before.controls))].slice(0, 5), removed = [...new Set(minus(before.controls, after.controls))].slice(0, 5);
  const changes = { ...(after.title !== before.title ? { title: after.title } : {}), ...(appeared ? { appeared: appeared.length > 400 ? `${appeared.slice(0, 399)}…` : appeared } : {}),
    ...(added.length ? { controlsAdded: added } : {}), ...(removed.length ? { controlsRemoved: removed } : {}),
    ...(after.focus !== before.focus && after.focus ? { focus: after.focus } : {}) };
  return Object.keys(changes).length ? changes : undefined;
}

/** A native dialog Casper dismissed, as the action's result names it. */
function dialogNote(dialog: { type: string; message: string }): string {
  const answer = dialog.type === "alert" ? "closed it" : dialog.type === "beforeunload" ? "stayed on the page" : "answered Cancel";
  return `${dialog.type} dialog ${JSON.stringify(dialog.message)}: Casper ${answer}`;
}

const BROKEN_CHECK_HINT ="If the check itself is wrong, record a corrected check of this page and withdraw this one (replacedBy: its id once it passes); if the page is wrong, fix it.";
/** On a replay failing a check that passed when recorded and fills a fixed email, user name or name: the page may refuse a repeat. */
const RUN_HINT = "It passed before: a sign-up or booking may need a new value each run; use {run} in the fill value.";
let runs = 0;
/** A short value new on each run of a check (letters and digits, so it fits an email or a user name); {run} in a step's value becomes it. */
const runToken = () => `${Date.now().toString(36)}${(++runs).toString(36)}`;
/** A fill of what looks like an email, user name or name, with a fixed value (the `name` attribute key itself does not count). */
const fixedIdentity = (steps: BrowserStep[]) => steps.some(step => step.action === "fill" && step.value !== undefined && !step.value.includes("{run}")
  && (/e-?mail|user|login|account|name/i.test(step.selector.replace(/\[\s*name\s*[~|^$*]?=/gi, "[")) || /\S@\S/.test(step.value)));
const INSIDE_HINT = "The expected text is inside this element with other text: point the selector at the element that holds only it (see near).";
/** The way out of a withdraw refused after a change: a corrected check of the same page that passes takes its place. */
const REPLACE_WAY = "or record a corrected check of the same page and, once it passes, withdraw this one with replacedBy: its id";
/** A replay whose page's server no longer answers and no server of Casper's stands in: nothing was checked. */
class ServerGone extends Error {}

/** One task's disposable browser. No user profiles, arbitrary evaluation or browser installation. */
/** The scenario's inputs as they are now; a check that names none is told how to get a fresh pass when the whole project can't be watched.
 * Watching the whole project leaves out what git ignores, so a page that saves to an ignored data/db.json stays fresh. */
async function inputState(root: string, scenario: BrowserScenario, signal?: AbortSignal): Promise<InputState> {
  const state = await workspaceState(root, scopeOf(scenario), signal, { skipGitIgnored: !scenario.scope });
  return state.fingerprint || scenario.scope ? state
    : { reason: `${state.reason} With no scope.inputs Casper watches the whole project; name the files the page depends on.` };
}

interface RecordedCheck { scenario: BrowserScenario; check: BrowserCheck; fingerprint?: string; revision: number; /** performance.now() when it last ran. */ ranAt: number
  /** Its place in recording order: a replacement must be recorded after the check it replaces. */
  order: number
  /** The revision and input fingerprint of the run that recorded it: a withdraw needs both unchanged since then. */
  recordedRevision: number; recordedFingerprint?: string }

/** How long a first Chrome start may take before one fresh start replaces it, and fresh starts after a crash per session. */
const FIRST_START_MS = 8_000;
const MAX_RESTARTS = 2;

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
  private server?: BrowserServer | SlotServer | StaticServer;
  private readonly runId = randomUUID();
  private screenshotCount = 0;
  /** Page-check pictures taken this session (their own limit; the model's 16 screenshots are apart). */
  private pagePictures = 0;
  /** Final-page pictures checks and replays sent this session. */
  private finalPictures = 0;
  private readonly logs: Array<{ type: string; text: string }> = [];
  private readonly requests: Array<{ url: string; status?: number; error?: string }> = [];
  private dropped = 0;
  /** Native dialogs (alert, confirm, prompt, beforeunload) dismissed since the running action began, and requests started. */
  private readonly dialogs: Array<{ type: string; message: string }> = [];
  private requestsStarted = 0;
  /** New tabs the page opened (a target="_blank" link, window.open). */
  private popups = 0;
  private revision = 0;
  private operations = 0;
  /** Fresh Chrome starts after a crash this session, and the note the next result carries about the last one. */
  private restarts = 0;
  private restarted?: string;
  /** Host page loads: serialized, and the first one gets the longer first-compile deadline. */
  private loading: Promise<void> = Promise.resolve();
  private loads = 0;
  /** Page loads that took pictures, for their file names. */
  private pageLoads = 0;
  private readonly scenarios = new Map<string, RecordedCheck>();
  private recorded = 0;
  /** Casper's own end-of-task replay runs: nothing is asked, and a question is a no. */
  private unattended = false;
  /** When Casper's end replays must stop (performance.now()); set only while they run. */
  private replayUntil?: number;
  /** Metadata addresses the person said yes to for the action now running (a session yes is kept by confirmMetadata). */
  private readonly metadataAllowed = new Set<string>();
  private guard?: MetadataGuard;
  /** The running action's deadline, held while a question waits for the person. */
  private deadline?: { hold: () => void; resume: () => void };
  constructor(private readonly options: BrowserSessionOptions) {}

  assertCleanup(): void { if (this.cleanupError && !this.cleanupError.acknowledged) throw this.cleanupError; }

  status() { return { state: this.cleanupError && !this.cleanupError.acknowledged ? "failed" : this.controller.signal.aborted ? "closed" : this.page ? "ready" : this.startup ? "starting" : "idle",
    ownedProcessCleanup: this.cleanupError ? "unknown" : undefined,
    runId: this.runId, screenshots: this.screenshotCount, ownedBrowserPid: this.browser?.process()?.pid }; }

  run(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.controller.signal.aborted) return Promise.reject(new Error("Browser session is closed"));
    if (this.work) return Promise.reject(new Error("Browser is busy; wait for the current operation"));
    if (++this.operations > 200) return Promise.reject(new Error("Browser operation limit reached (200 per session)"));
    const work = this.perform(input, signal);
    this.work = work;
    void work.finally(() => { if (this.work === work) this.work = undefined; }).catch(() => {});
    return work;
  }

  private async perform(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!record(input)) throw new Error("Browser arguments must be an object with an action");
    if (Buffer.byteLength(JSON.stringify(input)) > 20_000) throw new Error("Browser arguments exceed 20 KiB");
    const { args, ignored } = browserArguments(input);
    const before = this.restarts;
    let result: Record<string, unknown>;
    try { result = await this.dispatch(args, signal); } catch (error) {
      // Chrome died during this action: say so rather than the protocol error it caused. The action can fail a
      // moment before Chrome's disconnect is seen, so a closed-target error waits briefly for it.
      if (/Target closed|Session closed|detached|Connection closed/i.test(String(error)))
        for (let i = 0; i < 20 && this.restarts === before && !this.controller.signal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 25));
      if (this.restarts > before && !this.controller.signal.aborted) { this.restarted = undefined; throw new Error("Chrome stopped unexpectedly during this action and Casper started a new one. The page is gone: open it again."); }
      throw error;
    }
    const restarted = this.restarted;
    this.restarted = undefined;
    const noted = restarted ? { ...result, restarted } : result;
    return ignored.length ? { ...noted, ignoredArguments: ignored, note: `${actionUsage(args.action as BrowserAction)}; the other fields were not applied.` } : noted;
  }

  private async dispatch(input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const interaction = INTERACTIONS.includes(String(input.action));
    const url = input.action === "open" ? webURL(input.url) : undefined;
    let combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    combined.throwIfAborted();
    const close = () => { void this.close().catch(() => {}); };
    // Casper's own end replay gives up softly: its signal aborts and the browser stays open; only an operation that
    // still hasn't stopped 5 s later closes the session, as any other overrun does.
    let last: ReturnType<typeof setTimeout> | undefined;
    const soft = this.unattended ? new AbortController() : undefined;
    if (soft) combined = AbortSignal.any([combined, soft.signal]);
    const stop = soft ? () => { soft.abort(new Error("Browser replay ran out of time")); last ??= setTimeout(close, 5_000); } : close;
    combined.addEventListener("abort", stop, { once: true });
    const full = input.action === "check" || input.action === "replay" ? 30_000 : 15_000;
    const limit = soft && this.replayUntil ? Math.max(1_000, Math.min(full, this.replayUntil - performance.now())) : full;
    let timer = setTimeout(stop, limit);
    this.deadline = { hold: () => clearTimeout(timer), resume: () => { clearTimeout(timer); timer = setTimeout(stop, limit); } };
    try {
      if (input.action === "check" || input.action === "replay") return await this.check(input, combined);
      if (input.action === "withdraw") return await this.withdraw(input);
      if (input.action === "serve") return await this.serve(input, combined);
      if (input.action === "diagnostics") return { console: structuredClone(this.logs), network: structuredClone(this.requests), dropped: this.dropped,
        server: this.server?.diagnostics(), guidance: "Bounded diagnostics, not verification. URL queries/fragments are omitted; content may still be sensitive." };
      const page = url ? await this.start() : this.page;
      if (!page) { const restarted = this.restarted; this.restarted = undefined; throw new Error(restarted ?? "Open a browser URL before inspecting it"); }
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
        const observation = await page.evaluate(PAGE_SUMMARY, 8000, 40);
        return { ...observation, ...held };
      }
      if (this.screenshotCount >= 16) throw new Error("Browser screenshot limit reached (16 per session)");
      const bytes = await page.screenshot({ type: "png", fullPage: false });
      combined.throwIfAborted();
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("Browser screenshot exceeds 4 MiB");
      const saved = await this.savePicture(`${this.screenshotCount + 1}.png`, bytes, combined);
      this.screenshotCount++;
      return { path: saved, bytes: bytes.byteLength,
        url: page.url(), viewport: page.viewport(), guidance: "The picture comes with this result when the model can see images. Capture alone is not verification.", ...held,
        [SCREENSHOT_PNG]: Buffer.from(bytes).toString("base64") };
    } finally { clearTimeout(timer); clearTimeout(last); this.deadline = undefined; this.metadataAllowed.clear(); combined.removeEventListener("abort", stop); }
  }

  /** The person's answer for one metadata address; the action's deadline waits for it. No one to ask is a no. */
  private async metadataYes(address: string, url: string, signal: AbortSignal): Promise<boolean> {
    if (this.metadataAllowed.has(address)) return true;
    if (this.unattended) return false;
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

  /** A page check's picture of the visible page, or of the whole page up to `height`; undefined when it can't be
   * taken or saved (never a failure). A whole page too big to keep falls back to the visible part. */
  private async pagePicture(page: Page, name: string, signal: AbortSignal, height?: number): Promise<string | undefined> {
    if (this.pagePictures >= PAGE_PICTURE_LIMIT) return undefined;
    try {
      const { artifactFilesystemSupported } = await import("../visualize/artifacts");
      if (!artifactFilesystemSupported) return undefined;
      const width = page.viewport()?.width ?? 1280;
      let bytes = await page.screenshot({ type: "png", ...(height ? { clip: { x: 0, y: 0, width, height }, captureBeyondViewport: true } : { fullPage: false }) });
      signal.throwIfAborted();
      if (height && bytes.byteLength > 4 * 1024 * 1024) bytes = await page.screenshot({ type: "png", fullPage: false });
      if (bytes.byteLength > 4 * 1024 * 1024) return undefined;
      this.pagePictures++;
      return await this.savePicture(name, bytes, signal);
    } catch (error) {
      signal.throwIfAborted();
      return undefined;
    }
  }

  private async serve(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (input.script !== "dev" && input.script !== "start" && input.script !== "files") throw new Error("Browser serve needs script: \"dev\" or \"start\" (a package.json script name), or \"files\" for a folder of plain files");
    if (!["local-test", "consequential", "uncertain"].includes(String(input.impact))) throw new Error("Browser serve needs impact: local-test, consequential or uncertain");
    const reason = text(input.reason, "reason", 512), url = webURL(input.url);
    if (!localURL(url)) throw new Error("Browser serve url must be a loopback address like http://127.0.0.1:3000");
    // Plain files run no command, so nothing needs approving; Casper serves them and stops them with the session.
    if (input.script === "files") {
      await this.replaceServer();
      const files = new StaticServer(); this.server = files;
      try { return await files.start(this.options.projectRoot, url, signal); }
      catch (error) { await files.close(); this.server = undefined; throw error; }
    }
    const source = referenceText(await readReferenceFile(path.join(this.options.projectRoot, "package.json"), 65_536));
    const manifest: unknown = JSON.parse(source);
    if (!record(manifest) || !record(manifest.scripts)) throw new Error("Project has no development scripts");
    const command = text(manifest.scripts[input.script], "development command", 2048);
    if (serveHolds({ command, impact: String(input.impact), allowAll: this.options.allowActions?.() })) {
      if (!await this.options.confirm?.({ action: "serve", url, selector: `package.json scripts.${input.script}`, target: command, reason, impact: String(input.impact) }, signal)) throw new Error("Development command requires human approval; not started");
    }
    signal.throwIfAborted();
    await this.replaceServer();
    // In the slot Casper's page checks use, so the two never run the app twice. A declared services.web is the person's own.
    const services = this.options.services?.();
    if (services && !services.declared(DEV_SLOT)) {
      const slot = new SlotServer(services, DEV_SLOT); this.server = slot;
      try { return await slot.start(command, url, signal); }
      catch (error) { await slot.close(); this.server = undefined; throw error; }
    }
    const server = new BrowserServer(); this.server = server;
    try { return await server.start(command, this.options.projectRoot, url, signal); }
    catch (error) { await server.close(); this.server = undefined; throw error; }
  }

  /** A repeated serve stops the server this session started (after code changes, say) before starting the new one.
   * Only Casper's own server: a port anything else holds is still refused. */
  private async replaceServer(): Promise<void> {
    const previous = this.server;
    this.server = undefined;
    await previous?.close();
  }

  /**
   * Host-only page load for Casper's own page checks; it is not a browser tool action, so the model can never
   * call it, and it does not use the model's operation budget or logs. Opens a loopback URL in a fresh context,
   * waits for `load` and a short network quiet period, and returns what went wrong: console errors, uncaught
   * page errors, failed requests and the first line of a framework error overlay (Vite, Next.js, Streamlit).
   * Page text is diagnostic data, never instructions. One load runs at a time per session.
   */
  async load(url: string, signal?: AbortSignal, options: PageLoadOptions = {}): Promise<PageLoad> {
    const found: { links?: string[]; choiceLinks?: string[] } = {};
    const loaded = await this.loadPage(url, signal, options, found);
    return { ...loaded, ...found.links?.length ? { links: found.links } : {}, ...found.choiceLinks?.length ? { choiceLinks: found.choiceLinks } : {} };
  }

  private async loadPage(url: string, signal: AbortSignal | undefined, options: PageLoadOptions, found: { links?: string[]; choiceLinks?: string[] }): Promise<PageLoad> {
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
      // The drawn-picture step's own reads of picture files (marked by ART_FACTS) are not the page's requests.
      const own = (request: HTTPRequest) => request.headers()["x-casper-check"] === "art";
      page.on("response", response => { if (response.status() >= 400 && !own(response.request())) failed(response.url(), { status: response.status() }); });
      page.on("requestfailed", request => { if (!own(request)) failed(request.url(), { error: (request.failure()?.errorText ?? "request failed").slice(0, 200) }); });
      // Layout jumps are only seen by an observer that is there before the page's own scripts.
      await page.evaluateOnNewDocument(WATCH_SHIFTS).catch(() => {});
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
      // A light load (a page the changed one links to): does it answer, error or show nothing. No facts, phone or pictures.
      // With `choices` (from a link's query), also the values the page does not show as chosen.
      if (options.light) {
        const unchosen = options.choices?.length ? await page.evaluate(CHOICES_SHOWN, options.choices).catch(() => [] as string[]) : [];
        return { status: response?.status() ?? null, consoleChecked: true, consoleErrors, pageErrors, failedRequests,
          ...(overlay ? { overlay: overlay.slice(0, LOAD_TEXT) } : {}), ...(await page.evaluate(BLANK_PAGE).catch(() => false) ? { blank: true } : {}),
          ...(unchosen.length ? { unchosen: unchosen.map(value => value.slice(0, LOAD_TEXT)) } : {}) };
      }
      const hrefs = await page.evaluate(PAGE_LINKS).catch(() => [] as string[]);
      found.links = followableLinks(hrefs, String(target));
      found.choiceLinks = choiceLinks(hrefs, String(target));
      // Scroll through once so lazy images load and reveal-on-scroll rows show, then let animations finish.
      await page.evaluate(SCROLL_THROUGH).catch(() => {});
      await page.waitForNetworkIdle({ idleTime: 300, timeout: 2000 }).catch(() => {});
      await page.evaluate(ANIMATIONS_DONE).catch(() => {});
      combined.throwIfAborted();
      // Read before the picture and the phone size, which move the layout themselves.
      const feelDesktop = await page.evaluate(FEEL_FACTS, false).catch(() => undefined);
      // A picture of the whole page (rows below the fold too), for the receipt and, when you allow it, the AI.
      const shot = options.screenshots ? ++this.pageLoads : 0;
      const pageHeight = shot ? await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0) : 0;
      const desktopPicture = shot ? await this.pagePicture(page, `page-${shot}-desktop.png`, combined, Math.min(Math.max(pageHeight, 800), PICTURE_HEIGHT)) : undefined;
      // Accessibility basics, at desktop width: notes for the person, never a failure. A page that can't be read gives none.
      const a11y = await page.evaluate(A11Y_NOTES).catch(() => undefined);
      const images = await page.evaluate(LOOK_FACTS, false).catch(() => undefined);
      const art = await this.artFacts(page, combined);
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
      const fit = await page.evaluate(LOOK_FACTS, true).catch(() => undefined);
      const look = images && fit ? { ...fit, brokenImages: images.brokenImages, repeatedImages: images.repeatedImages, art } : undefined;
      const feelPhone = await page.evaluate(FEEL_FACTS, true).catch(() => undefined);
      const feel = feelDesktop ? { ...feelDesktop, covered: feelPhone?.covered ?? [], ...(feelPhone?.footer ? { footer: feelPhone.footer } : {}) } : undefined;
      const phonePicture = shot ? await this.pagePicture(page, `page-${shot}-phone.png`, combined) : undefined;
      const screenshots = { ...(desktopPicture ? { desktop: desktopPicture } : {}), ...(phonePicture ? { phone: phonePicture } : {}) };
      return { status: response?.status() ?? null, consoleChecked: true, consoleErrors, pageErrors, failedRequests,
        ...(overlay ? { overlay: overlay.slice(0, LOAD_TEXT) } : {}), phone, ...(a11y ? { a11y } : {}), ...(look ? { look } : {}), ...(feel ? { feel } : {}), ...(desktopPicture || phonePicture ? { screenshots } : {}) };
    } finally {
      combined.removeEventListener("abort", stop);
      await context?.close().catch(() => {});
      release();
    }
  }

  /** The drawn pictures' facts. When the page turns its own background dark in dark mode, each icon's colors are
   * compared in both modes, set on purpose (Chrome's default follows the computer): one that stays the same keeps its
   * light look on a dark page. An illustration's own colors are its art, so they are left alone. */
  private async artFacts(page: Page, signal: AbortSignal): Promise<ArtFacts> {
    const found: ArtFacts = { noViewBox: [], noName: [], fixedColors: [], fixedFiles: [] };
    signal.throwIfAborted();
    const facts = await page.evaluate(ART_FACTS, false).catch(() => undefined);
    signal.throwIfAborted();
    if (!facts?.items.length) return found;
    let light: Awaited<ReturnType<typeof ART_FACTS>> | undefined, dark: typeof light;
    if (facts.items.some(item => item.icon && (item.fixedInFile || (item.index !== undefined && facts.colors[item.index])))) {
      const scheme = async (value: string) => {
        signal.throwIfAborted();
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value }]);
        await page.evaluate(ANIMATIONS_DONE).catch(() => {});
        return page.evaluate(ART_FACTS, true);
      };
      try { light = await scheme("light"); dark = await scheme("dark"); } catch {} finally {
        await page.emulateMediaFeatures().catch(() => {});
        if (!signal.aborted) await page.evaluate(ANIMATIONS_DONE).catch(() => {});
      }
      signal.throwIfAborted();
    }
    const turnsDark = Boolean(light && dark && dark.background !== light.background);
    for (const item of facts.items) {
      if (item.big && !item.viewBox) found.noViewBox.push(item.name);
      if (!item.named) found.noName.push(item.name);
      if (!item.icon || !turnsDark) continue;
      if (item.index === undefined) { if (item.fixedInFile) found.fixedFiles.push(item.name); }
      else if (light?.colors[item.index] && dark?.colors[item.index] === light.colors[item.index]) found.fixedColors.push(item.name);
    }
    return { noViewBox: found.noViewBox.slice(0, 3), noName: found.noName.slice(0, 3), fixedColors: found.fixedColors.slice(0, 3), fixedFiles: found.fixedFiles.slice(0, 3) };
  }

  invalidate(): void { this.revision++; }

  /** A recorded check as it stands now: stale once a later edit or command ran, or its declared inputs changed. */
  private async current(entry: RecordedCheck): Promise<BrowserCheck> {
    const check = structuredClone(entry.check);
    if (entry.revision !== this.revision) { check.freshness = "stale"; check.reason = "Code/tool writes observed after this browser check."; }
    else if (entry.fingerprint) {
      const current = await inputState(this.options.projectRoot, entry.scenario);
      if (!current.fingerprint) { check.freshness = "unavailable"; check.reason = current.reason; }
      else if (current.fingerprint !== entry.fingerprint) { check.freshness = "stale"; check.reason = "Declared local inputs changed after this browser check."; }
    }
    return check;
  }

  /**
   * At the end of a task, before the receipt: Casper replays once each finished check this task ran (since `since`)
   * that a later edit or command made stale, with no model turn, so its fresh result counts. Only checks of a page on
   * this computer, and only local-test steps (one labelled "send" or "buy" only with Browser clicks on);
   * nothing is asked. A step or address that would need the person, a busy or closed browser, or a replay that can't
   * finish keeps the check as it was, and the browser stays open; one whose server is gone (see `openCheck`) is
   * incomplete instead. All replays share one minute. After the host's one repair turn, `retryFailures` also
   * reruns its fresh failures even if that turn made no edit; the same unattended restrictions still apply.
   */
  async replayStale(since: number, signal?: AbortSignal, onReplay?: (name: string, id: string) => void, retryFailures?: ReadonlySet<string>): Promise<void> {
    this.replayUntil = performance.now() + 60_000;
    try {
      for (const [id, entry] of this.scenarios) {
        if (this.controller.signal.aborted || signal?.aborted || this.work || !this.page || performance.now() > this.replayUntil - 1_000) return;
        if (entry.ranAt < since || !localURL(entry.scenario.url) || entry.check.status === "incomplete" || entry.check.status === "withdrawn"
          || ((await this.current(entry)).freshness !== "stale" && !(entry.check.status === "fail" && retryFailures?.has(id)))) continue;
        const kept = { check: entry.check, fingerprint: entry.fingerprint, revision: entry.revision, ranAt: entry.ranAt };
        onReplay?.(entry.check.name, id);
        this.unattended = true;
        const work = this.dispatch({ action: "replay", id }, signal);
        this.work = work;
        // A server that is gone, with none of Casper's to stand in, leaves nothing checked: incomplete, not the old result.
        try { await work; } catch (error) { if (!(error instanceof ServerGone)) Object.assign(entry, kept); }
        finally { this.unattended = false; if (this.work === work) this.work = undefined; }
      }
    } finally { this.replayUntil = undefined; }
  }

  async report(): Promise<BrowserReport> {
    const checks: BrowserCheck[] = [];
    for (const entry of this.scenarios.values()) checks.push(await this.current(entry));
    // A withdrawn check stays in the report, named, but never decides the result.
    const counted = checks.filter(check => check.status !== "withdrawn");
    return { status: counted.some(check => check.status === "fail") ? "fail" : !counted.length || counted.some(check => check.status !== "pass" || check.freshness !== "fresh") ? "incomplete" : "pass",
      checks, guidance: "Only these browser assertions were checked. Freshness covers declared local inputs, not the server build, external services or all requested behavior. Screenshots and model claims are not acceptance. Run relevant repository checks too." };
  }

  private async check(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    let id: string;
    if (input.action === "check") {
      const scenario = parseScenario(input.scenario);
      await this.askMetadata(scenario.url, signal);
      if (this.scenarios.size >= 24) throw new Error("Browser check limit reached (24 per session); replay the ids your checks returned instead of recording new ones");
      id = randomUUID();
      this.scenarios.set(id, { scenario, revision: this.revision, recordedRevision: this.revision, order: ++this.recorded, check: { id, name: scenario.name,
        scenarioSha256: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"), url: scenario.url, viewport: scenario.viewport,
        status: "incomplete", baseline: "incomplete", freshness: "unavailable", scope: scenario.scope, assertions: [] }, ranAt: performance.now() });
    } else {
      id = text(input.id, "id", 64);
      if (!this.scenarios.has(id)) throw new Error("Unknown browser check id; replay an id a check returned in this session, or record a check first");
      if (this.scenarios.get(id)!.check.status === "withdrawn") throw new Error("This check was withdrawn; record a new check instead of replaying it");
      await this.askMetadata(this.scenarios.get(id)!.scenario.url, signal);
    }
    const entry = this.scenarios.get(id)!;
    const { scenario } = entry;
    // A check whose recording never finished (no server yet) is recorded by its first finished run.
    const recording = input.action === "check" || entry.check.baseline === "incomplete";
    const check: BrowserCheck = { ...entry.check, status: "incomplete", freshness: "unavailable", assertions: [], reason: undefined, notes: undefined };
    entry.check = check; entry.fingerprint = undefined; entry.revision = this.revision; entry.ranAt = performance.now();
    const startedAt = performance.now();
    try {
      const before = await inputState(this.options.projectRoot, scenario, signal);
      await this.start(); signal.throwIfAborted();
      await this.page!.browserContext().close();
      const page = await this.newPage();
      this.logs.length = 0; this.requests.length = 0; this.dropped = 0;
      await page.setViewport(scenario.viewport);
      const notOpened = await this.openCheck(page, scenario.url, input.action === "replay", check, signal);
      if (notOpened.notOpened) throw new Error(`The page reached for a cloud metadata address (${notOpened.notOpened.join(", ")}) and the person said no`);
      // The steps share 8 s of watching for what they changed, so 12 steps on a busy page stay inside the check's limit.
      const watchBy = performance.now() + 8_000;
      const token = runToken();
      for (const [index, step] of scenario.steps.entries()) {
        signal.throwIfAborted();
        const value = step.value !== undefined && (step.action === "fill" || step.action === "select") ? step.value.replaceAll("{run}", token) : step.value;
        const done = await this.interact({ ...step, ...(value !== undefined ? { value } : {}) }, signal, true, watchBy);
        for (const line of [done.note, ...(done.dialogs as string[] | undefined ?? [])])
          if (typeof line === "string" && (check.notes ??= []).length < 8) check.notes.push(`step ${index + 1}: ${line}`);
        const after = await this.metadataAfter(page, signal);
        if (after.notOpened) throw new Error(`The page reached for a cloud metadata address (${after.notOpened.join(", ")}) and the person said no`);
      }
      for (const assertion of scenario.assertions) {
        signal.throwIfAborted();
        // withNear: on a selector that matches nothing or a wrong text, up to 3 real elements most like what was asked for.
        const evaluate = (withNear = false) => page.evaluate((a, withNear): { pass: boolean; actual: unknown; near?: string[]; inside?: boolean } => {
          const norm = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim();
          const nearest = (): string[] => {
            const words = (a.selector ?? "").toLowerCase().match(/[a-z][\w-]{2,}/g) ?? [];
            const expected = a.kind === "text" ? norm(a.expected).toLowerCase() : "";
            const scored: Array<{ score: number; text: string; el: Element }> = [];
            for (const el of [...document.body?.querySelectorAll("*") ?? []].slice(0, 3000)) {
              if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
              const tokens = [el.tagName.toLowerCase(), el.id.toLowerCase(), ...[...el.classList].map(c => c.toLowerCase()),
                ...["name", "aria-label", "data-testid"].map(n => (el.getAttribute(n) ?? "").toLowerCase())].filter(Boolean);
              const text = norm(el.textContent);
              let score = 0;
              for (const word of words) score += Math.max(0, ...tokens.map(t => t === word ? 3 : t.length > 2 && (t.includes(word) || word.includes(t)) ? 2 : 0));
              const lower = text.toLowerCase();
              if (expected && lower.length <= expected.length * 2 + 40) score += lower === expected ? 5 : lower.includes(expected) || (lower.length > 2 && expected.includes(lower)) ? 3 : 0;
              if (score) scored.push({ score, text, el });
            }
            // Best first; on a tie the innermost element (shortest text).
            return scored.sort((x, y) => y.score - x.score || x.text.length - y.text.length).slice(0, 3).map(({ el, text }) =>
              `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 2).map(c => `.${c}`).join("")}${text ? ` "${text.slice(0, 60)}"` : ""}`);
          };
          if (a.kind === "no-horizontal-overflow" && !a.selector) return { pass: document.documentElement.scrollWidth <= innerWidth, actual: { width: document.documentElement.scrollWidth, viewport: innerWidth } };
          const matches = document.querySelectorAll(a.selector!);
          if (matches.length !== 1) return { pass: false, actual: `Expected one element; found ${matches.length}`, ...(withNear && !matches.length ? { near: nearest() } : {}) };
          const el = matches[0]!;
          const r = el.getBoundingClientRect();
          // One element: content wider than the box (a table cut off behind a scroller), or the box past the viewport.
          if (a.kind === "no-horizontal-overflow") return { pass: el.scrollWidth <= el.clientWidth + 1 && r.right <= innerWidth + 1,
            actual: { contentWidth: el.scrollWidth, boxWidth: el.clientWidth, right: Math.round(r.right), viewport: innerWidth } };
          // Runs of spaces and line breaks count as one space on both sides; otherwise the text must match exactly.
          if (a.kind === "text") { const pass = norm(el.textContent) === norm(a.expected);
            return { pass, actual: norm(el.textContent).slice(0, 1024), ...(withNear && !pass ? { near: nearest(), inside: [...el.querySelectorAll("*")].some(child => norm(child.textContent) === norm(a.expected)) } : {}) }; }
          const visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width > 0 && r.height > 0;
          if (a.kind === "visible") return { pass: visible, actual: visible };
          const other = document.querySelectorAll(a.other);
          if (other.length !== 1) return { pass: false, actual: `Expected one other element; found ${other.length}` };
          const b = other[0]!.getBoundingClientRect();
          const overlap = r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
          return { pass: visible && b.width > 0 && b.height > 0 && !overlap, actual: { overlap } };
        }, assertion, withNear);
        let result = await evaluate();
        const deadline = performance.now() + 1000;
        while (!result.pass && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); signal.throwIfAborted(); result = await evaluate(); }
        if (!result.pass) result = await evaluate(true);
        // Still a failure: the hint only says which way to go, a wrong check or a wrong page. Not on the recording run: a
        // check recorded before the edit is meant to fail then, and must not be withdrawn for it. An element inside the
        // matched one that holds exactly the expected text means a selector written too wide, on any run.
        check.assertions.push({ kind: assertion.kind, status: result.pass ? "pass" : "fail", actual: result.actual,
          ...(result.near?.length ? { near: result.near } : {}),
          ...(result.inside ? { hint: INSIDE_HINT } : result.near && !recording ? { hint: BROKEN_CHECK_HINT } : {}) });
      }
      check.status = check.assertions.every(a => a.status === "pass") ? "pass" : "fail";
      if (check.status === "fail" && !recording && check.baseline === "pass" && fixedIdentity(scenario.steps))
        for (const assertion of check.assertions) if (assertion.status === "fail") assertion.hint = RUN_HINT;
      const after = await inputState(this.options.projectRoot, scenario, signal);
      if (before.fingerprint && after.fingerprint && before.fingerprint === after.fingerprint && entry.revision === this.revision) {
        check.freshness = "fresh"; entry.fingerprint = after.fingerprint;
        if (recording) entry.recordedFingerprint = after.fingerprint;
      } else { check.freshness = before.fingerprint && after.fingerprint ? "stale" : "unavailable"; check.reason = before.reason ?? after.reason ?? "Declared inputs changed during browser reproduction."; }
      if (recording) { check.baseline = check.status; entry.recordedRevision = entry.revision; }
      const result = structuredClone(check) as unknown as Record<string, unknown>;
      // The check is decided: reading the page after it can't change that, fail it or make it overrun.
      if (performance.now() - startedAt > FINAL_PAGE_AFTER_MS) return result;
      return { ...result, ...await this.finalPage(page, signal, FINAL_RESULT_BYTES - Buffer.byteLength(JSON.stringify(result))).catch(() => ({})) };
    } catch (error) {
      check.status = "incomplete"; check.reason = error instanceof ServerGone ? `Could not check. ${error.message}` : "Browser reproduction did not finish; no passing evidence.";
      // A step selector that matches several elements is a check written wrong, not a page that isn't ready: nothing is
      // kept, so it can't hold the result at incomplete. One that matches nothing may be a feature not built yet.
      if (input.action === "check" && error instanceof Error && /exactly one element; it matches ([2-9]|\d{2,})/.test(error.message)) {
        this.scenarios.delete(id);
        throw new Error(`${error.message}: name one element and record the check again (nothing was recorded)`);
      }
      // A new check that stopped part way still gets its id back: replay it once the page is ready, or withdraw it.
      if (input.action === "check" && error instanceof Error && !signal.aborted)
        throw new Error(`${error.message} (check id ${id}: replay it once the page is ready, or withdraw it if the check is wrong)`);
      throw error;
    }
  }

  /**
   * The page as the check left it, for the model only (never kept in the report): its short text and controls, and its
   * picture (sent when the model sees images, unless showPages is off). Casper's own end replays skip it; a part that
   * can't be read in time is left out, never a failure. Fewer controls, then shorter text, keep it within `budget` bytes.
   */
  private async finalPage(page: Page, signal: AbortSignal, budget: number): Promise<Record<PropertyKey, unknown>> {
    if (this.unattended || signal.aborted) return {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), FINAL_PAGE_MS); });
    const inTime = <T>(work: Promise<T>) => Promise.race([work.catch(() => undefined), late]);
    try {
      const summary = await inTime(page.evaluate(PAGE_SUMMARY, FINAL_TEXT, FINAL_ELEMENTS));
      if (!summary || signal.aborted) return {};
      const finalPage: Record<string, unknown> & typeof summary = { ...summary, note: "The page after the steps; no need to open, inspect or screenshot it again." };
      // Room for the picture's path.
      const size = () => Buffer.byteLength(JSON.stringify(finalPage)) + 300;
      while (size() > budget && finalPage.elements.length) finalPage.elements = finalPage.elements.slice(0, Math.floor(finalPage.elements.length / 2));
      if (size() > budget) finalPage.text = finalPage.text.slice(0, Math.max(0, finalPage.text.length - (size() - budget)));
      if (size() > budget) return {};
      if (this.options.checkPictures?.() === false || this.finalPictures >= FINAL_PICTURE_LIMIT) return { finalPage };
      const bytes = await inTime(page.screenshot({ type: "png", fullPage: false }));
      if (!bytes || signal.aborted || bytes.byteLength > 4 * 1024 * 1024) return { finalPage };
      this.finalPictures++;
      finalPage.screenshot = await this.savePicture(`check-${this.finalPictures}.png`, bytes, signal).catch(() => undefined);
      return { finalPage, [SCREENSHOT_PNG]: Buffer.from(bytes).toString("base64") };
    } finally { clearTimeout(timer); }
  }

  /**
   * Opens a check's page. On a replay whose loopback server refuses the connection (the AI's own server, stopped),
   * the same path opens on the server Casper runs for this project (serve, or the page checks' slot), noted in the
   * check; with none up the replay throws ServerGone. A page on another computer is never redirected.
   */
  private async openCheck(page: Page, url: string, replay: boolean, check: BrowserCheck, signal: AbortSignal): Promise<{ notOpened?: string[]; note?: string }> {
    try { return await this.navigate(page, url, signal); }
    catch (error) {
      if (!replay || !localURL(url) || !/ERR_CONNECTION_REFUSED/.test(String(error))) throw error;
      const gone = new URL(url), services = this.options.services?.();
      const managed = this.server?.origin() ?? (services && !services.closed ? services.origin(DEV_SLOT) : undefined);
      if (!managed || managed === gone.origin) throw new ServerGone(`Nothing answers at ${gone.origin} any more and Casper runs no server for this project; start it with serve and replay`);
      (check.notes ??= []).push(`opened on Casper's server ${managed}: nothing answers at ${gone.origin} any more`);
      return await this.navigate(page, new URL(`${gone.pathname}${gone.search}${gone.hash}`, managed).href, signal);
    }
  }

  /**
   * Takes a check the AI wrote wrong (a wrong expected text or selector) out of what decides the result. Only a check
   * whose last run failed, with nothing changed since it was recorded (no edit or command, its inputs the same): a
   * page fixed after the failure is replayed, never withdrawn. After a change it may still be withdrawn when it names
   * its replacement (replacedBy): a check of the same page recorded after it whose latest run passed, which then
   * decides the result in its place. The check stays in the report as withdrawn, with the reason.
   */
  private async withdraw(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = text(input.id, "id", 64);
    const reason = text(input.reason, "reason", 200);
    const entry = this.scenarios.get(id);
    if (!entry) throw new Error("Unknown browser check id; withdraw an id a check returned in this session");
    const status = entry.check.status;
    if (status === "withdrawn") throw new Error("This check is already withdrawn");
    if (status === "pass") throw new Error("Only a failed or unfinished check can be withdrawn; this one passed");
    const replacement = input.replacedBy === undefined ? undefined : this.replacement(id, entry, text(input.replacedBy, "replacedBy", 64));
    const withdrawn = replacement ? `${reason} (replaced by ${JSON.stringify(replacement.check.name)}, ${replacement.check.id})` : reason;
    const done = () => {
      entry.check = { ...entry.check, status: "withdrawn", withdrawn };
      return { id, name: entry.check.name, status: "withdrawn", reason: withdrawn,
        guidance: replacement ? "It no longer decides the result; its replacement does, and the receipt names both."
          : "It no longer decides the result; the receipt names it with your reason. Record a corrected check for what it meant to test." };
    };
    if (replacement) return done();
    // One that never finished has no inputs recorded: nothing run since it was recorded is enough.
    if (status === "incomplete") {
      if (entry.recordedRevision !== this.revision || entry.revision !== entry.recordedRevision)
        throw new Error(`A change was made after this check was recorded: replay it, ${REPLACE_WAY}`);
      return done();
    }
    const now = await this.current(entry);
    if (now.freshness === "stale") throw new Error(`${(now.reason ?? "A change was made after this check failed").replace(/\.$/, "")}: fix the page and replay it, ${REPLACE_WAY}`);
    if (now.freshness !== "fresh") throw new Error(`Casper can't tell whether anything changed since this check failed (${(now.reason ?? "its inputs were not recorded").replace(/\.$/, "")}); replay it`);
    // A replay after a change resets freshness, so a check that still fails after a fix must not look withdrawable.
    if (entry.recordedRevision !== this.revision || entry.fingerprint !== entry.recordedFingerprint)
      throw new Error(`A change was made after this check was recorded, so its failure may be real: fix the page, ${REPLACE_WAY}`);
    return done();
  }

  /** The check `replacedBy` names, when it may take the place of check `id`: recorded after it, its latest run
   * passed, and it opens the same page (the same path; the query, port and host may differ) at the same viewport,
   * with at least as many steps and assertions of each kind, so a page-loads check can't stand in for a real one. */
  private replacement(id: string, entry: RecordedCheck, other: string): RecordedCheck {
    const by = this.scenarios.get(other);
    if (!by || other === id) throw new Error("replacedBy must be the id of another check recorded in this session");
    if (by.order < entry.order) throw new Error("replacedBy must name a check recorded after this one");
    const page = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };
    if (page(by.scenario.url) !== page(entry.scenario.url)) throw new Error(`replacedBy must check the same page as this one (${page(entry.scenario.url)}), not ${page(by.scenario.url)}`);
    const was = entry.scenario, is = by.scenario;
    if (was.viewport.width !== is.viewport.width || was.viewport.height !== is.viewport.height)
      throw new Error(`replacedBy must check the page at the same viewport as this one (${was.viewport.width}×${was.viewport.height})`);
    const count = (kinds: string[]) => kinds.reduce((map, kind) => map.set(kind, (map.get(kind) ?? 0) + 1), new Map<string, number>());
    const steps = count(is.steps.map(step => step.action)), assertions = count(is.assertions.map(a => a.kind));
    const short = [...[...count(was.steps.map(step => step.action))].filter(([kind, n]) => (steps.get(kind) ?? 0) < n).map(([kind]) => `${kind} steps`),
      ...[...count(was.assertions.map(a => a.kind))].filter(([kind, n]) => (assertions.get(kind) ?? 0) < n).map(([kind]) => `${kind} assertions`)];
    if (short.length) throw new Error(`replacedBy must test at least what this check did; it has fewer ${short.join(", ")}`);
    if (by.check.status !== "pass") throw new Error("replacedBy must name a check whose latest run passed; fix it and replay it first");
    return by;
  }

  private async interact(input: Record<string, unknown>, signal: AbortSignal, waitForTarget = false, watchBy = Infinity): Promise<Record<string, unknown>> {
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
      if (matches.length !== 1) throw new Error(`Browser selector must match exactly one element; it matches ${matches.length}`);
      const el = matches[0]!;
      return { url: location.href, tag: el.tagName, type: el.getAttribute("type") ?? "", autocomplete: el.getAttribute("autocomplete") ?? "",
        target: [el.getAttribute("aria-label"), el.textContent, el.getAttribute("name"), el.getAttribute("href")].filter(Boolean).join(" ").slice(0, 1024) };
    }, selector);
    // A check step waits up to 5 s for content that loads later (a time slot, a fetched list): while its selector
    // matches nothing, or its one element is disabled. Several matches still fail at once (a check written wrong).
    if (waitForTarget) {
      const until = performance.now() + 5_000;
      const pending = () => page.evaluate((selector) => {
        const matches = document.querySelectorAll(selector);
        return matches.length === 0 || (matches.length === 1 && ((matches[0] as HTMLButtonElement).disabled === true || matches[0]!.getAttribute("aria-disabled") === "true"));
      }, selector).catch((error: unknown) => /context was destroyed|navigat|detached/i.test(String(error))); // a page still opening after the last step
      while (performance.now() < until && await pending()) { await new Promise(resolve => setTimeout(resolve, 100)); signal.throwIfAborted(); }
    }
    const before = await describe();
    const type = before.type.toLowerCase();
    if (type === "file" || /one-time-code|cc-/i.test(before.autocomplete)) throw new Error("Payment, one-time-code and file-upload inputs are outside this browser slice");
    // A password field: only a made-up test account on a page on this computer, so the AI can test a login it built.
    const password = type === "password" || /password/i.test(before.autocomplete);
    if (password && (!localURL(before.url) || String(input.impact) !== "local-test"))
      throw new Error("A password field is filled only as a local test on a page on this computer, with a made-up test account");
    if (action === "fill" && before.tag === "SELECT") throw new Error("Fill does not set a <select>; use action select with the option's value or label");
    if (action === "fill" && before.tag !== "TEXTAREA" && (before.tag !== "INPUT" || !(TYPED_FIELDS.includes(type) || password || PICKED_FIELDS.includes(type)))) {
      throw new Error(`Fill takes a textarea or an input of type ${[...TYPED_FIELDS.filter(Boolean), ...PICKED_FIELDS].join(", ")}`);
    }
    if (action === "select" && before.tag !== "SELECT") throw new Error("Select takes a <select>; use fill for a text field, or click the options of a custom menu");
    const allowAll = this.options.allowActions?.();
    const held = actionHold({ impact: String(input.impact), url: before.url, target: before.target, allowAll: !this.unattended && allowAll });
    // Casper's own end replay: with Browser clicks on, a local test on this computer runs whatever its label ("Send" on
    // a contact form), as it did when the model ran it; any other step still never runs unasked.
    const hold = held?.word && this.unattended && allowAll ? undefined : held;
    if (hold) {
      const approved = !this.unattended && await this.options.confirm?.({ action, selector, url: before.url, target: before.target,
        ...(value === undefined ? {} : { value: password ? "••••••••" : value }), reason, impact: String(input.impact) }, signal);
      signal.throwIfAborted();
      if (!approved) throw new Error(`Browser action requires human approval; not executed. ${!localURL(before.url) ? "It is on a page that is not on this computer."
        : hold.word ? `Its label has "${hold.word}", so it asks even as a local test; other local-test actions on this page run without asking.`
        : "It is not marked local-test."} Browser clicks are off (/settings), and a run that can't ask says no.`);
      if (JSON.stringify(await describe()) !== JSON.stringify(before)) throw new Error("Browser target changed during approval; inspect it again");
    }
    signal.throwIfAborted();
    const element = await page.$(selector);
    if (!element) throw new Error("Browser target disappeared");
    let selected: { value: string; label: string } | undefined;
    let note: string | undefined;
    let outlineBefore: PageOutline | undefined, urlBefore = "", focusHere = false;
    const key = `__casper_${randomUUID().replace(/-/g, "")}`;
    try {
      await settleInView(element);
      // A click or typing lands where a person's would: on whatever covers the element's center. A cover that is going
      // away (a closing menu, a fading toast) gets up to a second.
      let cover = await coverOf(element);
      const typed = action === "fill" && !(before.tag === "INPUT" && PICKED_FIELDS.includes(type));
      if (action === "click" || typed) {
        for (const end = performance.now() + 1000; cover.by && performance.now() < end;) {
          await new Promise(resolve => setTimeout(resolve, 100)); signal.throwIfAborted(); cover = await coverOf(element);
        }
        if (cover.by) throw new Error(`${cover.target} is covered by ${cover.by}, so a person could not ${action === "click" ? "click" : "type in"} it; close or wait out what covers it first`);
      }
      // Watch what the action changes: the DOM, the address, focus, scrolling, the field's state, requests, dialogs.
      await element.evaluate((el, key) => {
        const watch = { changes: 0, el, active: document.activeElement, observer: new MutationObserver(list => { watch.changes += list.length; }) };
        watch.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        Object.defineProperty(window, key, { value: watch, configurable: true });
      }, key);
      const initial = await page.evaluate(watchState, key);
      outlineBefore = await page.evaluate(pageOutline, element).catch(() => undefined);
      urlBefore = page.url();
      const requests = this.requestsStarted, popups = this.popups;
      this.dialogs.length = 0;
      // No automatic retry after a potentially consequential action.
      if (action === "click") await element.click();
      else if (action === "select") {
        // By the option's value first, then its label, as a person picks it; input and change fire as they would.
        const picked = await element.evaluate((el, next) => {
          const options = [...(el as HTMLSelectElement).options];
          const option = options.find(o => o.value === next) ?? options.find(o => o.label.trim() === next.trim());
          if (!option || option.disabled) return { missing: options.slice(0, 20).map(o => o.value === o.label.trim() ? o.value : `${o.value} (${o.label.trim()})`) };
          option.selected = true;
          el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
          return { picked: { value: option.value, label: option.label.trim() } };
        }, value!);
        if (!picked.picked) throw new Error(`The select has no option ${JSON.stringify(value!.slice(0, 40))}; its options are ${(picked.missing ?? []).join(", ").slice(0, 600)}`);
        selected = picked.picked;
      }
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
      // Up to 1.5 s, ending 300 ms after the page goes quiet; a fill or select need not change anything else.
      const quiet = action === "fill" || action === "select";
      // A new tab (a target="_blank" link, window.open) is a change too. Cut short by a check's shared budget: no note.
      let last = `${initial}|${requests}|0|${popups}`, changed = false;
      const full = performance.now() + 1_500, end = Math.min(full, watchBy), cut = watchBy < full;
      for (let calm = performance.now(); performance.now() < end;) {
        await new Promise(resolve => setTimeout(resolve, 100)); signal.throwIfAborted();
        const state = await page.evaluate(watchState, key).catch(() => undefined);
        if (state === undefined) { changed = true; break; } // a new document
        const now = `${state}|${this.requestsStarted}|${this.dialogs.length}|${this.popups}`;
        if (now !== last) { last = now; calm = performance.now(); changed = true; }
        if ((changed || quiet) && performance.now() - calm >= 300) break;
      }
      if (!changed && !cut && (action === "click" || action === "press"))
        note = action === "click" ? `nothing changed after clicking ${cover.target}` : `nothing changed after pressing ${value} on ${cover.target}`;
    } finally {
      await page.evaluate(key => { (window as unknown as Record<string, { observer?: MutationObserver }>)[key]?.observer?.disconnect(); }, key).catch(() => {});
      focusHere = await element.evaluate(el => el.isConnected && el.contains(document.activeElement)).catch(() => false);
      await element.dispose();
    }
    signal.throwIfAborted();
    const dialogs = this.dialogs.map(dialogNote);
    // What changed, as a person would see it; a page still opening after a new address gives only the address.
    const outlineAfter = outlineBefore && !note ? await page.evaluate(pageOutline).catch(() => undefined) : undefined;
    // Focus on the element the action used (or the same control drawn again) is not news: only focus that moved
    // elsewhere (an error field, a dialog) is named.
    const { focus, ...seen } = outlineBefore && outlineAfter ? outlineChanges(outlineBefore, outlineAfter) ?? {} : {};
    const changes = { ...(page.url() !== urlBefore ? { previousUrl: urlBefore } : {}), ...seen, ...(focus && !focusHere && focus !== outlineBefore?.target ? { focus } : {}) };
    return { action, url: page.url(), executed: true, ...(selected ? { selected } : {}), ...(Object.keys(changes).length ? { changes } : {}), ...(note ? { note } : {}), ...(dialogs.length ? { dialogs } : {}),
      guidance: "Action execution is not proof of the expected result. Inspect or replay assertions." };
  }

  private start(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return Promise.resolve(this.page);
    return this.startup ??= (async () => {
      const supplied = this.options.executablePath ?? process.env.CASPER_BROWSER_EXECUTABLE;
      const executablePath = await discoverBrowser(supplied);
      if (!executablePath || !path.isAbsolute(executablePath)) throw new Error("Browser unavailable: install Chrome yourself or set CASPER_BROWSER_EXECUTABLE to an absolute executable path");
      const { default: puppeteer } = await import("puppeteer-core");
      // A first Chrome start on a cold machine sometimes never answers (seen on fresh Windows runners): that attempt
      // is stopped after FIRST_START_MS and one fresh Chrome is started, with the running action's deadline renewed.
      for (let attempt = 1; ; attempt++) {
        const slow = new AbortController();
        const timer = attempt === 1 ? setTimeout(() => slow.abort(new Error("Chrome did not answer")), this.options.firstStartMs ?? FIRST_START_MS) : undefined;
        try {
          return await this.launch(puppeteer, executablePath, AbortSignal.any([this.controller.signal, slow.signal]));
        } catch (error) {
          if (this.controller.signal.aborted || attempt >= 2) throw error;
          await this.discardChrome();
          this.deadline?.resume();
        } finally { clearTimeout(timer); }
      }
    })();
  }
  private async launch(puppeteer: typeof import("puppeteer-core").default, executablePath: string, signal: AbortSignal): Promise<Page> {
    signal.throwIfAborted();
    this.profile = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-browser-")));
    signal.throwIfAborted();
    const browser = this.browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, userDataDir: this.profile,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, signal, timeout: 10_000,
      env: browserEnvironment(this.profile) });
    const chrome = browser.process();
    if (chrome) this.chromeOwner = ownSpawnedTree(chrome.pid, () => chrome.exitCode === null && chrome.signalCode === null);
    browser.on("disconnected", () => { if (!this.controller.signal.aborted && browser === this.browser) void this.chromeStopped(); });
    signal.throwIfAborted();
    return await Promise.race([this.newPage(), new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })]);
  }
  /** Chrome died under the session (a crash, the OS killing it). Evidence it gave is already stale. Up to
   * MAX_RESTARTS times the next action starts a fresh Chrome; then, or if its processes can't be confirmed gone,
   * the session closes as before. The app server the session started keeps running. */
  private async chromeStopped(): Promise<void> {
    this.invalidate();
    if (this.closeWork) return;
    if (this.restarts >= MAX_RESTARTS) { void this.close().catch(() => {}); return; }
    this.restarts++;
    this.restarted = "Chrome stopped unexpectedly and Casper started a new one. The page and anything typed into it are gone: open it again.";
    await this.discardChrome();
  }
  /** Stops this Chrome's process tree and removes its profile, leaving the session open for a fresh start. */
  private async discardChrome(): Promise<void> {
    const browser = this.browser, owner = this.chromeOwner, profile = this.profile, child = browser?.process();
    this.browser = undefined; this.chromeOwner = undefined; this.profile = undefined; this.page = undefined; this.startup = undefined;
    await owner?.captureCurrent().catch(() => {});
    const outcome = await terminateTree(owner, child?.pid, "SIGKILL");
    await browser?.disconnect().catch(() => {});
    if (outcome === "unknown") {
      this.cleanupError = new ProcessCleanupError(owner);
      void this.close().catch(() => {});
      return;
    }
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
  private async newPage(): Promise<Page> {
      const context = await this.browser!.createBrowserContext({ downloadBehavior: { policy: "deny" } });
      this.page = await context.newPage();
      this.page.setDefaultTimeout(5000);
      await this.page.setViewport({ width: 1280, height: 800 });
      this.page.on("dialog", dialog => {
        if (this.dialogs.length < 5) this.dialogs.push({ type: dialog.type(), message: dialog.message().replace(/\s+/g, " ").trim().slice(0, 200) });
        void dialog.dismiss().catch(() => {});
      });
      this.page.on("request", () => { this.requestsStarted++; });
      this.page.on("popup", () => { this.popups++; });
      this.page.on("console", message => this.log({ type: message.type(), text: message.text().slice(0, 1024) }));
      this.page.on("pageerror", error => this.log({ type: "exception", text: String(error).slice(0, 1024) }));
      const page = this.page, browser = this.browser;
      this.page.on("error", () => { if (!this.controller.signal.aborted && browser === this.browser && page === this.page) void this.chromeStopped(); });
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
    if (outcome === "unknown") throw new ProcessCleanupError(this.chromeOwner);
    // Windows frees a stopped Chrome's files a moment after it exits; a temp profile that still can't be removed is left
    // behind, never reported as the task failing.
    if (this.profile) await rm(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

/** Chrome's environment: no secrets, and its home and temp in the throwaway profile. On Windows USERPROFILE stays as
 * Casper has it, as Playwright and Puppeteer leave it: Chrome started with any other USERPROFILE (even an empty folder)
 * never answers (headless, Chrome 155). The profile (userDataDir) is what keeps it away from the user's own Chrome. */
export function browserEnvironment(profile: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const additions: Record<string, string> = env.DISPLAY ? { DISPLAY: env.DISPLAY } : {};
  if (platform === "win32" && env.USERPROFILE) additions.USERPROFILE = env.USERPROFILE;
  return isolatedEnvironment(profile, additions);
}
