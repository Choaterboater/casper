import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopHere } from "../src/pages/open";
import { PageServer, withReload } from "../src/pages/server";
import { PageSession } from "../src/pages/session";
import { listPages, PAGE_POLICY, PAGE_SANDBOX, pageName, pageNameProblem, pagesDirectory, RTC_GUARD, withPolicy, writePage } from "../src/pages/store";
import { PAGE_GUIDE, pageTool } from "../src/pages/tool";
import { removeTempDir } from "./support/temp-dir";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function home() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-ai-pages-")));
  cleanups.push(() => removeTempDir(root));
  await mkdir(path.join(root, ".casper"), { recursive: true });
  return { root, directory: pagesDirectory(root, path.join(root, ".casper", "projects", "demo-0123456789abcdef")) };
}

function session(homeDir: string, directory: string, options: Partial<ConstructorParameters<typeof PageSession>[0]> = {}) {
  const lines: string[] = [];
  const opened: string[] = [];
  const pages = new PageSession({ homeDir, directory, live: true, openSetting: () => true, desktop: () => true,
    open: (url) => { opened.push(url); return true; }, say: (line) => lines.push(line), ...options });
  cleanups.push(() => pages.close());
  return { pages, lines, opened };
}

const PAGE = "<!doctype html><html><head><title>DB options</title></head><body><h1>Pick Postgres</h1></body></html>";

test("a page name is short, lower case, digits and dashes: never a path, a dot or a Windows device name", () => {
  for (const good of ["db-options", "a", "q3-report", "x".repeat(40)]) expect(pageNameProblem(good)).toBeUndefined();
  for (const bad of ["", "../secrets", "a/b", "a\\b", "Report", "db.options", "-db", "db-", "x".repeat(41), "my page", "con", "lpt1", "nul"]) {
    expect(pageNameProblem(bad)).toBeDefined();
  }
  expect(pageNameProblem(undefined)).toContain("name is required");
  // What the tool fixes before it checks: case, runs of other characters, dashes at the ends, length.
  expect(pageName("Ghost_Options")).toBe("ghost-options");
  expect(pageName("DB options (v2)")).toBe("db-options-v2");
  expect(pageName("../secrets")).toBe("secrets");
  expect(pageName(`${"a".repeat(39)}_b`)).toBe("a".repeat(39));
  expect(pageName("___")).toBe("");
});

