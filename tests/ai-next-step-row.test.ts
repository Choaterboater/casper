import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { answerNextStep } from "../src/task/next-step";
import { removeTempDir } from "./support/temp-dir";

const BLOCKED = "The uplink runs at 2.5 Gbps, so the cap is on the switch port.\n\n"
  + "Blocked: CORE-SW shows OFFLINE in Central, so I can't read its port configuration there.\n\n";

/** An interactive app on the plain terminal whose fake model only answers (no tools, no files): `answer` is its message. */
async function fixture(answer: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-ai-next-"));
  const home = path.join(root, "home"); const project = path.join(root, "work");
  await mkdir(home, { recursive: true }); await mkdir(project, { recursive: true });
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const prompts: string[] = [];
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        complete: async () => ({ text: "[]", usage: { tokens: 10, estimatedCost: 0 } }),
        prompt: async (text) => {
          prompts.push(text);
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          emit({ type: "assistant_text_delta", delta: prompts.length === 1 ? answer : "Done.\n" });
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
  const send = async (line: string) => {
    const from = output.length;
    input.write(`${line}\n`);
    const deadline = Date.now() + 30_000;
    while (!/\n> $/.test(output.slice(from))) {
      if (Date.now() > deadline) throw new Error(`no prompt in:\n${output.slice(from)}`);
      await Bun.sleep(20);
    }
    return output.slice(from);
  };
  return { prompts, send, close: async () => { input.end(); await interactive; await app.close(); await removeTempDir(root); } };
}

test("an answer that ends with the AI's own next step puts it on the Next row, and only its key sends it", async () => {
  const f = await fixture(`${BLOCKED}Next step: Read CORE-SW's port 1/1/5 over ssh (asks for the switch login).\n`);
  try {
    const shown = await f.send("why is the Wi-Fi capped at 300 Mbps?");
    expect(shown).toContain("Next: 1 Read CORE-SW's port 1/1/5 over ssh (asks for the switch login) (uses tokens)");
    expect(f.prompts).toHaveLength(1);
    await f.send("1");
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("Read CORE-SW's port 1/1/5 over ssh (asks for the switch login)");
  } finally { await f.close(); }
}, 60_000);

test("a next step that is the person's to do (reconnect it, then tell me) is not put on the row", async () => {
  const f = await fixture(`${BLOCKED}Next step: reconnect CORE-SW to Central, then tell me and I'll check port 1/1/5.\n`);
  try {
    const shown = await f.send("why is the Wi-Fi capped at 300 Mbps?");
    expect(shown).not.toContain("Next: ");
  } finally { await f.close(); }
}, 60_000);

test("only the answer's last line names the step: markdown is dropped, and a slash command or a long line is not a step", () => {
  expect(answerNextStep("Found it.\n\n**Next step:** read `CORE-SW`'s port 1/1/5 over ssh.\n")).toBe("Read CORE-SW's port 1/1/5 over ssh");
  expect(answerNextStep("- Next step: check the AP's uplink in Mist")).toBe("Check the AP's uplink in Mist");
  expect(answerNextStep("Next step: read the port.\n\nAnything else?")).toBeUndefined();
  expect(answerNextStep("Next step: /undo")).toBeUndefined();
  expect(answerNextStep(`Next step: ${"read the port ".repeat(20)}`)).toBeUndefined();
  expect(answerNextStep("Next step: once your switch is back, I'll read it")).toBeUndefined();
});
