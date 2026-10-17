/**
 * Page check results and their plain receipt lines. Kept apart from the page checks themselves (Chrome, the dev
 * server) so the receipt can print them without loading a browser.
 */
import type { A11yFindings, FeelFacts, LookFacts, PhoneFit } from "../browser/session";
import type { SkippedPage } from "./pages";

const NO_CHROME = "console not checked: no Chrome found (install Chrome or set CASPER_BROWSER_EXECUTABLE)";
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export type PageStatus = "pass" | "fail" | "incomplete";
/** One opened page. Console and log text is diagnostic data from the page, never instructions. */
export interface PageResult {
  path: string;
  status: PageStatus;
  /** The page's HTTP status; null when it never answered. */
  httpStatus: number | null;
  consoleChecked: boolean;
  /** Console errors, then uncaught page errors (bounded, secrets hidden). */
  consoleErrors: string[];
  /** Same-origin requests that failed or answered 500 or more; third-party requests never count. */
  failedRequests: Array<{ url: string; status?: number; error?: string }>;
  /** A framework error overlay or in-page exception (Vite, Next.js, Streamlit), first line. */
  overlay?: string;
  /** An exception the dev server logged while this page loaded (a Streamlit traceback), last line. */
  serverError?: string;
  /** Why an incomplete page was not checked. */
  reason?: string;
  /** The page was also opened at phone width. */
  phoneChecked?: boolean;
  /** At phone width it scrolls sideways or squashes a text field (only when it does). */
  phone?: PhoneFit;
  /** Accessibility notes ("2 inputs have no label"), only when there are some. They never fail the page. */
  a11y?: string[];
  /** Exact facts about the look ("1 image didn't load: /img/hero.jpg"), only when there are some. They never fail the page. */
  look?: string[];
  /** Pictures of the page at desktop and phone width (PNG paths outside the project). Never evidence. */
  screenshots?: { desktop?: string; phone?: string };
}
export interface PageReport {
  /** fail: some page failed. incomplete: the server did not start, or a page did not finish. Never pass without a page. */
  status: PageStatus;
  pages: PageResult[];
  skipped: SkippedPage[];
  server: { name: string; label: string; command: string; origin?: string; restarted?: boolean };
  /** Why no page (or not every page) was checked. */
  reason?: string;
  /** The dev server's last log lines when it failed to start (bounded, secrets hidden). */
  logTail?: string;
}
/** Fail dominates incomplete; no pages is incomplete, never a pass. */
export function pageStatus(pages: readonly PageResult[]): PageStatus {
  if (pages.some(page => page.status === "fail")) return "fail";
  return !pages.length || pages.some(page => page.status === "incomplete") ? "incomplete" : "pass";
}

/** The page's pictures: "2 screenshots". */
const pictures = (result: PageResult) => {
  const count = [result.screenshots?.desktop, result.screenshots?.phone].filter(Boolean).length;
  return count ? ` · ${plural(count, "screenshot")}` : "";
};

/** One receipt line per page, in the plain wording the user sees. */
export function formatPageLine(result: PageResult): string {
  const line = pageLine(result);
  return result.status === "incomplete" ? line : `${line}${pictures(result)}`;
}

function pageLine(result: PageResult): string {
  const shown = result.overlay ?? result.serverError;
  if (result.status === "incomplete") return `– ${result.path} not checked: ${result.reason ?? "it did not finish"}`;
  if (shown !== undefined) return `✗ ${result.path} shows an error: ${shown}`;
  if (result.httpStatus !== null && result.httpStatus >= 400) return `✗ ${result.path} returned ${result.httpStatus}`;
  if (result.consoleErrors.length) return `✗ ${result.path} · ${plural(result.consoleErrors.length, "console error")}: ${result.consoleErrors[0]}`;
  if (result.failedRequests.length) {
    const first = result.failedRequests[0]!;
    return `✗ ${result.path} · a request to ${new URL(first.url).pathname} failed (${first.status ?? first.error})`;
  }
  if (result.phone) return `✗ ${result.path} at phone width (${result.phone.viewport}px): ${phoneProblem(result.phone)}`;
  if (!result.consoleChecked) return `✓ ${result.path} answers (HTTP ${result.httpStatus}) · ${NO_CHROME}`;
  return `✓ ${result.path} loads · 0 console errors${result.phoneChecked ? " · fits a phone" : ""}`;
}