test("a saved page starts with the policy and the WebRTC guard, once each, after any doctype", () => {
  const saved = withPolicy(PAGE);
  expect(saved.startsWith("<!doctype html>\n<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
  expect(saved.indexOf(RTC_GUARD)).toBeLessThan(saved.indexOf("<html>"));
  expect(withPolicy(saved)).toBe(saved);
  expect(RTC_GUARD).toContain("RTCPeerConnection");
  expect(withPolicy("<p>x</p>").startsWith("<meta")).toBe(true);
});

test("pages go to ~/.casper/pages/<project-key>/, the project's own state folder name", async () => {
  expect(pagesDirectory("/h", "/h/.casper/projects/shop-0011223344556677")).toBe(path.join("/h", ".casper", "pages", "shop-0011223344556677"));
});

test("writing a page saves it with the policy after the doctype; the same name again replaces it", async () => {
  const { root, directory } = await home();
  const first = await writePage(root, directory, "db-options", PAGE);
  expect(first.created).toBe(true);
  const saved = await readFile(first.file, "utf8");
  expect(saved.startsWith("<!doctype html>\n<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
  expect(saved).toContain("<h1>Pick Postgres</h1>");
  const second = await writePage(root, directory, "db-options", PAGE.replace("Postgres", "SQLite"));
  expect(second.created).toBe(false);
  expect(await readFile(second.file, "utf8")).toContain("Pick SQLite");
  // Sent back as it was saved (policy and all), it still has the policy once.
  await writePage(root, directory, "db-options", await readFile(second.file, "utf8"));
  expect((await readFile(second.file, "utf8")).split("Content-Security-Policy").length).toBe(2);
  expect(saved).not.toContain("frame-ancestors");
  expect((await listPages(directory)).map((page) => page.name)).toEqual(["db-options"]);
  await expect(writePage(root, directory, "../escape", PAGE)).rejects.toThrow("must be 1-40");
  await expect(writePage(root, directory, "big", "x".repeat(2 * 1024 * 1024 + 1))).rejects.toThrow("over 2 MB");
});

test.skipIf(process.platform === "win32")("a pages folder that is a link to somewhere else is refused", async () => {
  const { root } = await home();
  const elsewhere = path.join(root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await mkdir(path.join(root, ".casper", "pages"), { recursive: true });
  await symlink(elsewhere, path.join(root, ".casper", "pages", "linked"));
  await expect(writePage(root, path.join(root, ".casper", "pages", "linked"), "x", PAGE)).rejects.toThrow("not where Casper keeps pages");
});

test("the tool: without html it returns the guide; the first page brings the guide too, later ones don't", async () => {
  const { root, directory } = await home();
  const { pages, lines, opened } = session(root, directory);
  const tool = pageTool(() => pages);
  expect(tool.name).toBe("casper_page");
  // One short line in every request; the how-to stays out of it.
  expect(tool.description.length).toBeLessThan(200);
  expect(tool.description).not.toContain("prefers-color-scheme");
  // The AI makes a page on its own when one helps, never for a plain answer; diagrams in the terminal stay visualize's.
  expect(tool.description).toStartWith("Unasked, when seeing beats reading");
  expect(tool.description).toContain("not for plain answers");
  expect(tool.description).not.toContain("diagram");
  expect(PAGE_GUIDE).toContain("prefers-color-scheme");
  expect(PAGE_GUIDE).toContain("360 px");
  expect(PAGE_GUIDE).toContain("no file contents beyond what the user asked");
  const made = await tool.execute({ name: "db-options", html: PAGE });
  expect(made.isError).toBeUndefined();
  expect(made.text).toMatch(/^Page db-options made: http:\/\/127\.0\.0\.1:\d+\/db-options\.html\. It is open in the user's browser\./);
  expect(made.text).toContain("Guide for later pages");
  const updated = await tool.execute({ name: "db-options", html: PAGE });
  expect(updated.text).toContain("updated");
  expect(updated.text).toContain("The open tab reloads itself.");
  expect(updated.text).not.toContain("Guide for later pages");
  expect(opened).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[page\] db-options → http:\/\/127\.0\.0\.1:\d+\/db-options\.html$/);
  expect(lines[1]).toMatch(/^\[page\] db-options updated → http:\/\/127\.0\.0\.1:\d+\/db-options\.html$/);
  const guide = await pageTool(() => pages).execute({ name: "x" });
  expect(guide.text).toContain(PAGE_GUIDE);
  // A near-miss name is fixed rather than refused, so the page the AI wrote is never thrown away; a name with no
  // letters or digits, or a Windows device name, is still refused.
  expect((await tool.execute({ name: "Ghost_Options", html: PAGE })).text).toStartWith("Page ghost-options made:");
  expect((await tool.execute({ name: "../x", html: PAGE })).text).toStartWith("Page x made:");
  for (const bad of ["___", "", "CON", 7]) expect((await tool.execute({ name: bad, html: PAGE })).isError).toBe(true);
  expect((await tool.execute({ name: "y", html: "  " })).isError).toBe(true);
  expect((await tool.execute({ name: "x", html: PAGE, path: "/etc/passwd" })).text).toContain("Unknown field path");
});

test("each page opens the first time it is made in a session; with the setting off or no desktop only the link is printed", async () => {
  const { root, directory } = await home();
  const on = session(root, directory);
  await on.pages.make("one", PAGE);
  await on.pages.make("one", PAGE);
  await on.pages.make("two", PAGE);
  expect(on.opened.map((url) => url.replace(/:\d+/, ":PORT"))).toEqual(["http://127.0.0.1:PORT/one.html", "http://127.0.0.1:PORT/two.html"]);

  let setting = false;
  const off = session(root, directory, { openSetting: () => setting });
  expect((await off.pages.make("three", PAGE)).notOpened).toBe("opening pages is off");
  setting = true;
  // Once shown (here: its link printed), a page is not opened later by an update.
  await off.pages.make("three", PAGE);
  expect(off.opened).toEqual([]);
  expect(off.lines).toHaveLength(2);

  const remote = session(root, directory, { desktop: () => false });
  expect((await remote.pages.make("four", PAGE)).notOpened).toBe("no desktop here");
  expect(remote.opened).toEqual([]);

  // A one-shot run saves the file and gives its own address; no server, nothing opens.
  const once = session(root, directory, { live: false });
  const made = await once.pages.make("five", PAGE);
  expect(made.link.startsWith("file://")).toBe(true);
  expect(made.notOpened).toBe("a one-shot run");
  expect(once.opened).toEqual([]);
});

test("a desktop is a local session with a display: not over SSH, not in CI, and on Linux only with DISPLAY or Wayland", () => {
  expect(desktopHere({}, "darwin")).toBe(true);
  expect(desktopHere({}, "win32")).toBe(true);
  expect(desktopHere({ DISPLAY: ":0" }, "linux")).toBe(true);
  expect(desktopHere({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
  expect(desktopHere({}, "linux")).toBe(false);
  expect(desktopHere({ SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" }, "darwin")).toBe(false);
  expect(desktopHere({ SSH_TTY: "/dev/ttys001", DISPLAY: ":0" }, "linux")).toBe(false);
  expect(desktopHere({ CI: "true" }, "darwin")).toBe(false);
  expect(desktopHere({ CI: "false" }, "darwin")).toBe(true);
});

test("the server sends a page with the strict policy and the reload script, and nothing outside the folder", async () => {
  const { root, directory } = await home();
  await writePage(root, directory, "db-options", PAGE);
  await writeFile(path.join(root, ".casper", "pages", "outside.html"), "<p>outside</p>");
  await writeFile(path.join(directory, "notes.txt"), "secret");
  await writeFile(path.join(directory, ".hidden.html"), "hidden");
  if (process.platform !== "win32") await symlink(path.join(root, ".casper", "pages", "outside.html"), path.join(directory, "linked.html"));
  const server = new PageServer(directory);
  cleanups.push(() => server.stop());
  const origin = server.start();
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const page = await fetch(`${origin}/db-options.html`);
  expect(page.status).toBe(200);
  // Served sandboxed: an origin of its own, so no cookies or storage shared with other apps on 127.0.0.1.
  expect(page.headers.get("content-security-policy")).toBe(`${PAGE_POLICY}; ${PAGE_SANDBOX}`);
  expect(PAGE_SANDBOX).toStartWith("sandbox allow-scripts");
  expect(PAGE_SANDBOX).not.toContain("allow-same-origin");
  expect(PAGE_POLICY).toContain("connect-src 'self'");
  expect(PAGE_POLICY).toContain("default-src 'none'");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  const body = await page.text();
  expect(body).toContain("<h1>Pick Postgres</h1>");
  expect(body).toContain(`new EventSource("/_events?page=db-options")`);
  expect(body.indexOf("EventSource")).toBeLessThan(body.indexOf("</body>"));

  for (const attempt of ["/../outside.html", "/%2e%2e/outside.html", "/..%2foutside.html", "/%2e%2e%2foutside.html", "/sub/db-options.html", "/notes.txt",
    "/.hidden.html", "/linked.html", "/db-options.HTML", "/db-options"]) {
    const response = await fetch(`${origin}${attempt}`);
    expect({ attempt, status: response.status }).toEqual({ attempt, status: 404 });
    expect(await response.text()).not.toContain("outside");
  }
  expect((await fetch(`${origin}/db-options.html`, { method: "POST", body: "x" })).status).toBe(405);
  // A name of some other site pointed at 127.0.0.1 (DNS rebinding) gets nothing.
  expect((await fetch(`${origin}/db-options.html`, { headers: { host: "rebind.example" } })).status).toBe(403);
  const index = await (await fetch(`${origin}/`)).text();
  expect(index).toContain(`href="/db-options.html"`);
});

test("an open page reloads itself when Casper writes it again, and hears when it is removed", async () => {
  const { root, directory } = await home();
  const { pages } = session(root, directory);
  const made = await pages.make("live", PAGE);
  const origin = new URL(made.link).origin;
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const events = await fetch(`${origin}/_events?page=live`, { signal: controller.signal });
  expect(events.headers.get("content-type")).toContain("text/event-stream");
  // The sandboxed page's origin is "null"; the stream carries only reload and gone.
  expect(events.headers.get("access-control-allow-origin")).toBe("null");
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const until = async (text: string) => {
    while (!seen.includes(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${text}`);
      seen += decoder.decode(value);
    }
  };
  await until("2000"); // the stream opens with its reconnect delay
  await pages.make("live", PAGE.replace("Postgres", "SQLite"));
  await until("data: reload");
  expect(await pages.remove("live")).toBe(true);
  await until("data: gone");
  expect(await pages.remove("live")).toBe(false);
  controller.abort();
});

test("the reload script goes before the last </body>, or at the end of a page without one", () => {
  expect(withReload("<p>a</p></body></html>", "a")).toMatch(/<p>a<\/p><script>.*<\/script><\/body><\/html>$/);
  expect(withReload("<p>a</p>", "a")).toMatch(/^<p>a<\/p>\n<script>/);
});
