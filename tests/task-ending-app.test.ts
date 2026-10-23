import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeStartOptions } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { richApp } from "./support/app";
import { removeTempDir } from "./support/temp-dir";

/**
 * A receipt card came right after replies that asked the person something or said what the AI does next, so a task
 * waiting for them looked finished, and the card's numbered keys looked like the options the AI had just offered. Now
 * such a task ends with one plain line, its receipt is saved, and the card that ends the work names what it changed.
 */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function eventually(check: () => void, ms = 25_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try { check(); return; } catch (error) { if (Date.now() >= deadline) throw error; }
    await Bun.sleep(10);
  }
}

/** One model reply: files it writes (with the edit tool when `seen`), its words, and an error after them. */
interface Reply { files?: Record<string, string>; seen?: string; text: string; fail?: string }

function fakeRuntime(project: () => string, replies: Reply[]): AgentRuntime {
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  return {
    async start(options: RuntimeStartOptions) {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project(), isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => {
          const reply = replies.shift()!;
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          for (const [file, text] of Object.entries(reply.files ?? {})) {
            await mkdir(path.dirname(path.join(project(), file)), { recursive: true });
            await writeFile(path.join(project(), file), text);
          }
          if (reply.seen) { await writeFile(reply.seen, "edited\n"); await options.afterFileEdit?.(reply.seen, new AbortController().signal); }
          emit({ type: "assistant_text_delta", delta: reply.text });
          emit({ type: "assistant_response_end", stopReason: "stop" });
          if (reply.fail) throw new Error(reply.fail);
        },
      };
    },
    async dispose() {},
  };
}

