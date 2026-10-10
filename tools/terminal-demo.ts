// THROWAWAY OFFLINE DEMO: Does scrollback + an anchored editor/footer feel usable?
// bun tools/terminal-demo.ts
// No model requests, credentials, source edits or settings writes. Synthetic state only.
// /model and /effort open Casper's real model browser and effort picker over made-up models;
// a request plays made-up runtime events through Casper's own event view: the AI's words, steps that tick in under
// them and fold into one row, an edit box, a failure box and the status row.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RuntimeEventView } from "../src/app/events";
import type { RuntimeEvent } from "../src/runtime/types";
import { InteractiveTerminal } from "../src/tui/terminal";
import { pickEffort } from "../src/tui/effort-picker";
import { pickPiModel } from "../src/runtime/pi-model-picker";

/** A made-up model: no provider is ever called. */
function demoModel(id: string, reasoning: boolean): Model<Api> {
  return {
    id, name: id, api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1:9/v1",
    reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 4_000,
  } as Model<Api>;
}
const models = [demoModel("alpha", true), demoModel("beta", false)];
// The browser only reads the snapshot, the error and refresh; nothing here touches the network.
const catalog = {
  getAvailableSnapshot: () => models,
  getError: () => undefined,
  refresh: async () => ({ aborted: false, errors: new Map<string, Error>() }),
} as unknown as ModelRuntime;

let running = true, cancelled = false, model = "fixture/alpha", effort = "medium", working = false;
const terminal = new InteractiveTerminal(process.stdin, process.stdout,
  () => { cancelled = true; terminal.write("[cancel] Synthetic work cancelled.\n"); },
  () => { running = false; });
const footer = () => terminal.setStatus(`demo/main │ ${model} · ${effort} │ ctx 28%~ │ ${working ? "working" : "idle"}`);
const events = new RuntimeEventView(terminal, { write: text => terminal.write(text) }, {
  updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => cancelled,
  projectRoot: () => process.cwd(),
});
const patch = "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,4 @@\n export function sum(a: number, b: number) {\n-  return a - b;\n+  if (!Number.isFinite(a + b)) throw new Error(\"not a number\");\n+  return a + b;\n }\n";
const words = (text: string): RuntimeEvent[] => [{ type: "assistant_response_start", provider: "fixture", model: "alpha" }, { type: "assistant_text_delta", delta: text }];
const tool = (id: string, toolName: string, input: Record<string, string>, end: Partial<Extract<RuntimeEvent, { type: "tool_end" }>> = {}): RuntimeEvent[] => [
  { type: "tool_start", toolName, toolCallId: id, input },
  { type: "tool_end", toolName, toolCallId: id, input, isError: false, ...end },
];
/** The pause before each made-up event, in ms (CASPER_DEMO_PACE; the layout test plays it fast). */
const pace = Math.max(0, Number(process.env.CASPER_DEMO_PACE ?? 300) || 0);
/** One made-up task, as a runtime would send it: a pause before each event, so the live rows and the status row show. */
const script: RuntimeEvent[][] = [
  words("I'll read the code and the tests first.\n"),
  tool("1", "read", { path: "src/example.ts" }), tool("2", "read", { path: "tests/example.test.ts" }),
  tool("3", "bash", { command: "echo === status ===\ngit status --short\ngit log --oneline -3" }),
  words("The sum subtracts. I'll fix it and run the tests.\n"),
  tool("4", "edit", { path: "src/example.ts" }, { lines: { added: 2, removed: 1 }, diff: patch }),
  [{ type: "tool_start", toolName: "bash", toolCallId: "5", input: { command: "bun test" } },
    { type: "tool_progress", toolName: "bash", toolCallId: "5", text: "tests/example.test.ts:\n(pass) sum adds" },
    { type: "tool_end", toolName: "bash", toolCallId: "5", input: { command: "bun test" }, isError: false }],
  tool("6", "bash", { command: "git push" }, { isError: true, output: { text: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\nCommand exited with code 128", truncated: false } }),
  words("Demo complete. No real tools ran.\n\nThe sum now adds, and **bun test** passes. The push failed: this demo has no login.\n"),
  [{ type: "assistant_response_end", stopReason: "stop" }, { type: "message_end" }],
];
terminal.start();
terminal.write("CASPER · OFFLINE INTERFACE DEMO (all state synthetic)\nTry /, /model, /effort, multiline input, history, resize and cancellation.\n");
try {
  while (running) {
    working = false; footer();
    const input = await terminal.readCommand();
    if (input === undefined || input.trim() === "/exit") break;
    cancelled = false;
    if (input.trim() === "/model" || input.trim() === "/effort") {
      const host = terminal.exclusiveHost();
      if (host && input.trim() === "/model") {
        const [provider, id] = model.split("/");
        const picked = await host.mount(view => pickPiModel(view, catalog, models.find(m => m.provider === provider && m.id === id), undefined, undefined));
        if (picked) model = `${picked.provider}/${picked.id}`;
      } else if (host) {
        const picked = await host.mount(view => pickEffort(view, ["auto", "off", "low", "medium", "high"], effort));
        if (picked) effort = picked.level;
      }
      terminal.write(`Demo state: model=${model}, effort=${effort}. Nothing saved.\n`);
    } else if (input.startsWith("/")) {
      terminal.write("Demo commands: /model, /effort, /exit. Other palette entries belong to real Casper.\n");
    } else {
      working = true; footer();
      for (const batch of script) {
        for (const event of batch) {
          // The turn's end comes right after its last words, as from a runtime.
          if (event.type !== "assistant_response_end" && event.type !== "message_end") await Bun.sleep(pace);
          if (cancelled || !running) break;
          events.handle(event);
        }
        if (cancelled || !running) break;
      }
      events.reset();
    }
  }
} finally { terminal.close(); }
