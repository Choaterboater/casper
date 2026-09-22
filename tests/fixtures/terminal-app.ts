// Scripted runtime only: PTY acceptance never imports Pi or contacts a provider.
import { appendFile, access } from "node:fs/promises";
import path from "node:path";
import { CasperApp } from "../../src/app";
import { installShutdownHandlers } from "../../src/cli";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeTool } from "../../src/runtime/types";

const control = process.env.CASPER_TTY_CONTROL!;
async function wait(name: string, signal?: AbortSignal) {
  while (!signal?.aborted) {
    if (await access(path.join(control, name)).then(() => true, () => false)) return;
    await Bun.sleep(10);
  }
}
const listeners = new Set<RuntimeEventListener>();
const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
let tools: RuntimeTool[] = [];
let cancelled = false;
const runtime: AgentRuntime = {
  async start(options) {
    tools = options.tools ?? [];
    return {
      setTools(next) { tools = next; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
      getStatus: () => ({ provider: "scripted", model: "terminal-fixture", auth: "configured", thinkingLevel: "off" }),
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async abort() { cancelled = true; },
      async prompt(prompt, signal) {
        cancelled = false;
        const request = prompt.split("User request:\n").at(-1)!;
        await appendFile(path.join(control, "requests.jsonl"), JSON.stringify(request) + "\n");
        emit({ type: "assistant_response_start" });
        if (request === "stream") {
          emit({ type: "assistant_text_delta", delta: "# Heading\nFirst **bold** and `code` " });
          await wait("stream-step", signal);
          emit({ type: "assistant_text_delta", delta: "text.\n" });
          emit({ type: "tool_start", toolName: "read", toolCallId: "read-1", input: { path: "src/example.ts" } });
          await wait("stream-end", signal);
          emit({ type: "tool_end", toolName: "read", toolCallId: "read-1", input: { path: "src/example.ts" }, isError: false });
          emit({ type: "assistant_text_delta", delta: "Done streaming.\n" });
        } else if (request === "progress") {
          emit({ type: "assistant_progress", kind: "thinking", chars: 0 });
          emit({ type: "assistant_progress", kind: "thinking", chars: 1536 });
          await wait("progress-step", signal);
          emit({ type: "assistant_progress", kind: "tool_call", toolName: "write", chars: 4096 });
          await wait("progress-end", signal);
          emit({ type: "tool_start", toolName: "write", toolCallId: "write-1", input: { path: "site/index.html" } });
          emit({ type: "tool_end", toolName: "write", toolCallId: "write-1", input: { path: "site/index.html" }, isError: false });
          emit({ type: "assistant_text_delta", delta: "Written.\n" });
        } else if (request === "code") {
          emit({ type: "assistant_text_delta", delta: "Here is the fix:\n\n```ts\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```\n\nAnd a shell step:\n\n```sh\nbun test\n```\n" });
        } else if (request.startsWith("approval")) {
          emit({ type: "assistant_text_delta", delta: "Preparing approval.\n" });
          await wait(request, signal);
          const invoke = tools.find((tool) => tool.name === "call_capability")!;
          const result = await invoke.execute({ id: "mcp:fixture:set_site", arguments: { site: "lab" } }, signal);
          await appendFile(path.join(control, "approvals.jsonl"), result.text + "\n");
          emit({ type: "assistant_text_delta", delta: `Approval result: ${result.isError ? "denied" : "allowed"}\n` });
        } else if (request === "hold") {
          emit({ type: "assistant_text_delta", delta: "Waiting for cancellation.\n" });
          while (!cancelled && !signal?.aborted) await Bun.sleep(10);
        } else emit({ type: "assistant_text_delta", delta: `Echo: ${request}\n` });
        emit({ type: "assistant_response_end", stopReason: cancelled || signal?.aborted ? "aborted" : "stop" });
        emit({ type: "message_end" });
      },
    };
  },
  async dispose() {},
};
const app = new CasperApp({ runtimeFactory: () => runtime });
const remove = installShutdownHandlers(app);
try { await app.runInteractive(); }
finally { await app.close(); remove(); }
