import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

const GUIDE = `Set this up for Home Assistant:
1. Create the tunnel in the Cloudflare dashboard and copy its token
2. Add cloudflared to docker-compose.yml with that token
3. Publish ha.example.org as a public hostname pointing at http://homeassistant:8123
4. Add the tunnel to Home Assistant's trusted_proxies
5. Add a WAF rule that only allows my country`;

/** An interactive app on the plain terminal. The fake model writes the compose file, says it is done with no open items,
 * and its side call (`complete`) names the next step. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-next-step-"));
  const home = path.join(root, "home"); const project = path.join(root, "docker");
  await mkdir(home, { recursive: true }); await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "docker-compose.yml"), "services: {}\n");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const prompts: string[] = [];
  const sideCalls: string[] = [];
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        // Casper's other side calls (the request's checklist) get an empty list; the next-step call gets the step.
        complete: async (input) => {
          if (!input.systemPrompt.includes("first step of the request")) return { text: "[]", usage: { tokens: 100, estimatedCost: 0 } };
          sideCalls.push(input.user);
          return { text: "Publish ha.example.org as a public hostname", usage: { tokens: 2200, estimatedCost: 0.001 } };
        },
        prompt: async (text) => {
          prompts.push(text);
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          await writeFile(path.join(project, "docker-compose.yml"), `services:\n  cloudflared:\n    image: cloudflare/cloudflared  # ${prompts.length}\n`);
          // The model's own last words: what it did, nothing open, no question, no "next".
          emit({ type: "assistant_text_delta", delta: "The tunnel is created and cloudflared is in docker-compose.yml.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const app = new CasperApp({
    input, output: { write: (text: string) => { output += text; } },
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  const send = async (line: string, done: RegExp) => {
    const from = output.length;
    input.write(`${line}\n`);
    const deadline = Date.now() + 25_000;
    while (!done.test(output.slice(from))) {
      if (Date.now() > deadline) throw new Error(`no ${done} in:\n${output.slice(from)}`);
      await Bun.sleep(20);
    }
    return output.slice(from);
  };
  return { prompts, sideCalls, send, close: async () => { input.end(); await interactive; await app.close(); await removeTempDir(root); } };
}

test("a pasted guide whose first step the AI finished: the row offers the request's next step before anything else, and only its key runs it", async () => {
  const f = await fixture();
  try {
    // The plain terminal reads one line: the guide's steps on it, as a paste with its line breaks lost.
    const shown = await f.send(GUIDE.replaceAll("\n", " "), /Next: .*\n[\s\S]*\n> $/);
    expect(f.sideCalls).toHaveLength(1);
    expect(f.sideCalls[0]).toContain("5. Add a WAF rule");
    expect(shown).toContain("Next: 1 Show diff · 2 Undo · 3 Continue: Publish ha.example.org as a public hostname (uses tokens)");
    expect(shown).toContain("  Why 3: the request has more steps, and the AI didn't say what is left");
    // Nothing ran on its own: one model turn so far.
    expect(f.prompts).toHaveLength(1);
    await f.send("3", /\n> $/);
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("Continue with the next step of the request: Publish ha.example.org as a public hostname");
  } finally { await f.close(); }
}, 60_000);

test("a request with no list of steps makes no side call and offers no step", async () => {
  const f = await fixture();
  try {
    const shown = await f.send("add cloudflared to docker-compose.yml", /\n> $/);
    expect(f.sideCalls).toHaveLength(0);
    expect(shown).not.toContain("Continue:");
  } finally { await f.close(); }
}, 60_000);
