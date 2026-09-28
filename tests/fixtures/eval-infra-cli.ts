// Scripted benchmark CLI for infrastructure failures: while `failures` (argv) runs remain, it fails
// as Casper did on a rate-limited host (four retried 429s, no tool call, a failed receipt, exit 1);
// after that it solves the task like eval-benchmark-cli.ts. A counter file outside the workspace
// and home carries the count across runs. No credentials.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const [reference, counter, failures, ...args] = process.argv.slice(2) as [string, string, string, ...string[]];
if (!args.includes("--") && args.at(-1) !== "-") { console.log("scripted-infra 1.0.0"); process.exit(0); }
const runs = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(runs + 1));
const emit = (event: unknown) => console.log(JSON.stringify(event));
if (runs < Number(failures)) {
  const limited = '429: {"message":"Provider returned error","code":429,"metadata":{"provider_name":"Together","limit_source":"upstream_provider_shared_pool"}}';
  // Casper's human output echoes the prompt to stderr, which mentions timeouts: never a provider error.
  const prompt = args.at(-1) === "-" ? await new Response(Bun.stdin.stream()).text() : args.at(-1);
  process.stderr.write(`CASPER banner\n> ${prompt}\n[error] ${limited}\n✗ Failed — the model run failed; changes already made are kept\n`);
  emit({ v: 1, type: "session_start", session: `infra-${runs}` });
  for (let attempt = 0; attempt < 4; attempt++) emit({ v: 1, type: "error", message: limited });
  emit({ v: 1, type: "receipt", execution: "failed", outcome: "failed", exitCode: 1, usage: { turns: 4, tokens: 0, estimatedCost: 0 } });
  process.exitCode = 1;
} else {
  rmSync("src", { recursive: true, force: true });
  cpSync(reference, "src", { recursive: true });
  emit({ v: 1, type: "tool_start", tool: "write", id: "w1" });
  emit({ v: 1, type: "tool_end", tool: "write", id: "w1", ms: 5 });
  emit({ v: 1, type: "assistant_message", text: "Implemented the change. All visible tests pass." });
  emit({ v: 1, type: "receipt", execution: "completed", outcome: "verified", exitCode: 0, usage: { turns: 2, tokens: 300, estimatedCost: 0.002 } });
}
