/** The one turn at the end of a task, after Casper's end replay, that asks the AI to finish its browser checks: ones that
 * never finished, ones written wrong or answered Cancel, a page whose checks were all withdrawn, and a page build with no
 * browser check at all. Not a repair: it changes nothing in the app. Pure, so it is tested on its own. */

import { localURL, type BrowserCheck } from "../browser/scenario";
import type { VerificationReport } from "../verify/evidence";
import { ROUND_MAX_TURNS } from "../task/review";

/** A browser check of this task's that never finished: not one written wrong, answered Cancel, whose server is gone or
 * that Casper couldn't replay (each keeps its own reason on the receipt). */
export const unfinishedCheck = (check: BrowserCheck): boolean =>
  check.status === "incomplete" && !check.gone && !check.cancelled && !check.writtenWrong && !check.notReplayed;
/** Turns the AI has to finish or withdraw its unfinished browser checks: a round's, as recording a replacement and then
 * withdrawing, for each check, took more than 6 in a tracker build. */
export const FINISH_TURNS = ROUND_MAX_TURNS;
/** Changed pages a page build is asked to check in a browser, at most. */
const MAX_PAGES = 5;

export interface FinishGroups {
  /** Recorded in this task and never finished (a step stopped part way, a sign-in page). */
  unfinished: BrowserCheck[];
  /** Written wrong or answered Cancel, of a page on this computer: they show nothing about the page until a corrected
   * check replaces them. */
  fixable: BrowserCheck[];
  /** Pages on this computer whose every check was withdrawn, with those checks. */
  pageLeft: Array<{ path: string; checks: BrowserCheck[] }>;
  /** Changed pages of a page build with no browser check at all. */
  noCheck: string[];
}

/** The page a check opens, as the browser compares a replacement with it: its path (the query, port and host may differ). */
const checkedPage = (url: string): string => { try { return new URL(url).pathname; } catch { return url; } };

/** What the finish turn asks about, from the browser's report and the changed pages a page build may be asked to check
 * (empty unless pagesToCheck gave them). A check of a page that isn't on this computer (another site) is fixed or
 * replaced in no finish turn: Casper doesn't replay it, and dialog: "accept" works only here. */
export function checksToFinish(report: { readonly checks: readonly BrowserCheck[] }, pagePaths: readonly string[] = []): FinishGroups {
  const { checks } = report;
  const pageLeft = new Map<string, BrowserCheck[]>();
  for (const check of checks) if (check.status === "withdrawn" && localURL(check.url)) {
    const page = checkedPage(check.url);
    if (!checks.some((other) => other.status !== "withdrawn" && localURL(other.url) && checkedPage(other.url) === page)) pageLeft.set(page, [...pageLeft.get(page) ?? [], check]);
  }
  return {
    unfinished: checks.filter(unfinishedCheck),
    fixable: checks.filter((check) => check.status === "incomplete" && Boolean(check.writtenWrong || check.cancelled) && !check.gone && !check.notReplayed
      && localURL(check.url)),
    pageLeft: [...pageLeft].map(([path, withdrawn]) => ({ path, checks: withdrawn })),
    noCheck: checks.length ? [] : [...pagePaths],
  };
}

export const finishNeeded = (groups: FinishGroups): boolean =>
  groups.unfinished.length + groups.fixable.length + groups.pageLeft.length + groups.noCheck.length > 0;

/** The changed pages a page build is asked to check in a browser: only an auto-checked build or fix whose checks passed,
 * with the browser tool on and Chrome here; the passing pages of Casper's page check, at most 5. */
export function pagesToCheck(input: { mode: string; intent: string; readOnly: boolean; verification?: VerificationReport; browserOff: boolean; installed: boolean }): string[] {
  if (input.mode !== "auto" || (input.intent !== "implement" && input.intent !== "fix") || input.readOnly || input.browserOff || !input.installed
    || input.verification?.status !== "pass") return [];
  const passed = (input.verification.pages?.pages ?? []).filter((page) => page.status === "pass").map((page) => checkedPage(page.path));
  return [...new Set(passed)].slice(0, MAX_PAGES);
}

