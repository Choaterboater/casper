// Scripted benchmark CLI: "solves" a task by copying a reference src/ into the workspace, then
// reports two model turns in the Casper (--json) or Pi (--mode json) protocol. No credentials.
import { cpSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const reference = args[0]!;
// Only an actual run (harness flags, then `--` and the prompt, or Casper's `-` with the prompt on stdin)
// touches the workspace; `--version` does not.
if (!args.includes("--") && args.at(-1) !== "-") { console.log("scripted-harness 1.0.0"); process.exit(0); }
rmSync("src", { recursive: true, force: true });
cpSync(reference, "src", { recursive: true });
const answer = "Implemented the change. All visible tests pass.";
const emit = (event: unknown) => console.log(JSON.stringify(event));
if (args.includes("--json")) {
  emit({ v: 1, type: "phase", phase: "smoke", state: "start" });
  emit({ v: 1, type: "phase", phase: "smoke", state: "end" });
  emit({ v: 1, type: "assistant_message", text: answer });
  const smoke = { status: "pass", checks: [{ id: "smoke-1", name: "parses", service: "api", source: "model", request: { method: "GET", path: "/" }, baseline: "fail", status: "pass", evidence: true }] };
  emit({ v: 1, type: "receipt", execution: "completed", outcome: "verified", exitCode: 0, usage: { turns: 2, tokens: 300, estimatedCost: 0.002 }, smoke });
} else {
  const usage = { totalTokens: 150, cost: { total: 0.001 } };
  emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage } });
  emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }], usage } });
  emit({ type: "agent_end" });
}
