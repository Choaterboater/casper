// Synthetic terminal only: no model, shell command, device, sign-in or user state.
import { InteractiveTerminal } from "../../src/tui/terminal";
import { shellQuestion } from "../../src/app/sandbox";
import { SHELL_COMMAND_CHOICES } from "../../src/app/safe-choices";
import { formatToolActivity } from "../../src/tui/format";
import { useTheme } from "../../src/tui/theme";
useTheme(process.argv.includes("--high-contrast") ? "high-contrast" : "default");
const terminal = new InteractiveTerminal(process.stdin, process.stdout, () => terminal.close(), () => terminal.close());
terminal.setStatus("fixture │ demo/model │ idle"); terminal.start();
terminal.assistant("Checking the choice box."); terminal.endAssistant();
const failure = "(fail) validates input\nerror: Expected true\n" + Array.from({ length: 129 }, (_, i) => `(pass) case ${i}`).join("\n") + "\n129 pass\n1 fail";
terminal.writeFold({ parts: [], lines: [], edits: [], editLines: 12, failures: [{
  title: formatToolActivity({ type: "tool_end", toolName: "bash", input: { command: "bun test" }, isError: true, output: { text: failure, truncated: false } }), output: failure,
}] });
terminal.setWork({ rows: ["✓ read · example.ts", "– read · guess.ts — path not found"], status: "Running tests (11 files)" });
terminal.updateCrew({ kind: "start", run: { id: 1, role: "builder", label: "Builder 1", goal: "Polish the choice box", startedAt: Date.now(), spent: { tokens: 12000, estimatedCost: 0 } } } as never);
const answer = await terminal.pick(shellQuestion("custom-tool --check\nprintf first\nprintf second", "Earlier context. Check the result."), [...SHELL_COMMAND_CHOICES]);
terminal.setWork(undefined);
terminal.write(`Fixture answer: ${answer ?? "skipped"}\n`);
await terminal.readCommand();
terminal.close();
