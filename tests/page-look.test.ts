import { afterAll, afterEach, expect, test } from "bun:test";
import { lookPrompt } from "../src/services/page-look";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { stringify } from "yaml";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeImage, RuntimeSession, RuntimeStartOptions } from "../src/runtime/types";
import type { PageLoad, PageOpener } from "../src/services/page-checks";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SERVER = `Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response("<html>ok</html>", { headers: { "content-type": "text/html" } }) });\n`;

type Turn = (options: RuntimeStartOptions) => Promise<void>;

/** A Next.js project whose dev server answers every page; the browser stand-in hands back two real PNG files. */
async function fixture(input: { vision: boolean; showPages?: "ask" | "on" | "off"; tty?: boolean }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-page-look-")));
  cleanups.push(() => removeTempDir(root));
  const home = path.join(root, "home"), project = path.join(root, "project"), shots = path.join(root, "shots");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(shots);
  if (input.showPages) await writeFile(path.join(home, ".casper", "config.yaml"), `showPages: ${input.showPages}\n`);
  await writeFile(path.join(project, "server.ts"), SERVER);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "web", dependencies: { next: "15.0.0", react: "19.0.0" } }));
  await writeFile(path.join(project, ".casper", "project.yaml"), stringify({ verification: { mode: "auto", checklist: false }, repair: { maxAttempts: 1 },
    services: { web: { command: `"${process.execPath}" server.ts`, port: "auto", ready: { http: "/" }, timeoutMs: 10_000 } } }));
  const desktop = path.join(shots, "page-1-desktop.png"), phone = path.join(shots, "page-1-phone.png");
  await writeFile(desktop, PNG); await writeFile(phone, PNG);
  const loads: Array<boolean | undefined> = [];
  const opener: PageOpener = { consoleChecked: true, async close() {},
    async load(url: string, signal: AbortSignal, options): Promise<PageLoad> {
      loads.push(options?.screenshots);
      const response = await fetch(url, { signal }); await response.text();
      return { status: response.status, consoleChecked: true, pageErrors: [], failedRequests: [], consoleErrors: [], screenshots: { desktop, phone } };
    } };
  const prompts: Array<{ text: string; images?: readonly RuntimeImage[] }> = [];
  const turns: Turn[] = [];
  const listeners = new Set<RuntimeEventListener>();
  let started: RuntimeStartOptions | undefined;
  const runtime: AgentRuntime = {
    async start(options) {
      started = options;
      const session: RuntimeSession = {
        getStatus: () => ({ provider: "fixture", model: input.vision ? "eyes" : "text", auth: "configured", images: input.vision }),
        prompt: async (text, _signal, promptOptions) => {
          prompts.push({ text, ...(promptOptions?.images ? { images: promptOptions.images } : {}) });
          for (const listener of listeners) listener({ type: "assistant_response_start", provider: "fixture", model: "m" });
          await turns.shift()?.(options);
          for (const listener of listeners) listener({ type: "assistant_text_delta", delta: "Done.\n" });
          for (const listener of listeners) listener({ type: "assistant_response_end", stopReason: "stop" });
        },
        setTools: () => {}, abort: async () => {}, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        getState: () => ({ cwd: options.cwd, isStreaming: false }),
      };
      return session;
    },
    async dispose() {},
  };
  const page = path.join(project, "app/dashboard/page.tsx");
  const edit = (content: string): Turn => async (options) => {
    await mkdir(path.dirname(page), { recursive: true }); await writeFile(page, content); await options.afterFileEdit?.(page);
  };
  const output: string[] = [];
  const terminalInput = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let screen = "";
  const waiters: Array<{ test: (text: string) => boolean; resolve: () => void }> = [];
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 140, rows: 40, write(text: string) {
    screen += Bun.stripANSI(text);
    for (const waiter of [...waiters]) if (waiter.test(screen)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  const until = (test: (text: string) => boolean) => {
    if (test(screen)) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error(`screen did not match; it ends with:\n${screen.slice(-2500)}`)), 20_000);
    waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
    return promise;
  };
  const app = new CasperApp({ runtimeFactory: () => runtime, sessionHomeDir: home, pageOpener: async () => opener,
    ...(input.tty ? { input: terminalInput, output: writer } : { output: { write: (text: string) => { output.push(text); } } }),
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ homeDir: home, projectRoot: context.info.root }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  cleanups.push(() => app.close().catch(() => {}));
  cleanups.push(() => terminalInput.destroy());
  return { app, project, prompts, turns, loads, edit, desktop, phone, input: terminalInput, until, screen: () => screen,
    text: () => output.join(""), started: () => started };
}

test("showPages: on and a model that sees pictures: it looks once at the desktop and phone pictures; the receipt says so", async () => {
  const f = await fixture({ vision: true, showPages: "on" });
  f.turns.push(f.edit("export default function Page() { return <main>Dashboard</main>; }\n"));
  await f.app.start(f.project);
  await f.app.runOnce("Add a dark mode toggle to the dashboard");
  expect(f.loads).toEqual([true]);
  expect(f.prompts).toHaveLength(2);
  const look = f.prompts[1]!;
  expect(look.text).toStartWith("Casper page look.");
  expect(look.text).toContain("[screenshot 1] /dashboard at desktop width (1280 px)\n[screenshot 2] /dashboard at phone width (390 px)");
  expect(look.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }, { data: PNG.toString("base64"), mimeType: "image/png" }]);
  const receipt = f.text();
  expect(receipt).toContain("↻ look: the AI looks at 2 screenshots of /dashboard");
  expect(receipt).toContain("✓ /dashboard loads · 0 console errors · 2 screenshots");
  expect(receipt).toContain(`  desktop ${f.desktop} · phone ${f.phone}`);
  expect(receipt).toContain("• The AI looked at 2 screenshots of the pages (advice, not a check)");
  expect(f.app.getLastTaskResult()?.pagesShown).toBe(2);
}, 30_000);