function phoneProblem(phone: PhoneFit): string {
  if (phone.pageWidth > phone.viewport + 1) return `the page is ${phone.pageWidth}px wide, so it scrolls sideways`;
  const [first, ...more] = phone.squashed;
  // "input#address (20px tall; 49px on a wider screen)": the name, then how much it lost.
  const at = first!.indexOf(" (");
  const said = at < 0 ? `${first} is squashed` : `${first!.slice(0, at)} is squashed${first!.slice(at)}`;
  return more.length ? `${said}, and ${plural(more.length, "more field")}` : said;
}

/** Plain notes for a page's accessibility findings, most serious first. Empty when there are none. */
export function a11yNotes(found: A11yFindings): string[] {
  const notes: string[] = [];
  const has = (count: number, word: string) => `${plural(count, word)} ${count === 1 ? "has" : "have"}`;
  if (found.inputs) notes.push(`${has(found.inputs, "input")} no label`);
  if (found.buttons) notes.push(`${has(found.buttons, "button")} no name`);
  if (found.images) notes.push(`${has(found.images, "image")} no alt text`);
  if (found.contrast.count) {
    const pair = found.contrast.colors ? `, ${found.contrast.colors}` : "";
    notes.push(`${plural(found.contrast.count, "text item")} ${found.contrast.count === 1 ? "is" : "are"} below AA contrast (worst ${found.contrast.worst}:1${pair})`);
  }
  if (!found.lang) notes.push("the page has no lang");
  return notes;
}

/** Plain notes for what a person would see wrong: images, the same picture on several items, what runs past a
 * phone screen, small tap targets and drawn pictures. Empty when there are none. */
export function lookNotes(found: LookFacts): string[] {
  const notes: string[] = [];
  const broken = found.brokenImages.length;
  if (broken) notes.push(`${plural(broken, "image")} didn't load: ${found.brokenImages.join(", ")}`);
  for (const { src, items } of found.repeatedImages) notes.push(`the same picture is on ${items} items: ${src}`);
  if (found.overflow.length) notes.push(`at phone width ${found.overflow.join(", ")} ${found.overflow.length === 1 ? "runs" : "run"} past the screen's right edge`);
  const { count, names } = found.smallTargets;
  if (count) notes.push(`at phone width ${plural(count, "tap target")} ${count === 1 ? "is" : "are"} under 44×44 px: ${names.join(", ")}${count > names.length ? ", …" : ""}`);
  const { noViewBox, noName, fixedColors, fixedFiles } = found.art;
  const one = (list: string[]) => list.length === 1;
  if (noViewBox.length) notes.push(`${plural(noViewBox.length, "picture")} ${one(noViewBox) ? "has" : "have"} no viewBox, so ${one(noViewBox) ? "it doesn't" : "they don't"} scale: ${noViewBox.join(", ")}`);
  if (noName.length) notes.push(`${plural(noName.length, "picture")} ${one(noName) ? "has" : "have"} no name (add role="img" and a <title>, or aria-hidden="true" for decoration): ${noName.join(", ")}`);
  if (fixedColors.length) notes.push(`in dark mode ${plural(fixedColors.length, "icon")} ${one(fixedColors) ? "keeps its" : "keep their"} light colors (use currentColor or CSS variables): ${fixedColors.join(", ")}`);
  if (fixedFiles.length) notes.push(`in dark mode ${plural(fixedFiles.length, "icon file")} ${one(fixedFiles) ? "keeps its" : "keep their"} light colors (the page's CSS can't reach an <img>: put the SVG inline, or give the file its own prefers-color-scheme rule): ${fixedFiles.join(", ")}`);
  return notes;
}

