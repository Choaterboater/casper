import { expect, test } from "bun:test";
import { taskOutcome } from "../src/task/result";
import { removeTempDir } from "./support/temp-dir";

const call = '{"name":"bash","arguments":{"command":"ls"}}';
const LINE = "This model wrote a tool call as text instead of using it, so nothing was done. Try a model that supports tools (/model).";

/** One task through the real app: the model's events are scripted, so nothing is run or retried. */
async function runTask(events: unknown[]) {
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { CasperApp } = await import("../src/app");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-text-call-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project); await writeFile(path.join(project, "notes.txt"), "not empty\n");
  const listeners = new Set<(event: never) => void>();
  let prompts = 0;
  const runtime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: (event: never) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { prompts++; for (const event of events) for (const listener of listeners) listener(event as never); },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({ output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime as never, sessionHomeDir: home,
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  try {
    await app.runOnce("Fix the bug in add", project);
    return { output, result: app.getLastTaskResult(), prompts };
  } finally { await app.close(); await removeTempDir(root); }
}

const answer = (text: string) => [{ type: "assistant_response_start" }, { type: "assistant_text_delta", delta: text }, { type: "assistant_response_end", stopReason: "stop" }];

test("a task whose whole answer is a written tool call says so, and is not a success", async () => {
  for (const text of [call, `\`\`\`json\n${call}\n\`\`\``, `<tool_call>${call}</tool_call>`]) {
    const { output, result, prompts } = await runTask(answer(text));
    expect(output).toContain(LINE);
    expect(output).toContain("Did not act");
    expect(result?.wroteToolCallAsText).toBe(true);
    expect(taskOutcome(undefined, result!)).toBe("incomplete");
    expect(prompts).toBe(1); // never asked again
  }
});

test("no line for prose with code, plain JSON data, or a call-shaped answer after real tool calls", async () => {
  const toolRan = [{ type: "assistant_response_start" }, { type: "tool_start", toolName: "read", input: { path: "notes.txt" } },
    { type: "tool_end", toolName: "read", input: { path: "notes.txt" }, isError: false }, ...answer(call)];
  for (const events of [answer(`Use this:\n\`\`\`json\n${call}\n\`\`\`\nDone.`), answer('{"name":"Ada","age":36}'), toolRan]) {
    const { output, result } = await runTask(events);
    expect(output).not.toContain(LINE);
    expect(output).not.toContain("Did not act");
    expect(result?.wroteToolCallAsText).toBeUndefined();
  }
});
