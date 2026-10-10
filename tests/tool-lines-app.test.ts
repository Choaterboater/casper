import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { fakeWriter } from "./support/tty";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

test("a tool that ends after its turn still prints its line before the prompt returns, and never in the next task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-late-tool-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]); await writeFile(path.join(project, "notes.txt"), "not empty\n");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
  let prompts = 0;
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        setTools: () => {},
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {},
        prompt: async () => {
          if (prompts++ === 0) {
            const input = { command: "sleep 5" };
            emit({ type: "tool_start", toolName: "bash", toolCallId: "late", input });
            emit({ type: "message_end" });
            // Ends after its turn folded: the receipt's reset must still print it.
            emit({ type: "tool_end", toolName: "bash", toolCallId: "late", input, isError: false });
          } else {
            emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
            emit({ type: "assistant_text_delta", delta: "SECOND_ANSWER" });
            emit({ type: "assistant_response_end", stopReason: "stop" });
            emit({ type: "message_end" });
          }
        },
      };
    },
    async dispose() {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = new CasperApp({
    input, output: screen.writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  // The folded row names the step; its live row ("  ✓ bash · sleep 5") is gone by then.
  const printed = (output: string) => output.match(/● ran sleep 5/g)?.length ?? 0;
  const idle = (output: string) => output.trimEnd().endsWith("│ idle");
  try {
    await screen.until(output => output.includes("idle"));
    input.write("wait a bit\r");
    await screen.until(output => printed(output) > 0 && idle(output));
    expect(printed(Bun.stripANSI(screen.output))).toBeGreaterThan(0);
    const before = Bun.stripANSI(screen.output).length;
    input.write("and now answer\r");
    await screen.until(output => output.slice(before).includes("SECOND_ANSWER") && idle(output));
    expect(printed(Bun.stripANSI(screen.output).slice(before))).toBe(0);
  } finally {
    input.write("/exit\r");
    await interactive;
    await app.close();
    await removeTempDir(root);
  }
});