const checks = (count: number) => count === 1 ? "a browser check" : `${count} browser checks`;

/** The words after `↻ finish: `, one phrase per group. */
export function finishLine(groups: FinishGroups): string {
  const phrases: string[] = [];
  if (groups.unfinished.length) phrases.push(`${checks(groups.unfinished.length)} the AI recorded never finished`);
  if (groups.fixable.length) {
    const one = groups.fixable.length === 1;
    const cancelledOnly = groups.fixable.every((check) => check.cancelled && !check.writtenWrong);
    const wrongOnly = groups.fixable.every((check) => check.writtenWrong);
    phrases.push(`${checks(groups.fixable.length)} the AI recorded ${cancelledOnly ? `${one ? "needs" : "need"} OK on a dialog`
      : wrongOnly ? `${one ? "is" : "are"} written wrong` : "are written wrong or need OK on a dialog"}`);
  }
  if (groups.pageLeft.length) phrases.push(`no browser check of ${groups.pageLeft.map((page) => page.path).join(", ")} is left`);
  if (groups.noCheck.length) phrases.push("no browser check shows the changed pages work");
  return phrases.join("; ");
}

const AFTER = "Don't change the app in this turn. Casper replays the checks after it; one that fails gets the repair turn, if one is left.";
const line = (check: BrowserCheck, why?: string) => `- ${check.name} (id ${check.id})${why ? `: ${why}` : ""}`;

/** The finish turn's prompt: a section for each group that has something in it. `origin` is where Casper's page check
 * opened the changed pages, when known. */
export function finishChecksPrompt(groups: FinishGroups, origin?: string): string {
  const sections: string[] = [];
  if (groups.unfinished.length) sections.push([
    "Casper: browser checks you recorded in this task never finished.",
    ...groups.unfinished.map((check) => line(check, check.reason)),
    "Replay each id with the browser tool now that the page is ready. If a check is wrong (it needs data or steps it doesn't set up), record a correct check of the same page with replaces: its id; once that passes, the old one is withdrawn. One that went to a sign-in page never saw its page: withdraw it, no replacedBy needed, and if its page isn't checked yet, record a check that signs in through its steps. Every id above must end replayed or withdrawn. Don't change the app in this turn. Casper replays the checks again after it.",
  ].join("\n"));
  if (groups.fixable.length) sections.push([
    "Casper: browser checks you recorded in this task are written wrong or answered Cancel, so they show nothing about the page.",
    ...groups.fixable.map((check) => line(check, check.reason)),
    `Don't replay them. Record a corrected check of the same page with replaces: its id (its reason says what to fix: one element per selector, or dialog: "accept"); once it passes, the old one is withdrawn. ${AFTER}`,
  ].join("\n"));
  for (const page of groups.pageLeft) sections.push([
    `Casper: you withdrew every browser check of ${page.path}, so none is left to show it works.`,
    ...page.checks.map((check) => line(check, check.withdrawn)),
    `Record a correct check of that page, without replaces (these are withdrawn), that signs in and sets up its data through its own steps (use {run} in fill values) and asserts the text that shows it worked. ${AFTER}`,
  ].join("\n"));
  if (groups.noCheck.length) sections.push([
    `Casper: this task changed pages (${groups.noCheck.join(", ")}) and no browser check of yours shows they work; Casper's page check only shows they load.`,
    `Record one browser check (action: check) of the main thing the request has a person do there, ${origin ? `at ${origin}` : "starting the app with serve if it isn't running"}: open the page, take its steps (sign in, fill, click) and assert the text that shows it worked. If no page here can be checked in a browser, say why in one line. ${AFTER}`,
  ].join("\n"));
  return sections.join("\n\n");
}
