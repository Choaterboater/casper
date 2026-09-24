import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";

test("a user cancel prints one cancel notice and the receipt, with no [error] lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-cancel-notice-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]);
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
    input, output: { write: (text: string) => { output += text; if (output.includes("[task]")) receipt.resolve(); } },
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
    expect(output).toContain("[task] Execution cancelled");
    expect(output).not.toContain("[error]");
    input.end();
    await interactive;
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
