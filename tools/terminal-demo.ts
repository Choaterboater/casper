// Offline terminal demo: synthetic state only, no model requests or disk writes.
// bun tools/terminal-demo.ts
import { InteractiveTerminal } from "../src/tui/terminal";
import { pickEffort } from "../src/tui/effort-picker";
import { formatToolActivity } from "../src/tui/format";

let running = true, cancelled = false, model = "fixture/alpha", effort = "medium";
const terminal = new InteractiveTerminal(process.stdin, process.stdout,
  () => { cancelled = true; terminal.writePanel("Demo cancelled", "Synthetic work stopped. Your draft stays in the editor.", "warning"); },
  () => { running = false; });
terminal.writePanel("Casper · offline interface demo", [
  "All data is synthetic. No models, real tools, credentials or disk writes.",
  "1. Send a message to see streaming Markdown and tool activity.",
  "2. Type a draft during work; Enter will not queue it. Try Esc to cancel.",
  "3. Resize the terminal, use multiline input, then recall a message with Up.",
  "Demo commands: /model · /effort · /approve · /error · /status · /exit",
  "The / palette also lists real Casper commands; they do not run in this demo.",
].join("\n"));
terminal.start();
try {
  while (running) {
    terminal.setStatus(`demo/main │ ${model} · ${effort} │ context 28% (synthetic estimate) │ cost unavailable`);
    const input = await terminal.readCommand();
    if (input === undefined || input.trim() === "/exit") break;
    cancelled = false;
    const command = input.trim();
    if (command === "/model" || command === "/effort") {
      const choosingModel = command === "/model";
      const host = terminal.exclusiveHost();
      if (host) {
        const picked = await host.run(io => pickEffort(io,
          choosingModel ? ["fixture/alpha", "fixture/beta"] : ["off", "low", "medium", "high"],
          choosingModel ? model : effort, undefined, choosingModel ? "Model · offline synthetic choices" : "Effort · offline synthetic choices"));
        if (picked) { if (choosingModel) model = picked.level; else effort = picked.level; }
      } else terminal.writePanel("Picker unavailable", "Use an interactive terminal for the synthetic picker.", "warning");
      terminal.writePanel("Demo state · not saved", `Model: ${model}\nEffort: ${effort}\nThese choices exist only in this process.`);
    } else if (command === "/approve") {
      terminal.writePanel("Prepare a synthetic approval", "Type a draft now. In two seconds a separate approval editor will open; the draft cannot answer it.", "warning");
      await Bun.sleep(2000);
      if (cancelled || !running) continue;
      const approved = await terminal.confirm(
        "Synthetic operation: display a local demo result\nTarget: memory only\nNo external call, file write or permission change will occur.\n",
        "Allow this exact synthetic operation? Type yes: ");
      terminal.writePanel(approved ? "Demo approval granted" : "Demo approval denied",
        "No operation was executed. The original draft and cursor are restored.", approved ? "accent" : "warning");
    } else if (command === "/error") {
      terminal.write(formatToolActivity({ type: "tool_end", toolName: "read", isError: true,
        input: { path: "/synthetic/workspace/資料/café/missing-example.ts" },
        output: { text: "Synthetic error: example file unavailable. No real file was opened.", truncated: false } }, 120) + "\n");
    } else if (command === "/status") {
      terminal.writePanel("Demo status", `Model: ${model} (synthetic)\nEffort: ${effort}\nContext: 28% (synthetic estimate)\nCost: unavailable\nVerification: unavailable; no checks ran\nStorage: nothing saved`);
    } else if (command.startsWith("/")) {
      terminal.writePanel("Choose a demo action", "/model · /effort · /approve · /error · /status · /exit\nSend any other text to see streaming output. Other palette commands belong to real Casper.");
    } else {
      terminal.writePanel("Synthetic activity", "The following events are display fixtures, not real tool executions.", "muted");
      const target = { path: "/synthetic/workspace/資料/café/a-long-directory-name-for-resize-checking/example.ts" };
      terminal.write(formatToolActivity({ type: "tool_start", toolName: "read", input: target }) + "\n");
      await Bun.sleep(700);
      if (cancelled || !running) continue;
      terminal.write(formatToolActivity({ type: "tool_end", toolName: "read", input: target, isError: false }, 700) + "\n");
      for (const chunk of [
        "## Demo result\n\nThis is **synthetic output**, not a verified code change. ",
        "The same assistant panel grows as text arrives.\n\n",
        "1. Keep typing while this streams.\n2. Resize to a narrow terminal.\n\n",
        "```ts\nconst message = \"café / 資料 / synthetic\";\n",
        "console.log(message); // shown only; never executed\n```\n\n",
        "| Evidence | State |\n| --- | --- |\n| Real tools | Not run |\n| Checks | Unavailable |\n\n",
        "Demo complete. No real tools ran. [Example link](https://example.com/synthetic-demo) is shown as text.\n",
      ]) {
        if (cancelled || !running) break;
        terminal.assistant(chunk);
        await Bun.sleep(500);
      }
      terminal.endAssistant();
      if (!cancelled && running) terminal.writePanel("Verification unavailable", "No checks ran. This demo shows presentation and input behavior only.", "warning");
    }
  }
} finally { terminal.close(); }
