import { expect, test } from "bun:test";
import { checksToFinish, finishChecksPrompt, finishLine, finishNeeded, FINISH_TURNS, pagesToCheck, unfinishedCheck } from "../src/app/finish-checks";
import type { BrowserCheck } from "../src/browser/scenario";
import type { VerificationReport } from "../src/verify/evidence";
import { ROUND_MAX_TURNS } from "../src/task/review";

/** What the finish turn at the end of a task asks about, and how it asks. */

const check = (id: string, overrides: Partial<BrowserCheck> = {}): BrowserCheck => ({ id, name: `Check ${id}`, scenarioSha256: "0", url: "http://127.0.0.1:3000/",
  viewport: { width: 1280, height: 800 }, status: "incomplete", baseline: "incomplete", freshness: "unavailable", assertions: [], ...overrides });

/** Today's finish turn, before checks written wrong, withdrawn pages and page builds joined it: kept word for word. */
const UNFINISHED_TEXT = "Replay each id with the browser tool now that the page is ready. If a check is wrong (it needs data or steps it doesn't set up), record a correct check of the same page with replaces: its id; once that passes, the old one is withdrawn. One that went to a sign-in page never saw its page: withdraw it, no replacedBy needed, and if its page isn't checked yet, record a check that signs in through its steps. Every id above must end replayed or withdrawn. Don't change the app in this turn. Casper replays the checks again after it.";

test("unfinished takes a sign-in page too; written wrong and Cancel are fixable; a gone server or one not replayed is in no group", () => {
  const groups = checksToFinish({ checks: [
    check("u", { reason: "Browser reproduction did not finish; no passing evidence." }),
    check("s", { signedOut: true, reason: "It went to a sign-in page" }),
    check("w", { writtenWrong: "assertion 1's selector matches 2 elements", reason: "Written wrong: assertion 1's selector matches 2 elements (matches: li \"A\" = li:nth-of-type(1); li \"B\" = li:nth-of-type(2)). Name one element and record the check again with replaces: \"w\"." }),
    check("c", { cancelled: "confirm", reason: "Not checked: … and replaces: \"c\"." }),
    check("g", { gone: "http://127.0.0.1:3000", freshness: "stale" }),
    check("n", { notReplayed: "a step would need a yes" }),
    check("g2", { writtenWrong: "x", gone: "http://127.0.0.1:3000" }),
    check("p", { status: "pass", freshness: "fresh" }),
    check("f", { status: "fail", freshness: "fresh" }),
  ] }, ["/"]);
  expect(groups.unfinished.map(c => c.id)).toEqual(["u", "s"]);
  expect(groups.fixable.map(c => c.id)).toEqual(["w", "c"]);
  expect(groups.pageLeft).toEqual([]);
  expect(groups.noCheck).toEqual([]);
  expect(unfinishedCheck(check("s", { signedOut: true }))).toBe(true);
  expect(FINISH_TURNS).toBe(ROUND_MAX_TURNS);
});

test("a page whose every check was withdrawn is left; one with another check of it, its query aside, is not", () => {
  const groups = checksToFinish({ checks: [
    check("a", { status: "withdrawn", withdrawn: "typo", url: "http://127.0.0.1:3000/" }),
    check("b", { status: "pass", url: "http://127.0.0.1:3000/" }),
    check("c", { status: "withdrawn", withdrawn: "needs data", url: "http://127.0.0.1:3000/signup?step=1" }),
    check("d", { status: "withdrawn", withdrawn: "wrong text", url: "http://localhost:4000/signup" }),
    check("e", { status: "withdrawn", withdrawn: "x", url: "http://127.0.0.1:3000/list" }),
    check("f", { status: "fail", url: "http://127.0.0.1:3000/list?all=1" }),
  ] });
  expect(groups.pageLeft.map(page => [page.path, page.checks.map(c => c.id)])).toEqual([["/signup", ["c", "d"]]]);
  expect(finishNeeded(groups)).toBe(true);
});

test("no check is asked for only when the report is empty and changed pages are given", () => {
  expect(checksToFinish({ checks: [] }, ["/", "/about"]).noCheck).toEqual(["/", "/about"]);
  expect(checksToFinish({ checks: [] }).noCheck).toEqual([]);
  expect(finishNeeded(checksToFinish({ checks: [] }))).toBe(false);
  expect(checksToFinish({ checks: [check("a", { status: "withdrawn" })] }, ["/"]).noCheck).toEqual([]);
  expect(checksToFinish({ checks: [check("p", { status: "pass" })] }, ["/"]).noCheck).toEqual([]);
});

const pages = (status: VerificationReport["status"], paths: Array<[string, "pass" | "fail" | "incomplete"]>): VerificationReport => ({ status, repairAttempts: 0, rounds: [], results: [],
  pages: { status: "pass", skipped: [], server: { name: "web", label: "web", command: "bun server.ts", origin: "http://127.0.0.1:3000" },
    pages: paths.map(([path, page]) => ({ path, status: page, httpStatus: 200, consoleChecked: true, consoleErrors: [], failedRequests: [] })) } });

