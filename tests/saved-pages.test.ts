import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import { PageSession } from "../src/pages/session";
import { findSaved, pageDay, pagesDirectory, savedPages, writePage } from "../src/pages/store";
import { pageTool } from "../src/pages/tool";
import type { AgentRuntime, RuntimeConversation, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { FULL_HELP_TEXT } from "../src/tui/help";
import { richApp } from "./support/app";
import { withEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const PAGE = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
const HERE = "shop-0123456789abcdef";
const HA = "homeassist-0f0f0f0f0f0f0f0f";
const LAB = "lab-aaaaaaaaaaaaaaaa";
const NOW = new Date(2026, 9, 31, 15, 0);
const day = (offset: number) => new Date(NOW.getTime() - offset * 86_400_000);

/** A home with pages in three folders: this one (shop) and two others, each page with a known date. */
async function home() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-saved-pages-")));
  cleanups.push(() => removeTempDir(root));
  await mkdir(path.join(root, ".casper"), { recursive: true });
  const folder = (key: string) => pagesDirectory(root, path.join(root, ".casper", "projects", key));
  const put = async (key: string, name: string, when: Date) => {
    const { file } = await writePage(root, folder(key), name, PAGE(name));
    await utimes(file, when, when);
  };
  await put(HERE, "db-options", day(3));
  await put(HA, "planes-radar", day(1));
  await put(HA, "ha-dashboard-audit", day(11));
  await put(LAB, "office-network", day(0));
  await put(LAB, "db-options", day(0));
  return { root, here: folder(HERE), folder };
}

function session(homeDir: string, directory: string, options: Partial<ConstructorParameters<typeof PageSession>[0]> = {}) {
  const lines: string[] = [];
  const opened: string[] = [];
  const pages = new PageSession({ homeDir, directory, live: true, openSetting: () => true, desktop: () => true,
    open: (url) => { opened.push(url); return true; }, say: (line) => lines.push(line), ...options });
  cleanups.push(() => pages.close());
  return { pages, lines, opened };
}

test("saved pages come from every folder: this folder's first, then the newest; each with its folder's name and a ref", async () => {
  const { root, here } = await home();
  const pages = await savedPages(root, here);
  // The others newest first; the two lab pages have the same time, so by name.
  expect(pages.map((page) => page.ref)).toEqual(["db-options", `${LAB}/db-options`, `${LAB}/office-network`, `${HA}/planes-radar`, `${HA}/ha-dashboard-audit`]);
  expect(pages[0]).toMatchObject({ name: "db-options", here: true, folder: "shop" });
  expect(pages.find((page) => page.name === "planes-radar")).toMatchObject({ folder: "homeassist", here: false, ref: `${HA}/planes-radar` });
});

test.skipIf(process.platform === "win32")("only real page folders are read: a link, a loose file or a folder that isn't a project's is skipped", async () => {
  const { root, here } = await home();
  const base = path.join(root, ".casper", "pages");
  const elsewhere = path.join(root, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, "stolen.html"), PAGE("stolen"));
  await symlink(elsewhere, path.join(base, "linked-bbbbbbbbbbbbbbbb"));
  await writeFile(path.join(base, "loose.html"), PAGE("loose"));
  await mkdir(path.join(base, "not-a-project"));
  await writeFile(path.join(base, "not-a-project", "odd.html"), PAGE("odd"));
  const names = (await savedPages(root, here)).map((page) => page.name);
  expect(names).not.toContain("stolen");
  expect(names).not.toContain("loose");
  expect(names).not.toContain("odd");
  expect(names).toHaveLength(5);
});

test("finding a saved page: a ref or a name exactly, else the pages whose names have the most of the words", async () => {
  const { root, here } = await home();
  const pages = await savedPages(root, here);
  const refs = (words: string) => findSaved(pages, words).map((page) => page.ref);
  expect(refs("")).toEqual(pages.map((page) => page.ref));
  expect(refs("the radar page from yesterday")).toEqual([`${HA}/planes-radar`]);
  expect(refs("Planes Radar")).toEqual([`${HA}/planes-radar`]);
  // The same name in two folders: this folder's first.
  expect(refs("db-options")).toEqual(["db-options", `${LAB}/db-options`]);
  expect(refs(`${LAB}/db-options`)).toEqual([`${LAB}/db-options`]);
  expect(refs("dashboard")).toEqual([`${HA}/ha-dashboard-audit`]);
  expect(refs("network dashboard")).toEqual([`${LAB}/office-network`, `${HA}/ha-dashboard-audit`]);
  expect(refs("espresso")).toEqual([]);
  // A ref is never a path.
  expect(refs("../../etc/passwd")).toEqual([]);
});

