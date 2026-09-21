// THROWAWAY OFFLINE DEMO: Does scrollback + an anchored editor/footer feel usable?
// bun tools/terminal-demo.ts
// No model requests, credentials, source edits or settings writes. Synthetic state only.
import { InteractiveTerminal } from "../src/tui/terminal";
import { pickEffort } from "../src/tui/effort-picker";

let running = true, cancelled = false, model = "fixture/alpha", effort = "medium";
const terminal = new InteractiveTerminal(process.stdin, process.stdout,
  () => { cancelled = true; terminal.write("[cancel] Synthetic work cancelled.\n"); },
  () => { running = false; });
terminal.write("CASPER · OFFLINE INTERFACE DEMO (all state synthetic)\nTry /, /model, /effort, multiline input, history, resize and cancellation.\n");
terminal.start();
try {
  while (running) {
    terminal.setStatus(`demo/main │ ${model} · ${effort} │ ctx 28% (fixture) │ idle`);
    const input = await terminal.readCommand();
    if (input === undefined || input.trim() === "/exit") break;
    cancelled = false;
    if (input.trim() === "/model" || input.trim() === "/effort") {
      const choosingModel = input.trim() === "/model";
      const host = terminal.exclusiveHost();
      if (host) {
        const picked = await host.run(io => pickEffort(io,
          choosingModel ? ["fixture/alpha", "fixture/beta"] : ["off", "low", "medium", "high"],
          choosingModel ? model : effort, undefined, choosingModel ? "Model · offline synthetic choices" : "Effort · offline synthetic choices"));
        if (picked) { if (choosingModel) model = picked.level; else effort = picked.level; }
      }
      terminal.write(`Demo state: model=${model}, effort=${effort}. Nothing saved.\n`);
    } else if (input.startsWith("/")) {
      terminal.write("Demo commands: /model, /effort, /exit. Other palette entries belong to real Casper.\n");
    } else {
      for (const event of ["✓ read  src/example.ts", "✓ edit  src/example.ts (synthetic)", "✓ test  simulated checks"]) {
        await Bun.sleep(500);
        if (cancelled || !running) break;
        terminal.write(event + "\n");
      }
      if (!cancelled && running) { terminal.assistant("Demo complete. No real tools ran.\n"); terminal.endAssistant(); }
    }
  }
} finally { terminal.close(); }
