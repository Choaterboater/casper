import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DetectedWebService } from "../src/services/detect";
import { ServiceManager } from "../src/services/manager";
import { formatPageLine, formatPageReport, HttpPageOpener, pageFailureSummary, PageChecks, serverTraceback, type PageLoad, type PageOpener } from "../src/services/page-checks";
import { removeTempDir } from "./support/temp-dir";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A dev server stand-in: answers every path, logs a Python traceback when /boom is requested. */
const SERVER = `
const server = Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/boom") console.error("Uncaught app exception\\nTraceback (most recent call last):\\n  File \\"app.py\\", line 9, in <module>\\n    site = row['site']\\nKeyError: 'site'");
  if (url.pathname === "/broken") return new Response("oops", { status: 500 });
  if (url.pathname === "/missing") return new Response("no", { status: 404 });
  return new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
} });
console.log("listening", server.port);
`;

async function fixture(options: { command?: string; frameworks?: string[]; timeoutMs?: number } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-pages-")));
  cleanups.push(() => removeTempDir(root));
  await writeFile(path.join(root, "server.ts"), SERVER);
  const manager = new ServiceManager({ projectRoot: root, services: {} });
  cleanups.push(() => manager.close().catch(() => {}));
  const service: DetectedWebService = { name: "web", source: "package.json", label: "bun run dev", frameworks: options.frameworks ?? ["vite", "react"], portFlags: true,
    spec: { command: options.command ?? `"${process.execPath}" server.ts`, port: "auto", ready: { http: "/" }, timeoutMs: options.timeoutMs ?? 10_000 } };
  return { root, manager, service };
}

/** A scripted browser: fetches the page for real (so the server sees it), then reports what the script says. */
function fakeOpener(script: (url: URL) => Partial<PageLoad> = () => ({}), settled?: (url: URL) => Promise<void>): PageOpener & { urls: string[] } {
  const urls: string[] = [];
  return { consoleChecked: true, urls, async close() {},
    async load(url, signal) {
      urls.push(url);
      const response = await fetch(url, { signal });
      await response.text();
      // A real browser settles a Streamlit page for a while; here, wait until the server's log line has arrived.
      await settled?.(new URL(url));
      return { status: response.status, consoleChecked: true, consoleErrors: [], pageErrors: [], failedRequests: [], ...script(new URL(url)) };
    } };
}
const signal = () => new AbortController().signal;

test("a clean page passes with exactly the loads line, and the dev server lines are printed once per session", async () => {
  const f = await fixture();
  const lines: string[] = [], notice = { shown: false };
  const opener = fakeOpener();
  const checks = new PageChecks(() => f.manager, f.service, opener, { open: ["/dashboard"], skipped: [] }, { announce: line => lines.push(line), notice });
  const report = await checks.run(signal());
  expect(report.status).toBe("pass");
  expect(formatPageReport(report)).toEqual(["✓ /dashboard loads · 0 console errors"]);
  expect(opener.urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dashboard$/);
  expect(lines[0]).toBe("• Starting dev server: bun run dev (it runs your project's code)");
  expect(lines[1]).toMatch(/^Dev server: bun run dev · http:\/\/127\.0\.0\.1:\d+ \(stops when you leave Casper\)$/);
  expect(lines[2]).toBe("• Casper opening changed pages: /dashboard");
  // The next task reuses the running server: no start lines again.
  lines.length = 0;
  const again = await new PageChecks(() => f.manager, f.service, opener, { open: ["/"], skipped: [] }, { announce: line => lines.push(line), notice }).run(signal());
  expect(again.status).toBe("pass");
  expect(again.server.origin).toBe(report.server.origin);
  expect(lines).toEqual(["• Casper opening changed pages: /"]);
  expect(f.manager.status().map(({ name, state }) => ({ name, state }))).toEqual([{ name: "web", state: "ready" }]);
}, 30_000);