test("a page's day reads plainly: today, yesterday, a date, and the year when it isn't this one", () => {
  expect(pageDay(new Date(2026, 9, 31, 9), NOW)).toBe("today");
  expect(pageDay(new Date(2026, 9, 30, 23), NOW)).toBe("yesterday");
  expect(pageDay(new Date(2026, 9, 20, 12), NOW)).toBe("Oct 20");
  expect(pageDay(new Date(2025, 11, 2, 12), NOW)).toBe("Dec 2, 2025");
});

test("a page from another folder opens on a server for that folder alone; a bad ref opens nothing", async () => {
  const { root, here } = await home();
  const { pages, opened } = session(root, here);
  const result = await pages.open(`${HA}/planes-radar`);
  if (typeof result === "string") throw new Error(result);
  expect(result.opened).toBe(true);
  expect(result.page).toMatchObject({ name: "planes-radar", folder: "homeassist" });
  expect(opened).toEqual([result.link]);
  const page = await fetch(result.link);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<h1>planes-radar</h1>");
  // That server serves the homeassist folder only: this folder's page isn't there.
  expect((await fetch(`${new URL(result.link).origin}/db-options.html`)).status).toBe(404);
  // A bare name not in this folder is found in another one.
  const bare = await pages.open("office-network");
  if (typeof bare === "string") throw new Error(bare);
  expect(bare.page.folder).toBe("lab");
  for (const bad of ["../x/planes-radar", `${HA}/../${LAB}/db-options`, "not-a-key/planes-radar", `${HA}/missing`, "espresso"]) {
    expect(typeof await pages.open(bad)).toBe("string");
  }
  expect(opened).toHaveLength(2);
  // A bare name removes this folder's page only; another folder's needs its ref.
  expect(await pages.remove("office-network")).toBe(false);
  expect(await pages.remove(`${LAB}/office-network`)).toBe(true);
  expect(await pages.remove("db-options")).toBe(true);
  expect((await pages.saved()).map((page) => page.ref)).toEqual([`${LAB}/db-options`, `${HA}/planes-radar`, `${HA}/ha-dashboard-audit`]);
});

test("casper_page open: one match opens it and says where and when it was made; several or none list them, opening nothing", async () => {
  const { root, here } = await home();
  const { pages, opened, lines } = session(root, here);
  const tool = pageTool(() => pages, () => NOW);
  // Still one short line in every request.
  expect(tool.description.length).toBeLessThan(200);
  expect(tool.description).toContain("open");
  expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(["name", "html", "open"]);

  const one = await tool.execute({ open: "radar" });
  expect(one.isError).toBeUndefined();
  expect(one.text).toMatch(/^Page planes-radar \(folder homeassist, made yesterday\) is open in the user's browser: http:\/\/127\.0\.0\.1:\d+\/planes-radar\.html\./);
  expect(opened).toHaveLength(1);
  expect(lines.at(-1)).toMatch(/^\[page\] planes-radar \(homeassist\) → http:\/\/127\.0\.0\.1:\d+\/planes-radar\.html$/);

  const several = await tool.execute({ open: "db options" });
  expect(several.text).toStartWith("2 saved pages match \"db options\"; send open again with one ref:");
  expect(several.text).toContain("\n- db-options · this folder · Oct 28");
  expect(several.text).toContain(`\n- ${LAB}/db-options · lab · today`);
  const none = await tool.execute({ open: "espresso" });
  expect(none.text).toStartWith("No saved page matches \"espresso\". Saved pages:");
  expect(none.text).toContain(`- ${HA}/planes-radar · homeassist · yesterday`);
  const all = await tool.execute({ open: "" });
  expect(all.text).toStartWith("Saved pages, this folder first, then newest:");
  expect(all.text.split("\n- ")).toHaveLength(6);
  expect(opened).toHaveLength(1);

  expect((await tool.execute({ open: "radar", html: PAGE("x") })).isError).toBe(true);
  expect((await tool.execute({ open: 7 })).isError).toBe(true);
});

test("casper_page open keeps to Open pages in the browser: off, it gives the link and opens nothing", async () => {
  const { root, here } = await home();
  const { pages, opened } = session(root, here, { openSetting: () => false });
  const reply = await pageTool(() => pages, () => NOW).execute({ open: "planes-radar" });
  expect(reply.text).toMatch(/^Page planes-radar \(folder homeassist, made yesterday\) not opened \(opening pages is off\); the user has the link: http:/);
  expect(opened).toEqual([]);
});

// The app: /pages and the start's row.

class CaptureRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.tools = options.tools ?? [];
    return { prompt: async () => {}, clearConversation: async () => {}, setTools: (tools) => { this.tools = tools; }, abort: async () => {}, subscribe: () => () => {},
      getState: () => ({ cwd: options.cwd, isStreaming: false }) };
  }
  async dispose() {}
}

