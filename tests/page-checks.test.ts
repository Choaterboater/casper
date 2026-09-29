import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DetectedWebService } from "../src/services/detect";
import { ServiceManager } from "../src/services/manager";
import { formatPageLine, formatPageReport, HttpPageOpener, pageFailureSummary, PageChecks, serverTraceback, type PageLoad, type PageOpener } from "../src/services/page-checks";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A dev server stand-in: answers every path, logs a Python traceback when /boom is requested. */
const SERVER = `
const server = Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/boom") console.error("Uncaught app exception\\nTraceback (most recent call last):\\n  File \\"app.py\\", line 9, in <module>\\n    site = row['site']\\nKeyError: 'site'");
  if (url.pathname === "/broken") return new Response("oops", { status: 500 });
  return new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
} });
console.log("listening", server.port);
`;

async function fixture(options: { command?: string; frameworks?: string[]; timeoutMs?: number } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-pages-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "server.ts"), SERVER);
  const manager = new ServiceManager({ projectRoot: root, services: {} });
  cleanups.push(() => manager.close().catch(() => {}));
  const service: DetectedWebService = { name: "web", source: "package.json", label: "bun run dev", frameworks: options.frameworks ?? ["vite", "react"], portFlags: true,
    spec: { command: options.command ?? `"${process.execPath}" server.ts`, port: "auto", ready: { http: "/" }, timeoutMs: options.timeoutMs ?? 10_000 } };
  return { root, manager, service };
}

/** A scripted browser: fetches the page for real (so the server sees it), then reports what the script says. */
function fakeOpener(script: (url: URL) => Partial<PageLoad> = () => ({})): PageOpener & { urls: string[] } {
  const urls: string[] = [];
  return { consoleChecked: true, urls, async close() {},
    async load(url, signal) {
      urls.push(url);
      const response = await fetch(url, { signal });
      await response.text();
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
  expect(lines[0]).toBe("… Starting dev server: bun run dev (it runs your project's code)");
  expect(lines[1]).toMatch(/^Dev server: bun run dev · http:\/\/127\.0\.0\.1:\d+ \(stops when you leave Casper\)$/);
  expect(lines[2]).toBe("… Casper opening changed pages: /dashboard");
  // The next task reuses the running server: no start lines again.
  lines.length = 0;
  const again = await new PageChecks(() => f.manager, f.service, opener, { open: ["/"], skipped: [] }, { announce: line => lines.push(line), notice }).run(signal());
  expect(again.status).toBe("pass");
  expect(again.server.origin).toBe(report.server.origin);
  expect(lines).toEqual(["… Casper opening changed pages: /"]);
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

test("secrets in console text never reach the report", async () => {
  const f = await fixture();
  const opener = fakeOpener(() => ({ consoleErrors: ["auth failed for token ghp_abcdefghijklmnopqrstuvwxyz0123456789"] }));
  const report = await new PageChecks(() => f.manager, f.service, opener, { open: ["/"], skipped: [] }).run(signal());
  expect(JSON.stringify(report)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(report.pages[0]!.consoleErrors[0]).toContain("<redacted>");
}, 30_000);

test("a Streamlit exception in the server log fails the page, even with a clean console", async () => {
  const f = await fixture({ frameworks: ["streamlit"] });
  const report = await new PageChecks(() => f.manager, { ...f.service, label: "streamlit run app.py" }, fakeOpener(), { open: ["/boom"], skipped: [] }).run(signal());
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
  expect(formatPageReport(report)[0]).toStartWith("• Pages not checked: the dev server stopped before it was ready (exit 1). Last lines:\n    Error: Cannot find module vite");
}, 30_000);

test("a dev server that never answers on its port says how to tell Casper how to start it", async () => {
  const f = await fixture({ command: `"${process.execPath}" -e "setInterval(() => {}, 1000)"`, timeoutMs: 1500 });
  const report = await new PageChecks(() => f.manager, f.service, fakeOpener(), { open: ["/"], skipped: [] }).run(signal());
  expect(report.status).toBe("incomplete");
  expect(formatPageReport(report)).toEqual(["• Pages not checked: the dev server didn't answer on its port within 2 s. Tell Casper how to start it: services.web in .casper/project.yaml"]);
}, 30_000);

test("without Chrome the HTTP-only line says the console was not checked", async () => {
  const f = await fixture();
  const report = await new PageChecks(() => f.manager, f.service, new HttpPageOpener(), { open: ["/dashboard", "/broken"], skipped: [{ path: "/devices/[id]", why: "it needs a value for [id]" }] }).run(signal());
  expect(formatPageReport(report)).toEqual([
    "✓ /dashboard answers (HTTP 200) · console not checked: no Chrome found (install Chrome or set CASPER_BROWSER_EXECUTABLE)",
    "✗ /broken returned 500",
    "• /devices/[id] not opened: it needs a value for [id] (a fixed path can be set in .casper/project.yaml pages:)",
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