test("console errors, a 500, an error overlay and a same-origin request failure each fail the page; third-party failures are ignored", async () => {
  const f = await fixture();
  const opener = fakeOpener(url => {
    const origin = url.origin;
    if (url.pathname === "/console") return { consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'map')"] };
    if (url.pathname === "/two") return { pageErrors: ["ReferenceError: x is not defined"], consoleErrors: ["Warning: bad"] };
    if (url.pathname === "/overlay") return { overlay: "[plugin:vite:react-babel] Unexpected token (3:4)" };
    if (url.pathname === "/api") return { failedRequests: [{ url: `${origin}/api/devices`, status: 503 }] };
    if (url.pathname === "/third") return { failedRequests: [{ url: "https://cdn.example.com/font.woff2", error: "net::ERR_NAME_NOT_RESOLVED" }, { url: `${origin}/favicon.ico`, status: 404 }] };
    return {};
  });
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/console", "/two", "/broken", "/overlay", "/api"], skipped: [] }).run(signal());
  expect(report.status).toBe("fail");
  expect(formatPageReport(report)).toEqual([
    "✗ /console · 1 console error: TypeError: Cannot read properties of undefined (reading 'map')",
    "✗ /two · 2 console errors: ReferenceError: x is not defined",
    "✗ /broken returned 500",
    "✗ /overlay shows an error: [plugin:vite:react-babel] Unexpected token (3:4)",
    "✗ /api · a request to /api/devices failed (503)",
  ]);
  expect(pageFailureSummary(report)).toBe("/console has 1 console error");
  const third = await new PageChecks(() => f.manager, f.service, opener, { open: ["/third"], skipped: [] }).run(signal());
  expect(third.status).toBe("pass");
  expect(formatPageLine(third.pages[0]!)).toBe("✓ /third loads · 0 console errors");
}, 30_000);

test("at phone width, a page wider than the screen or a squashed text field fails the page; a page that fits says so", async () => {
  const f = await fixture();
  const opener = fakeOpener(url => {
    if (url.pathname === "/wide") return { phone: { viewport: 390, pageWidth: 650, squashed: [] } };
    if (url.pathname === "/tight") return { phone: { viewport: 390, pageWidth: 390, squashed: ["input#address (20px tall; 49px on a wider screen)"] } };
    return { phone: { viewport: 390, pageWidth: 390, squashed: [] } };
  });
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/wide", "/tight", "/ok"], skipped: [] }).run(signal());
  expect(report.status).toBe("fail");
  expect(formatPageReport(report)).toEqual([
    "✗ /wide at phone width (390px): the page is 650px wide, so it scrolls sideways",
    "✗ /tight at phone width (390px): input#address is squashed (20px tall; 49px on a wider screen)",
    "✓ /ok loads · 0 console errors · fits a phone",
  ]);
  expect(pageFailureSummary(report)).toBe("/wide doesn't fit a phone screen");
}, 30_000);

test("accessibility findings are notes under the page line; they never fail the page", async () => {
  const f = await fixture();
  const opener = fakeOpener(url => url.pathname === "/signup"
    ? { a11y: { lang: false, images: 1, inputs: 2, buttons: 1, contrast: { count: 3, worst: 2.1, colors: "#999999 on #ffffff" } } }
    : { a11y: { lang: true, images: 0, inputs: 0, buttons: 0, contrast: { count: 0, worst: 0 } } });
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/signup", "/ok"], skipped: [] }).run(signal());
  expect(report.status).toBe("pass");
  expect(report.pages[0]!.a11y).toEqual(["2 inputs have no label", "1 button has no name", "1 image has no alt text", "3 text items are below AA contrast (worst 2.1:1, #999999 on #ffffff)", "the page has no lang"]);
  expect(formatPageReport(report)).toEqual([
    "✓ /signup loads · 0 console errors",
    "  – /signup: 2 inputs have no label · 1 button has no name · 1 image has no alt text · 3 text items are below AA contrast (worst 2.1:1, #999999 on #ffffff) · the page has no lang",
    "✓ /ok loads · 0 console errors",
  ]);
  expect(pageFailureSummary(report)).toBeUndefined();
}, 30_000);