test("a page build is asked for a browser check only when auto-checked, a build or fix, passing, with the browser on and Chrome here", () => {
  const ready = { mode: "auto", intent: "implement", readOnly: false, verification: pages("pass", [["/", "pass"], ["/", "pass"], ["/about", "incomplete"], ["/a", "pass"], ["/b", "pass"], ["/c", "pass"], ["/d", "pass"], ["/e", "pass"]]), browserOff: false, installed: true };
  expect(pagesToCheck(ready)).toEqual(["/", "/a", "/b", "/c", "/d"]);
  expect(pagesToCheck({ ...ready, intent: "fix" })).toEqual(["/", "/a", "/b", "/c", "/d"]);
  for (const off of [{ mode: "offer" }, { intent: "explain" }, { intent: "document" }, { readOnly: true }, { browserOff: true }, { installed: false },
    { verification: pages("fail", [["/", "pass"]]) }, { verification: { status: "pass", repairAttempts: 0, rounds: [], results: [] } as VerificationReport }, { verification: undefined }])
    expect({ off, paths: pagesToCheck({ ...ready, ...off }) }).toEqual({ off, paths: [] });
});

test("the unfinished section is today's text exactly; the others print the check's reason and end the same way", () => {
  const wrong = check("w", { writtenWrong: "assertion 1's selector matches 2 elements", reason: "Written wrong: assertion 1's selector matches 2 elements (matches: li \"A\" = li:nth-of-type(1); li \"B\" = li:nth-of-type(2)). Name one element and record the check again with replaces: \"w\"." });
  const unfinished = check("u", { name: "Save", reason: "Browser reproduction did not finish; no passing evidence." });
  expect(finishChecksPrompt({ unfinished: [unfinished], fixable: [], pageLeft: [], noCheck: [] })).toBe([
    "Casper: browser checks you recorded in this task never finished.",
    "- Save (id u): Browser reproduction did not finish; no passing evidence.",
    UNFINISHED_TEXT].join("\n"));
  const both = finishChecksPrompt({ unfinished: [unfinished], fixable: [wrong], pageLeft: [], noCheck: [] });
  expect(both.split("\n\n")).toHaveLength(2);
  expect(both).toContain(`${UNFINISHED_TEXT}\n\nCasper: browser checks you recorded in this task are written wrong or answered Cancel, so they show nothing about the page.\n- Check w (id w): Written wrong: assertion 1's selector matches 2 elements (matches: li "A"`);
  expect(both).toContain("Don't replay them. Record a corrected check of the same page with replaces: its id");
  expect(both).toEndWith("Don't change the app in this turn. Casper replays the checks after it; one that fails gets the repair turn, if one is left.");
  const left = finishChecksPrompt({ unfinished: [], fixable: [], pageLeft: [{ path: "/signup", checks: [check("a", { name: "Sign up", status: "withdrawn", withdrawn: "needs an account" })] }], noCheck: [] });
  expect(left).toStartWith("Casper: you withdrew every browser check of /signup, so none is left to show it works.\n- Sign up (id a): needs an account\nRecord a correct check of that page, without replaces (these are withdrawn), that signs in and sets up its data through its own steps (use {run} in fill values)");
  const none = finishChecksPrompt({ unfinished: [], fixable: [], pageLeft: [], noCheck: ["/", "/about"] }, "http://127.0.0.1:3000");
  expect(none).toStartWith("Casper: this task changed pages (/, /about) and no browser check of yours shows they work; Casper's page check only shows they load.\nRecord one browser check (action: check) of the main thing the request has a person do there, at http://127.0.0.1:3000: open the page");
  expect(finishChecksPrompt({ unfinished: [], fixable: [], pageLeft: [], noCheck: ["/"] })).toContain("do there, starting the app with serve if it isn't running: open the page");
});

test("the screen line names each group in a phrase, joined by semicolons", () => {
  const wrong = check("w", { writtenWrong: "x" }), cancelled = check("c", { cancelled: "confirm" });
  expect(finishLine({ unfinished: [check("u")], fixable: [], pageLeft: [], noCheck: [] })).toBe("a browser check the AI recorded never finished");
  expect(finishLine({ unfinished: [check("u"), check("v")], fixable: [wrong], pageLeft: [], noCheck: [] })).toBe("2 browser checks the AI recorded never finished; a browser check the AI recorded is written wrong");
  expect(finishLine({ unfinished: [], fixable: [wrong, check("x", { writtenWrong: "y" })], pageLeft: [], noCheck: [] })).toBe("2 browser checks the AI recorded are written wrong");
  expect(finishLine({ unfinished: [], fixable: [cancelled], pageLeft: [], noCheck: [] })).toBe("a browser check the AI recorded needs OK on a dialog");
  expect(finishLine({ unfinished: [], fixable: [wrong, cancelled], pageLeft: [], noCheck: [] })).toBe("2 browser checks the AI recorded are written wrong or need OK on a dialog");
  expect(finishLine({ unfinished: [], fixable: [], pageLeft: [{ path: "/", checks: [] }, { path: "/a", checks: [] }], noCheck: [] })).toBe("no browser check of /, /a is left");
  expect(finishLine({ unfinished: [], fixable: [], pageLeft: [], noCheck: ["/"] })).toBe("no browser check shows the changed pages work");
});

test("a check of a page on another site is in no fixable or page-left group: Casper doesn't replay it, and dialog: accept works only here", () => {
  const away = "https://example.com/signup";
  const groups = checksToFinish({ checks: [
    check("w", { url: away, writtenWrong: "assertion 1's selector matches 2 elements" }),
    check("c", { url: away, cancelled: "confirm" }),
    check("x", { url: away, status: "withdrawn", withdrawn: "typo" }),
    // A local page of the same path is its own page: the outside check doesn't keep it.
    check("y", { status: "withdrawn", withdrawn: "typo", url: "http://127.0.0.1:3000/signup" }),
    check("z", { url: "https://example.com/signup?plan=1", status: "fail" }),
  ] });
  expect(groups.fixable).toEqual([]);
  expect(groups.pageLeft.map(page => [page.path, page.checks.map(c => c.id)])).toEqual([["/signup", ["y"]]]);
});
