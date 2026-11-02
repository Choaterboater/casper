import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { STOPPED_NOTHING_CHANGED } from "../src/app/task-run";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

for (const changed of [false, true]) test(changed ? "a user cancel after a change prints one cancel notice and the Stopped receipt, with no [error] lines"
  : "a user cancel before anything happened ends with one neutral line, no Stopped card", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cancel-notice-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]); await writeFile(path.join(project, "notes.txt"), "An empty folder would ask about a new project.\n");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const started = Promise.withResolvers<void>();
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {},
        // The shape of Pi's cancel: the stream ends "aborted" with its message, then the adapter
        // reports the thrown AbortError as an error event and rethrows it.
        prompt: (_text: string, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          if (changed) {
            emit({ type: "tool_start", toolName: "bash", toolCallId: "b1", input: { command: "echo x > notes.txt" } });
            writeFileSync(path.join(project, "notes.txt"), "x\n");
            emit({ type: "tool_end", toolName: "bash", toolCallId: "b1", isError: false, input: { command: "echo x > notes.txt" } });
          }
          started.resolve();
          signal?.addEventListener("abort", () => {
            emit({ type: "assistant_response_end", stopReason: "aborted", errorMessage: "Request was aborted" });
            const error = new DOMException("The operation was aborted.", "AbortError");
            emit({ type: "error", message: error.message });
            reject(error);
          }, { once: true });
        }),
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const receipt = Promise.withResolvers<void>();
  const app = new CasperApp({
    input, output: { write: (text: string) => { output += text; if (output.includes(changed ? "✗ Stopped" : STOPPED_NOTHING_CHANGED)) receipt.resolve(); } },
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  try {
    input.write("do something slow\n");
    await started.promise;
    expect(app.interrupt()).toBe(true);
    await receipt.promise;
    expect(output.match(/\[cancel\]/g)).toHaveLength(1);
    if (changed) expect(output).toContain("✗ Stopped — cancelled; changes already made are kept");
    else {
      // The smoke session: the AI's question skipped, nothing done, and a full amber "⚠ Stopped" card for it.
      expect(output).toContain(`[cancel] Stopping. Changes made so far stay as they are.\n`);
      expect(output).toContain(STOPPED_NOTHING_CHANGED);
      expect(output).not.toMatch(/Stopped — cancelled|What these words mean/);
    }
    expect(output).not.toContain("[error]");
    input.end();
    await interactive;
  } finally {
    await app.close();
    await removeTempDir(root);
  }
});