test("exact facts about the look are a note under the page line, never a failure, and nothing when the page is clean", async () => {
  const f = await fixture();
  const art = { noViewBox: [], noName: [], fixedColors: [], fixedFiles: [] };
  const clean = { brokenImages: [], repeatedImages: [], overflow: [], smallTargets: { count: 0, names: [] }, art };
  const opener = fakeOpener(url => url.pathname === "/shop"
    ? { look: { brokenImages: ["/img/hero.jpg"], repeatedImages: [{ src: "/img/bag.jpg", items: 4 }], overflow: ["div.hero", "table"],
      smallTargets: { count: 6, names: ['a "Menu"', "button.close", "a#cart"] }, art } }
    : { look: clean });
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/shop", "/ok"], skipped: [] }).run(signal());
  expect(report.status).toBe("pass");
  expect(formatPageReport(report)).toEqual([
    "✓ /shop loads · 0 console errors",
    "  – /shop: 1 image didn't load: /img/hero.jpg · the same picture is on 4 items: /img/bag.jpg"
      + " · at phone width div.hero, table run past the screen's right edge · at phone width 6 tap targets are under 44×44 px: a \"Menu\", button.close, a#cart, …",
    "✓ /ok loads · 0 console errors",
  ]);
}, 30_000);

test("what feels wrong to use joins the look notes, secrets hidden, and never changes the page's status", async () => {
  const f = await fixture();
  const look = { brokenImages: ["/img/hero.jpg"], repeatedImages: [], overflow: [], smallTargets: { count: 0, names: [] }, art: { noViewBox: [], noName: [], fixedColors: [], fixedFiles: [] } };
  const quiet = { devText: [], shift: { score: 0.09, moved: ["div.list"], unsized: [] }, covered: [] };
  const opener = fakeOpener(url => url.pathname === "/book"
    ? { look, feel: { devText: ["[object Object]", "1 bags", "token=abc123secret"], shift: { score: 0.24, moved: ["div.slots", "p#total"], unsized: ["/img/room.jpg"] },
      focusRing: "main#content", footer: 610, covered: ['button "Pay" (under div.toast)'] } }
    : { feel: quiet });
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/book", "/ok"], skipped: [] }).run(signal());
  expect(report.status).toBe("pass");
  expect(report.pages.map(page => page.status)).toEqual(["pass", "pass"]);
  expect(report.pages[0]!.look).toEqual(["1 image didn't load: /img/hero.jpg",
    'people can see developer or broken text: "[object Object]", "1 bags", "token=<redacted>',
    "the layout jumps while loading (shift 0.24): div.slots, p#total moved; give these images width and height or an aspect-ratio: /img/room.jpg",
    "main#content has a focus ring as the page opens (move focus there only from a skip link, or give it outline: none; :focus-visible still matches a script's focus)",
    "at phone width the footer is 610px tall, over half the screen",
    'at phone width a fixed layer covers a control: button "Pay" (under div.toast)']);
  // A shift under 0.1 is no note, and a page with nothing to say has no look line.
  expect(report.pages[1]!.look).toBeUndefined();
  expect(formatPageReport(report)[2]).toBe("✓ /ok loads · 0 console errors");
}, 30_000);

test("drawn pictures get plain notes: no viewBox, no name, icons that keep light colors in dark mode", async () => {
  const f = await fixture();
  const art = { noViewBox: ["svg.hero", "/img/bean.svg"], noName: ["svg#map"], fixedColors: ["svg#cart"], fixedFiles: ["/img/cup.svg", "/img/bag.svg"] };
  const opener = fakeOpener(() => ({ look: { brokenImages: [], repeatedImages: [], overflow: [], smallTargets: { count: 0, names: [] }, art } }));
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/"], skipped: [] }).run(signal());
  expect(report.status).toBe("pass");
  expect(report.pages[0]!.look).toEqual(["2 pictures have no viewBox, so they don't scale: svg.hero, /img/bean.svg",
    '1 picture has no name (add role="img" and a <title>, or aria-hidden="true" for decoration): svg#map',
    "in dark mode 1 icon keeps its light colors (use currentColor or CSS variables): svg#cart",
    "in dark mode 2 icon files keep their light colors (the page's CSS can't reach an <img>: put the SVG inline, or give the file its own prefers-color-scheme rule): /img/cup.svg, /img/bag.svg"]);
}, 30_000);

