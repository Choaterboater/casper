import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/**
 * A real session ended task after task with "Still not done" lines the AI could have done itself, and the person had to
 * write "do all of them" and "why are you stopping just do all of them". Now Casper says it for them: when the AI stops
 * with work still open, or says what it does next and stops, and asked nothing, Casper sends it on, twice at most.
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

interface Reply { files?: Record<string, string>; text: string }

async function session(replies: Reply[], config?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-keep-going-")); roots.push(root);
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(project, { recursive: true });
  if (config) await writeFile(path.join(home, ".casper", "config.yaml"), config);
  await writeFile(path.join(project, "notes.py"), "print('one')\n");
  const prompts: string[] = [];
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async (text: string) => {
          prompts.push(text);
          const reply = replies.shift() ?? { text: "No reply was scripted for this prompt." };
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          for (const [file, body] of Object.entries(reply.files ?? {})) await writeFile(path.join(project, file), body);
          emit({ type: "assistant_text_delta", delta: reply.text });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const app = new CasperApp({
    input, output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
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
  return { prompts, send, close: async () => { input.end(); await running; await app.close(); } };
}

test("the AI stops with work it can do: Casper sends it on once, with the open items, and the card ends the work", async () => {
  const s = await session([
    { files: { "notes.py": "print('two')\n" }, text: "Changed the greeting.\n\nStill not done: update the README — I ran out of this step" },
    { files: { "README.md": "Prints two.\n" }, text: "Updated the README too." },
  ]);
  try {
    const out = await s.send("change the greeting in notes.py and say so in the README");
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toContain("Still open:\n- update the README — I ran out of this step");
    expect(s.prompts[1]).toContain("Leave only what needs the person");
    expect(out).toContain("↻ keep going 1/2: 1 item still open, so the AI carries on (Esc stops it)");
    expect(out).toContain("Show diff");
    expect(out).not.toContain("Waiting for your answer");
  } finally { await s.close(); }
}, 60_000);

test("the AI says what it does next and stops: Casper says go once, instead of the paused line", async () => {
  const s = await session([
    { files: { "notes.py": "print('two')\n" }, text: "The greeting is changed. Next I'll update the README to match." },
    { files: { "README.md": "Prints two.\n" }, text: "Updated the README." },
  ]);
  try {
    const out = await s.send("change the greeting in notes.py");
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toContain("You said what you do next and stopped: do it now.");
    expect(out).toContain("↻ keep going 1/2: the AI said what it does next, so it carries on (Esc stops it)");
    expect(out).not.toContain("Paused");
  } finally { await s.close(); }
}, 60_000);

test("a question, or keep_going off, gets no round: the person answers or says go", async () => {
  const asks = await session([{ files: { "notes.py": "print('two')\n" }, text: "Changed it.\n\nStill not done: the README — which wording do you want?\n\nShould the README say two or 2?" }]);
  try {
    const out = await asks.send("change the greeting in notes.py");
    expect(asks.prompts).toHaveLength(1);
    expect(out).toContain("? Waiting for your answer");
    expect(out).not.toContain("keep going");
  } finally { await asks.close(); }
  const off = await session([{ files: { "notes.py": "print('two')\n" }, text: "Changed it.\n\nStill not done: update the README — not started" }], "keep_going: off\n");
  try {
    const out = await off.send("change the greeting in notes.py");
    expect(off.prompts).toHaveLength(1);
    expect(out).not.toContain("keep going");
  } finally { await off.close(); }
}, 60_000);

test("a round that leaves as much open as before stops there, and two rounds is the most", async () => {
  const stuck = await session([
    { text: "Started.\n\nStill not done: A — x\nStill not done: B — y" },
    { text: "Tried again.\n\nStill not done: A — x\nStill not done: B — y" },
  ]);
  try {
    const out = await stuck.send("do A and B");
    expect(stuck.prompts).toHaveLength(2);
    expect(out).toContain("↻ keep going 1/2: 2 items still open");
    expect(out).not.toContain("↻ keep going 2/2");
  } finally { await stuck.close(); }
  const slow = await session([
    { text: "Started.\n\nStill not done: A — x\nStill not done: B — y\nStill not done: C — z" },
    { text: "Did A.\n\nStill not done: B — y\nStill not done: C — z" },
    { text: "Did B.\n\nStill not done: C — z" },
  ]);
  try {
    const out = await slow.send("do A, B and C");
    expect(slow.prompts).toHaveLength(3);
    expect(out).toContain("↻ keep going 2/2: 2 items still open");
  } finally { await slow.close(); }
}, 90_000);