test("/pages lists every folder's pages, numbered, with the day and the folder; the row's keys open them", async () => {
  const { root } = await home();
  const project = path.join(root, "shop");
  await mkdir(path.join(project, ".casper"), { recursive: true });
  let text = "";
  const opened: string[] = [];
  const casper = new CasperApp({
    runtimeFactory: () => new CaptureRuntime(), output: { write: (chunk) => { text += chunk; } }, sessionHomeDir: root, verificationMode: "off",
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: root }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    pageSeams: { desktop: () => true, open: (url) => { opened.push(url); return true; } },
  });
  cleanups.push(() => casper.close());
  await casper.runOnce("hello", project);
  casper.interactive = true;
  const offered: Array<Map<string, string> | undefined> = [];
  const offerNext = casper.terminal.offerNext.bind(casper.terminal);
  casper.terminal.offerNext = (row) => { offered.push(row?.keys); offerNext(row); };
  text = "";
  await casper.handleSlashCommand("/pages");
  const lines = text.split("\n");
  expect(lines[0]).toBe("Saved pages, this folder first, then newest:");
  // This project's folder holds no pages yet (its key differs from the fixture's shop key): all four others are listed.
  expect(lines.slice(1, 6).map((line) => line.replace(/\s+/g, " ").trim())).toEqual([
    `1 db-options ${pageDay(day(0))} lab`,
    `2 office-network ${pageDay(day(0))} lab`,
    `3 planes-radar ${pageDay(day(1))} homeassist`,
    `4 db-options ${pageDay(day(3))} shop`,
    `5 ha-dashboard-audit ${pageDay(day(11))} homeassist`,
  ]);
  expect(text).toContain("Next: 1 Open db-options · 2 Open office-network · 3 Open planes-radar · 4 Open db-options · 5 Open ha-dashboard-audit");
  expect(offered.at(-1)?.get("3")).toBe(`/pages open ${HA}/planes-radar`);
  text = "";
  await casper.handleSlashCommand(offered.at(-1)!.get("3")!);
  expect(text).toMatch(/^\[page\] planes-radar \(homeassist\) → http:\/\/127\.0\.0\.1:\d+\/planes-radar\.html\n$/);
  expect(opened).toHaveLength(1);
  expect(FULL_HELP_TEXT).toContain("/pages open <name>");
  expect(FULL_HELP_TEXT).toContain("every folder");
});

/** A runtime with saved conversations, for the start's row. */
function startRuntime(saved: RuntimeConversation[], project: string): AgentRuntime {
  const file = path.join(path.dirname(project), "session.jsonl");
  return {
    async start() {
      await writeFile(file, "");
      return {
        setTools: () => {}, getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
        getState: () => ({ cwd: "", isStreaming: false }),
        getSessionInfo: () => ({ cwd: project, sessionId: "current", sessionFile: file }),
        forkSession: async () => ({ cwd: project, sessionId: "fork", sessionFile: file }),
        switchSession: async () => ({ cwd: project, sessionId: "current", sessionFile: file }),
        subscribe: () => () => {}, abort: async () => {}, prompt: async () => {},
        listConversations: async () => saved, resumeConversation: async () => {},
      };
    },
    async dispose() {},
  };
}

const RADAR = { [`.casper/pages/${HA}/planes-radar.html`]: PAGE("planes-radar") };

test("the start's row offers your saved pages when there are any; its key lists them", async () => {
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => startRuntime([], project), { savedConversations: async () => [] }, { homeFiles: RADAR });
    try {
      await app.until(text => /Next:\s+1\s+Saved pages \(1\)/.test(text));
      // No conversation to continue: nothing says typing starts a new one.
      expect(app.screen()).not.toContain("Anything you type starts a new conversation.");
      app.input.write("1");
      await app.until(text => text.includes("Saved pages, this folder first, then newest:"));
      expect(app.screen()).toContain("planes-radar");
    } finally { await app.close(); }
  });
}, 30_000);

test("with an earlier conversation too, Continue stays 1 and Saved pages is 2; a folder-less home with no pages offers no pages row", async () => {
  const earlier: RuntimeConversation[] = [{ id: "a1", path: "/x", modified: new Date().toISOString(), messages: 4, title: "Fix the login bug" } as RuntimeConversation];
  await withEnv({ TERM: "xterm-256color" }, async () => {
    const app = await richApp(project => startRuntime(earlier, project), { savedConversations: async () => earlier }, { homeFiles: RADAR });
    try {
      await app.until(text => /Next:\s+1\s+Continue today's conversation \([^\n]*\)[ ·]+2\s+Saved pages \(1\)/.test(text));
      expect(app.screen()).toContain("Anything you type starts a new conversation.");
    } finally { await app.close(); }
    const bare = await richApp(project => startRuntime(earlier, project), { savedConversations: async () => earlier });
    try {
      await bare.until(text => /Next:\s+1\s+Continue today's conversation/.test(text));
      await Bun.sleep(200);
      expect(bare.screen()).not.toContain("Saved pages");
    } finally { await bare.close(); }
  });
}, 30_000);
