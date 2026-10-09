// THROWAWAY OFFLINE DEMO: Does scrollback + an anchored editor/footer feel usable?
// bun tools/terminal-demo.ts
// No model requests, credentials, source edits or settings writes. Synthetic state only.
// /model and /effort open Casper's real model browser and effort picker over made-up models;
// tool lines and the footer use Casper's own formats.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InteractiveTerminal } from "../src/tui/terminal";
import { pickEffort } from "../src/tui/effort-picker";
import { formatToolActivity } from "../src/tui/format";
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
const steps = [
  formatToolActivity({ type: "tool_end", toolName: "read", input: { path: "src/example.ts" }, isError: false }),
  formatToolActivity({ type: "tool_end", toolName: "edit", input: { path: "src/example.ts" }, isError: false, lines: { added: 3, removed: 1 } }),
  formatToolActivity({ type: "tool_end", toolName: "bash", input: { command: "bun test" }, isError: false }, 2_500),
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
      for (const step of steps) {
        await Bun.sleep(500);
        if (cancelled || !running) break;
        terminal.write(step + "\n");
      }
      if (!cancelled && running) { terminal.assistant("Demo complete. No real tools ran.\n"); terminal.endAssistant(); }
    }
  }
} finally { terminal.close(); }