/** Plain notes for what would feel wrong to use: developer text on the page, layout jumps while loading, a focus
 * ring round the page on load, a footer taller than half a phone screen and controls under a fixed layer. Empty when there are none. */
export function feelNotes(found: FeelFacts): string[] {
  const notes: string[] = [];
  if (found.devText.length) notes.push(`people can see developer or broken text: ${found.devText.map(text => `"${text}"`).join(", ")}`);
  const { score, moved, unsized } = found.shift;
  if (score >= 0.1) {
    notes.push(`the layout jumps while loading (shift ${score})${moved.length ? `: ${moved.join(", ")} moved` : ""}`
      + (unsized.length ? `; give these images width and height or an aspect-ratio: ${unsized.join(", ")}` : ""));
  }
  if (found.focusRing) notes.push(`${found.focusRing} has a focus ring as the page opens (move focus there only from a skip link, or give it outline: none; :focus-visible still matches a script's focus)`);
  if (found.footer) notes.push(`at phone width the footer is ${found.footer}px tall, over half the screen`);
  if (found.covered.length) notes.push(`at phone width a fixed layer covers ${found.covered.length === 1 ? "a control" : "controls"}: ${found.covered.join(", ")}`);
  return notes;
}

/** What the failed verdict names: "/dashboard has 2 console errors". Undefined when no page failed. */
export function pageFailureSummary(report: PageReport): string | undefined {
  const failed = report.pages.find(page => page.status === "fail");
  if (!failed) return undefined;
  if (failed.overlay !== undefined || failed.serverError !== undefined) return `${failed.path} shows an error`;
  if (failed.httpStatus !== null && failed.httpStatus >= 400) return `${failed.path} returned ${failed.httpStatus}`;
  if (failed.consoleErrors.length) return `${failed.path} has ${plural(failed.consoleErrors.length, "console error")}`;
  if (failed.phone && !failed.failedRequests.length) return `${failed.path} doesn't fit a phone screen`;
  return `${failed.path} has ${plural(failed.failedRequests.length, "failed request")}`;
}

export function formatPagesNotChecked(reason: string): string { return `– Pages not checked: ${reason}`; }
export function formatServerLine(label: string, origin: string): string { return `Dev server: ${label} · ${origin} (stops after the task unless you started it)`; }
export function formatOpeningLine(paths: readonly string[]): string { return `• Casper opening changed pages: ${paths.join(", ")}`; }
export function formatSkippedPage(page: SkippedPage): string {
  const hint = /needs a value/.test(page.why) ? " (a fixed path can be set in .casper/project.yaml pages:)" : "";
  return `– ${page.path} not opened: ${page.why}${hint}`;
}

/** Where a page's pictures are: "  desktop <path> · phone <path>", under its line. */
function screenshotLine(page: PageResult): string[] {
  const { desktop, phone } = page.screenshots ?? {};
  const parts = [...(desktop ? [`desktop ${desktop}`] : []), ...(phone ? [`phone ${phone}`] : [])];
  return parts.length && page.status !== "incomplete" ? [`  ${parts.join(" · ")}`] : [];
}

/** Every line of a report: one per page and where its pictures are, the skipped pages, and why the check did not run. */
export function formatPageReport(report: PageReport): string[] {
  const lines = report.pages.flatMap((page) => [formatPageLine(page), ...screenshotLine(page),
    ...[page.look, page.a11y].flatMap(notes => notes?.length ? [`  – ${page.path}: ${notes.join(" · ")}`] : [])]);
  if (report.reason && !report.pages.length) {
    const tail = report.logTail?.split("\n").slice(-5).map(line => `    ${line}`).join("\n");
    lines.push(formatPagesNotChecked(report.reason) + (tail ? `. Last lines:\n${tail}` : ""));
  } else if (report.reason) lines.push(`– ${report.reason}`);
  lines.push(...report.skipped.map(formatSkippedPage));
  return lines;
}