/** A session on the plain terminal: `send` types a line and returns what Casper printed until it is back at the prompt. */
async function session(replies: Reply[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-ending-")); roots.push(root);
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "notes.py"), "print('one')\n");
  const input = new PassThrough();
  let output = "";
  const app = new CasperApp({
    input, output: { write: (text: string) => { output += text; } }, runtimeFactory: () => fakeRuntime(() => project, replies), sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const running = app.runInteractive(project);
  const send = async (line: string) => {
    const from = output.length;
    input.write(`${line}\n`);
    await eventually(() => expect(/\n> $/.test(output.slice(from))).toBe(true));
    return output.slice(from);
  };
  return { root, project, send, close: async () => { input.end(); await running; await app.close(); } };
}

test("a question at the end: one waiting line instead of the receipt and its keys; the receipt is saved", async () => {
  const s = await session([{ files: { "notes.py": "print('two')\n" }, text: "I changed the greeting. Want me to also update the README?" }]);
  try {
    const out = await s.send("change the greeting in notes.py");
    expect(out).toContain("? Waiting for your answer · /receipt 1 shows the 1 file changed so far\n");
    expect(out).not.toContain("changed notes.py");
    expect(out).not.toContain("Not checked");
    expect(out).not.toContain("Show diff");
    expect(await s.send("/receipt 1")).toContain("notes.py");
  } finally { await s.close(); }
}, 60_000);

test("the answer that finishes the work gets the card, naming what changed before the answer", async () => {
  const s = await session([
    { files: { "notes.py": "print('two')\n" }, text: "I changed the greeting. Want me to also update the README?" },
    { files: { "README.md": "Prints two.\n" }, text: "Updated the README." },
  ]);
  try {
    await s.send("change the greeting in notes.py");
    const out = await s.send("yes, update it");
    expect(out).toContain("changed README.md");
    expect(out).toContain("– Also changed before your answer: 1 file (/receipt 1)");
    expect(out).toContain("Show diff");
    expect(out).not.toContain("Waiting for your answer");
  } finally { await s.close(); }
}, 60_000);

test("an answer that changes nothing ends the held work with that work's own receipt and keys", async () => {
  const s = await session([
    { files: { "notes.py": "print('two')\n" }, text: "I changed the greeting. Should I also update the README?" },
    { text: "OK, I'll leave the README as it is." },
  ]);
  try {
    await s.send("change the greeting in notes.py");
    const out = await s.send("no thanks");
    expect(out).toContain("changed notes.py");
    expect(out).toContain("Show diff");
    expect(out).not.toContain("Also changed before");
  } finally { await s.close(); }
}, 60_000);

test("a reply that says what it does next and stops: the paused line, not a receipt", async () => {
  const s = await session([{ files: { "compose.yaml": "services: {}\n" }, text: "The service is not set up yet. Next I'll write its unit file, then start it." }]);
  try {
    const out = await s.send("set up the app in compose");
    expect(out).toContain("Paused — the AI said what it does next; say go, or tell it what to change · /receipt 1 shows the 1 file changed so far\n");
    expect(out).not.toContain("Show diff");
  } finally { await s.close(); }
}, 60_000);

test("a finished task still ends with its receipt and keys", async () => {
  const s = await session([{ files: { "notes.py": "print('two')\n" }, text: "Changed the greeting to two." }]);
  try {
    const out = await s.send("change the greeting in notes.py");
    expect(out).toContain("changed notes.py");
    expect(out).toContain("Show diff");
    expect(out).not.toContain("Waiting for your answer");
    expect(out).not.toContain("Paused");
  } finally { await s.close(); }
}, 60_000);

test("nothing ran and nothing in the project changed: no receipt saying so, the reply is the whole result", async () => {
  let elsewhere = "";
  const replies: Reply[] = [{ text: "Edited the copy in the lab folder; the project needed nothing." }];
  const s = await session(replies);
  elsewhere = path.join(s.root, "elsewhere.txt");
  replies[0]!.seen = elsewhere;
  try {
    const out = await s.send("fix the import in the lab copy");
    expect(out).toContain("Edited the copy in the lab folder");
    expect(out).not.toContain("No files changed");
    expect(out).not.toContain("Show diff");
    expect(out).not.toContain("Waiting for your answer");
  } finally { await s.close(); }
}, 60_000);

test("a failure under a question keeps its receipt, then the waiting line, and no numbered keys", async () => {
  const s = await session([{ files: { "notes.py": "print('two')\n" }, text: "Should I try again with a smaller change?", fail: "provider went away" }]);
  try {
    const out = await s.send("change the greeting in notes.py");
    expect(out).toContain("✗ Failed");
    expect(out).toContain("? Waiting for your answer");
    expect(out.indexOf("? Waiting for your answer")).toBeGreaterThan(out.indexOf("✗ Failed"));
    expect(out).not.toContain("Show diff");
  } finally { await s.close(); }
}, 60_000);

test("on the rich terminal no card and no keys come under a question; the card that ends the work comes with its keys", async () => {
  process.env.TERM = "xterm-256color";
  let folder = "";
  const app = await richApp((project) => { folder = project; return fakeRuntime(() => folder, [
    { files: { "notes.txt": "two\n" }, text: "I changed the notes. Want me to add a heading too?" },
    { files: { "README.md": "Notes.\n" }, text: "Added the heading." },
  ]); });
  try {
    await app.until(text => text.includes("idle"));
    app.input.write("change the notes\r");
    await app.until(text => text.includes("? Waiting for your answer"));
    await app.until(text => text.lastIndexOf("idle") > text.indexOf("? Waiting for your answer"));
    const waiting = app.screen().slice(app.screen().indexOf("I changed the notes"));
    expect(waiting).not.toContain("▌");
    expect(waiting).not.toContain("Show diff");
    app.input.write("yes\r");
    await app.until(text => text.includes("Also changed before your answer"));
    const ended = app.screen().slice(app.screen().indexOf("Added the heading"));
    expect(ended).toContain("▌");
    expect(ended).toContain("Also changed before your answer: 1 file (/receipt 1)");
    await app.until(text => text.slice(text.indexOf("Added the heading")).includes("Show diff"));
  } finally { await app.close(); }
}, 60_000);