test("pages the changed ones link to are opened lightly, at most 5 and never twice; what is wrong is a note on the linking page and never fails it", async () => {
  const f = await fixture();
  const light: string[] = [];
  const base = fakeOpener(url => url.pathname === "/book"
    ? { links: ["/logout", "/api/x", "/x?y=1", "/book", "/two", "/account", "/missing", "/broken", "/help", "/noisy", "/sixth"] }
    : url.pathname === "/two" ? { links: ["/missing", "/seventh"] }
    : url.pathname === "/account" ? { status: 401 }
    : url.pathname === "/help" ? { blank: true }
    : url.pathname === "/noisy" ? { consoleErrors: ["TypeError: rows is undefined token=abc123secret"] } : {});
  const opener: PageOpener = { ...base, load: (url, signal, options) => {
    if (options?.light) light.push(new URL(url).pathname);
    expect(options?.light ? options.screenshots : false).toBe(false);
    return base.load(url, signal, options);
  } };
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/book", "/two"], skipped: [] }).run(signal());
  expect(report.status).toBe("pass");
  expect(report.pages.map(page => page.status)).toEqual(["pass", "pass"]);
  // A page that asks to sign in (401) is working as built: no note.
  expect(light).toEqual(["/account", "/missing", "/broken", "/help", "/noisy"]);
  expect(base.urls.map(url => new URL(url).pathname).filter(path => path === "/two")).toHaveLength(1);
  expect(report.pages[0]!.look).toEqual(["link /missing returns 404", "link /broken returns 500", "link /help is blank",
    "link /noisy has 1 console error: TypeError: rows is undefined token=<redacted>"]);
  expect(report.pages[1]!.look).toBeUndefined();
  expect(formatPageReport(report)[0]).toBe("✓ /book loads · 0 console errors");
}, 30_000);