test("a fix made while looking is checked again: the pages are opened once more", async () => {
  const f = await fixture({ vision: true, showPages: "on" });
  f.turns.push(f.edit("export default function Page() { return <main>Dashboard</main>; }\n"));
  f.turns.push(f.edit("export default function Page() { return <main className=\"p-4\">Dashboard</main>; }\n"));
  await f.app.start(f.project);
  await f.app.runOnce("Add a dark mode toggle to the dashboard");
  expect(f.prompts).toHaveLength(2);
  expect(f.loads).toHaveLength(2);
  expect(f.app.getLastTaskResult()?.verification?.status).toBe("pass");
}, 30_000);

test("no look for a text-only model, with showPages: off, or by default in a one-shot run (it can't ask); the pictures are still saved", async () => {
  for (const input of [{ vision: false, showPages: "on" as const }, { vision: true, showPages: "off" as const }, { vision: true }]) {
    const f = await fixture(input);
    f.turns.push(f.edit("export default function Page() { return <main>Dashboard</main>; }\n"));
    await f.app.start(f.project);
    await f.app.runOnce("Add a dark mode toggle to the dashboard");
    expect(f.prompts).toHaveLength(1);
    expect(f.text()).toContain("· 2 screenshots");
    expect(f.text()).not.toContain("↻ look");
    expect(f.text()).not.toContain("The AI looked");
    expect(f.app.getLastTaskResult()?.pagesShown).toBeUndefined();
    await f.app.close();
  }
}, 60_000);

test("by default Casper asks once a session: 1 No · 2 Yes, show the AI the pages", async () => {
  const f = await fixture({ vision: true, tty: true });
  f.turns.push(f.edit("export default function Page() { return <main>Dashboard</main>; }\n"));
  f.turns.push(async () => {});
  f.turns.push(f.edit("export default function Page() { return <main>Dashboard 2</main>; }\n"));
  f.turns.push(async () => {});
  const interactive = f.app.runInteractive(f.project);
  const idleAfter = (marker: string) => (text: string) => text.includes(marker) && text.slice(text.lastIndexOf(marker)).includes("idle");
  try {
    await f.until((text) => text.includes("idle"));
    f.input.write("Add a dark mode toggle to the dashboard\r");
    await f.until((text) => text.includes("Show them to the AI") && text.slice(text.lastIndexOf("Show them to the AI")).includes("? waiting for you"));
    expect(f.screen()).toContain("1 No");
    expect(f.screen()).toContain("2 Yes, show the AI the pages");
    f.input.write("2");
    await f.until(idleAfter("The AI looked at 2 screenshots"));
    expect(f.prompts[1]!.images).toHaveLength(2);
    const asked = f.screen().split("Show them to the AI").length - 1;
    f.input.write("Make the dashboard title bigger\r");
    await f.until((text) => text.split("The AI looked at 2 screenshots").length === 3 && idleAfter("The AI looked at 2 screenshots")(text));
    // Asked once: the second request looked without a question.
    expect(f.screen().split("Show them to the AI").length - 1).toBe(asked);
    expect(f.prompts).toHaveLength(4);
  } finally {
    f.input.write("/exit\r"); await interactive;
  }
}, 60_000);

test("code the AI changes while looking at the pages counts for the proof: a CSS-only build turn is still compared", async () => {
  const f = await fixture({ vision: true, showPages: "on" });
  const yaml = path.join(f.project, ".casper", "project.yaml");
  await writeFile(yaml, `${await Bun.file(yaml).text()}verify:\n  test: ${JSON.stringify(`"${process.execPath}" -e "process.exit(0)"`)}\n`);
  const css = path.join(f.project, "app/globals.css");
  f.turns.push(async (options) => { await mkdir(path.dirname(css), { recursive: true }); await writeFile(css, "main { color: blue; }\n"); await options.afterFileEdit?.(css); });
  f.turns.push(f.edit("export default function Page() { return <main>Dashboard</main>; }\n"));
  await f.app.start(f.project);
  await f.app.runOnce("Make the dashboard header blue");
  const task = f.app.getLastTaskResult();
  expect(task?.pagesShown).toBe(2);
  expect(task?.proofSkipped).not.toBe("only non-code files changed");
  expect(task?.proof).toBeDefined();
}, 60_000);

test("the look round names its screenshots apart from the pictures sent with the request", () => {
  const text = lookPrompt("make [image 1] match the dashboard", { images: [], shown: [{ path: "/dashboard", views: ["desktop"] }] });
  expect(text).toContain("[screenshot 1] /dashboard at desktop width (1280 px)");
  expect(text).not.toContain("[image 1] /dashboard");
  expect(text).toContain("An [image N] in the request below is a picture sent with it earlier, not one of these screenshots.");
});
