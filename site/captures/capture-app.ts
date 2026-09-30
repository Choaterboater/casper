// Capture helper for the website. A scripted stand-in for the model: no provider, no API key,
// no network. Everything else (checks, proof, receipts, MCP, approvals) is real Casper 0.2.15.
// Run from a project folder:  bun <casper>/site/captures/capture-app.ts
// The scripted "model" acts on the first request it sees, then makes no more changes.
import { readFile, writeFile } from "node:fs/promises";
import { CasperApp } from "../../src/app";
import { installShutdownHandlers } from "../../src/cli";
import { taskExitCode } from "../../src/task/result";
import { formatJsonEvent, receiptEvent, type CasperEvent } from "../../src/app/json-events";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeTool } from "../../src/runtime/types";

const listeners = new Set<RuntimeEventListener>();
const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
const say = (text: string) => emit({ type: "assistant_text_delta", delta: text });
let tools: RuntimeTool[] = [];
let acted = false;

async function edit(path: string, change: (text: string) => string) {
  emit({ type: "tool_start", toolName: "edit", toolCallId: `edit-${path}`, input: { path } });
  await Bun.sleep(150);
  await writeFile(path, change(await readFile(path, "utf8")));
  emit({ type: "tool_end", toolName: "edit", toolCallId: `edit-${path}`, input: { path }, isError: false });
}

async function act(request: string, signal?: AbortSignal) {
  if (/fix the sum bug/i.test(request)) {
    await edit("src/sum.js", (text) => text.replace("a - b", "a + b"));
    await edit("tests/sum.test.js", (text) => text + 'test("adds two numbers", () => expect(sum(2, 3)).toBe(5));\n');
    say("Fixed: `sum` subtracted instead of adding. Added a test for `sum(2, 3)`.\n");
  } else if (/numeric strings/i.test(request)) {
    await edit("src/sum.js", (text) => text.replace("a + b", "Number(a) + Number(b)"));
    say("`sum` now turns its inputs into numbers first.\n");
  } else if (/speed up sum/i.test(request)) {
    await edit("src/sum.js", (text) => text.replace("a + b", "a * b"));
    say("Changed `sum`.\n");
  } else if (/set the lab site/i.test(request)) {
    say("I will ask the fixture server to change the site.\n");
    const invoke = tools.find((tool) => tool.name === "call_capability")!;
    const result = await invoke.execute({ id: "mcp:fixture:set_site", arguments: { site: "lab" } }, signal);
    say(result.isError ? "The change was not made.\n" : "The server says the site is set.\n");
  } else say(`(scripted model) Nothing to do for: ${request}\n`);
}

const runtime: AgentRuntime = {
  async start(options) {
    tools = options.tools ?? [];
    return {
      setTools(next) { tools = next; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
      getStatus: () => ({ provider: "scripted", model: "site-capture", auth: "configured", thinkingLevel: "off" }),
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async abort() {},
      async prompt(prompt, signal) {
        emit({ type: "assistant_response_start" });
        if (!acted) { acted = true; await act(prompt.split("User request:\n").at(-1)!, signal); }
        else say("(scripted model) No more changes.\n");
        emit({ type: "assistant_response_end", stopReason: signal?.aborted ? "aborted" : "stop" });
        emit({ type: "message_end" });
      },
    };
  },
  async dispose() {},
};
// --json "<prompt>": the same one-shot JSON Lines run as `casper --json "<prompt>"` (src/cli.ts), with the scripted model.
if (process.argv[2] === "--json") {
  const emit = (event: CasperEvent) => { process.stdout.write(formatJsonEvent(event)); };
  const app = new CasperApp({ runtimeFactory: () => runtime, onEvent: emit, output: { write: (text: string) => { process.stderr.write(text); } } });
  try {
    const report = await app.runOnce(process.argv.slice(3).join(" "));
    const task = app.getLastTaskResult();
    const exitCode = taskExitCode(report, task, { requireVerification: false });
    process.exitCode = exitCode;
    emit(receiptEvent(report, task, exitCode));
  } finally { await app.close(); }
} else {
  const app = new CasperApp({ runtimeFactory: () => runtime });
  const remove = installShutdownHandlers(app);
  try { await app.runInteractive(); }
  finally { await app.close(); remove(); }
}