test("secrets in console text never reach the report", async () => {
  const f = await fixture();
  const opener = fakeOpener(() => ({ consoleErrors: ["auth failed for token ghp_abcdefghijklmnopqrstuvwxyz0123456789"] }));
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/"], skipped: [] }).run(signal());
  expect(JSON.stringify(report)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(report.pages[0]!.consoleErrors[0]).toContain("<redacted>");
}, 30_000);

test("a Streamlit exception in the server log fails the page, even with a clean console", async () => {
  const f = await fixture({ frameworks: ["streamlit"] });
  const logged = async () => { for (let tries = 0; tries < 500 && !f.manager.logs("web").text.includes("KeyError"); tries++) await Bun.sleep(10); };
  const report = await new PageChecks(() => f.manager, { ...f.service, label: "streamlit run app.py" }, fakeOpener(undefined, logged), { open: ["/boom"], skipped: [] }).run(signal());
  expect(report.status).toBe("fail");
  expect(formatPageLine(report.pages[0]!)).toBe("✗ /boom shows an error: KeyError: 'site'");
  expect(pageFailureSummary(report)).toBe("/boom shows an error");
  // An in-page Streamlit exception element is reported the same way.
  const element = await new PageChecks(() => f.manager, f.service, fakeOpener(() => ({ overlay: "KeyError: 'site'" })), { open: ["/"], skipped: [] }).run(signal());
  expect(formatPageLine(element.pages[0]!)).toBe("✗ / shows an error: KeyError: 'site'");
}, 30_000);

test("the traceback reader takes the exception line of the last traceback", () => {
  expect(serverTraceback("ok\nTraceback (most recent call last):\n  File \"a.py\", line 1\n    x()\nValueError: bad\n")).toBe("ValueError: bad");
  expect(serverTraceback("Traceback (most recent call last):\n  File \"a\"\nKeyError: 'a'\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\n  File \"b\"\nRuntimeError: second")).toBe("RuntimeError: second");
  expect(serverTraceback("all fine\n")).toBeUndefined();
});

test("a dev server that exits is an incomplete report with its last lines, never a pass", async () => {
  const f = await fixture({ command: `"${process.execPath}" -e "console.error('Error: Cannot find module vite'); process.exit(1)"` });
  const report = await new PageChecks(() => f.manager, f.service, fakeOpener(), { open: ["/dashboard"], skipped: [] }).run(signal());
  expect(report.status).toBe("incomplete");
  expect(report.pages).toEqual([]);
  expect(report.reason).toBe("the dev server stopped before it was ready (exit 1)");
  expect(report.logTail).toContain("Cannot find module vite");
  expect(formatPageReport(report)[0]).toStartWith("– Pages not checked: the dev server stopped before it was ready (exit 1). Last lines:\n    Error: Cannot find module vite");
}, 30_000);

test("a dev server that never answers on its port says how to tell Casper how to start it", async () => {
  const f = await fixture({ command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`, timeoutMs: 1500 });
  const report = await new PageChecks(() => f.manager, f.service, fakeOpener(), { open: ["/"], skipped: [] }).run(signal());
  expect(report.status).toBe("incomplete");
  expect(formatPageReport(report)).toEqual(["– Pages not checked: the dev server didn't answer on its port within 2 s. Tell Casper how to start it: services.web in .casper/project.yaml"]);
}, 30_000);

test("without Chrome the HTTP-only line says the console was not checked", async () => {
  const f = await fixture();
  const report = await new PageChecks(() => f.manager, f.service, new HttpPageOpener(), { open: ["/dashboard", "/broken"], skipped: [{ path: "/devices/[id]", why: "it needs a value for [id]" }] }).run(signal());
  expect(formatPageReport(report)).toEqual([
    "✓ /dashboard answers (HTTP 200) · console not checked: no Chrome found (install Chrome or set CASPER_BROWSER_EXECUTABLE)",
    "✗ /broken returned 500",
    "– /devices/[id] not opened: it needs a value for [id] (a fixed path can be set in .casper/project.yaml pages:)",
  ]);
  expect(report.pages[0]!.consoleChecked).toBe(false);
}, 30_000);

test("an edit marks the detected server stale and the next check restarts it", async () => {
  const f = await fixture();
  const opener = fakeOpener();
  const plan = { open: ["/"], skipped: [] };
  const first = await new PageChecks(() => f.manager, f.service, opener, plan).run(signal());
  const pid = f.manager.status()[0]!.pid;
  f.manager.markEdited("src/App.tsx");
  const second = await new PageChecks(() => f.manager, f.service, opener, plan).run(signal());
  expect(first.server.restarted).toBeUndefined();
  expect(second.server.restarted).toBe(true);
  expect(f.manager.status()[0]!.pid).not.toBe(pid);
}, 30_000);

test("no planned page is incomplete, and nothing is started", async () => {
  const f = await fixture();
  const report = await new PageChecks(() => f.manager, f.service, fakeOpener(), { open: [], skipped: [] }).run(signal());
  expect(report.status).toBe("incomplete");
  expect(f.manager.status()).toEqual([]);
});

test("each page's pictures are on its line and under it; the opener is asked for them unless they are off", async () => {
  const f = await fixture();
  const asked: Array<boolean | undefined> = [];
  const base = fakeOpener(() => ({ screenshots: { desktop: "/state/browser/run/page-1-desktop.png", phone: "/state/browser/run/page-1-phone.png" } }));
  const opener: PageOpener = { ...base, load: (url, signal, options) => { asked.push(options?.screenshots); return base.load(url, signal, options); } };
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/settings"], skipped: [] }).run(signal());
  expect(formatPageReport(report)).toEqual([
    "✓ /settings loads · 0 console errors · 2 screenshots",
    "  desktop /state/browser/run/page-1-desktop.png · phone /state/browser/run/page-1-phone.png",
  ]);
  await new PageChecks(() => f.manager, f.service, opener, { open: ["/settings"], skipped: [] }, { screenshots: false }).run(signal());
  expect(asked).toEqual([true, false]);
});
