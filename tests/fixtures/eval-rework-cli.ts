// Scripted CLI for benchmark follow-ups: the first attempt changes nothing and claims done; a
// follow-up that carries the grader's failure report "fixes" the task by copying a reference src/.
// It reports its conversation id as the real CLIs do, and refuses Pi's --session-id + --continue.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const [reference, mode, ...args] = process.argv.slice(2) as [string, "resumes" | "forgets", ...string[]];
if (!args.includes("--") && args.at(-1) !== "-") { console.log("scripted-rework 1.0.0"); process.exit(0); }
// Casper's harness passes `-` and the prompt on stdin.
const prompt = args.at(-1) === "-" ? await new Response(Bun.stdin.stream()).text() : args.at(-1)!;
const casper = args.includes("--json");
const emit = (event: unknown) => console.log(JSON.stringify(event));
const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (!casper && flag("--session-id") && args.includes("--continue")) {
  process.stderr.write("Error: --session-id cannot be combined with --continue\n");
  process.exit(1);
}
// Casper resumes its latest conversation in the home with --continue; Pi resumes by id.
const saved = path.join(process.env.HOME!, ".scripted-session");
const session = mode === "forgets" ? randomUUID()
  : casper ? (args.includes("--continue") && existsSync(saved) ? readFileSync(saved, "utf8") : randomUUID())
  : flag("--session-id") ?? randomUUID();
writeFileSync(saved, session);
const followUp = prompt.startsWith("Continue the task.");
if (followUp && prompt.includes("\nFailure report:\n")) {
  rmSync("src", { recursive: true, force: true });
  cpSync(reference, "src", { recursive: true });
}
const answer = !followUp ? "Implemented the change." : prompt.includes("\nFailure report:\n") ? "Fixed the failing checks." : "Malformed follow-up prompt.";
if (casper) {
  emit({ v: 1, type: "session_start", session });
  emit({ v: 1, type: "assistant_message", text: answer });
  emit({ v: 1, type: "receipt", execution: "completed", outcome: "verified", exitCode: 0, usage: { turns: 2, tokens: 300, estimatedCost: 0.002 } });
} else {
  const usage = { totalTokens: 150, cost: { total: 0.001 } };
  emit({ type: "session", version: 3, id: session });
  emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage } });
  emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }], usage } });
  emit({ type: "agent_end" });
}
