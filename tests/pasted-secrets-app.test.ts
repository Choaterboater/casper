import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** A copied terminal screen with a tunnel token in it, pasted into a request on the full terminal: the box before the
 * AI gets anything, Enter removes it, 2 sends it as pasted. */
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const TOKEN = "eyJhIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJ0IjoiMTExMTExMTEtMjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1IiwicyI6IlpXWmhhMlZ6WldOeVpYUT0ifQ==";
const SCREEN = ["user@nas ~ % ls", "docker-compose.yml", `user@nas ~ % docker run -d cloudflare/cloudflared tunnel run --token ${TOKEN}`, "Unable to find image"].join("\n");

function screen() {
  let output = "";
  const waiters: Array<{ test: (output: string) => boolean; resolve: () => void }> = [];
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 140, rows: 30, write(text: string) {
    output += Bun.stripANSI(text);
    for (const waiter of [...waiters]) if (waiter.test(output)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  return {
    writer,
    get output() { return output; },
    until(test: (output: string) => boolean): Promise<void> {
      if (test(output)) return Promise.resolve();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(() => reject(new Error(`screen did not match; it ends with:\n${output.slice(-2500)}`)), 20_000);
      waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
      return promise;
    },
  };
}

/** Polls: what it waits for (a prompt sent, the task over) need not write to the screen. */
async function poll(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-pasted-secret-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  mode: off\n");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const prompts: string[] = [];
  const session: RuntimeSession = {
    getStatus: () => ({ provider: "fixture", model: "main", auth: "configured", configuredEffort: "medium", thinkingLevel: "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"] }),
    getState: () => ({ cwd: project, isStreaming: false }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    abort: async () => {}, setTools: () => {},
    prompt: async (text) => {
      prompts.push(text);
      emit({ type: "assistant_response_start", provider: "fixture", model: "main" });
      emit({ type: "assistant_text_delta", delta: "Done.\n" });
      emit({ type: "assistant_response_end", stopReason: "stop" });
    },
  };
  const runtime: AgentRuntime = { start: async () => session, dispose: async () => {} };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const view = screen();
  const app = new CasperApp({
    input, output: view.writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  await view.until((output) => output.includes("idle"));
  return { app, view, input, prompts,
    cleanup: async () => { input.write("/exit\r"); await interactive; await app.close(); input.destroy(); await removeTempDir(root); } };
}

async function pasteAndAnswer(key: string) {
  const f = await fixture();
  f.input.write(`what went wrong here? \x1b[200~${SCREEN}\x1b[201~\r`);
  await f.view.until((output) => output.includes("This looks like a copied terminal screen with a secret in it"));
  f.input.write(key);
  await poll(() => f.prompts.length === 1);
  await poll(() => !f.app.commandActive);
  return f;
}

test("Enter removes it: the AI gets <secret hidden>, the box showed the line without the token, and one line says so", async () => {
  const f = await pasteAndAnswer("\r");
  try {
    expect(f.prompts[0]).not.toContain(TOKEN);
    expect(f.prompts[0]).toContain("tunnel run --token <secret hidden>");
    expect(f.prompts[0]).toContain("what went wrong here?");
    expect(f.view.output).toContain("1. Remove it");
    expect(f.view.output).toContain("2. Send anyway");
    expect(f.view.output).toContain("[paste] Removed a secret from the copied screen; the AI gets <secret hidden> in its place.");
  } finally { await f.cleanup(); }
});

test("2 sends it as pasted", async () => {
  const f = await pasteAndAnswer("2");
  try {
    expect(f.prompts[0]).toContain(`--token ${TOKEN}`);
    expect(f.view.output).not.toContain("[paste] Removed");
  } finally { await f.cleanup(); }
});

test("a paste with no secret goes straight through, with no box", async () => {
  const f = await fixture();
  try {
    f.input.write(`what went wrong here? \x1b[200~${SCREEN.replace(` --token ${TOKEN}`, "")}\x1b[201~\r`);
    await poll(() => f.prompts.length === 1);
    await poll(() => !f.app.commandActive);
    expect(f.view.output).not.toContain("with a secret in it");
  } finally { await f.cleanup(); }
});
