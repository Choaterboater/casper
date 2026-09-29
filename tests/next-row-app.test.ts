import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";

test("the row under an interactive receipt runs the step whose number is typed next", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-next-row-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]);
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {},
        prompt: async () => {
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          emit({ type: "assistant_text_delta", delta: "Done.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  const until = (text: string) => {
    if (output.includes(text)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ text, resolve });
    return promise;
  };
  const app = new CasperApp({
    input, output: { write: (text: string) => { output += text; for (const waiter of waiters) if (output.includes(waiter.text)) waiter.resolve(); } },
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const offered: string[] = [];
  app.nextSteps.push((task) => { offered.push(task.execution); return { diff: { label: "Show status", command: "/status" } }; });
  const interactive = app.runInteractive(project);
  try {
    input.write("fix the typo in notes.py\n");
    await until("Next: 2 Show status");
    expect(offered).toEqual(["completed"]);
    input.write("2\n");
    // /status ran: its checks line is Casper's own output, not a model prompt.
    await until(" checks    ");
    input.end();
    await interactive;
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
