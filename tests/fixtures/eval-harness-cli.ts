// Scripted external CLI: exercise argv, environment and wire protocols without credentials.
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1);
const casper = args.includes("--json");
writeFileSync("observed.json", JSON.stringify({ args, home: process.env.HOME,
  casperDir: process.env.CASPER_AGENT_DIR, piDir: process.env.PI_CODING_AGENT_DIR,
  inheritedSecret: process.env.EVAL_HARNESS_SECRET ?? null,
  casperTelemetry: process.env.CASPER_TELEMETRY ?? null, piTelemetry: process.env.PI_TELEMETRY ?? null }));
if (prompt === "inspect models") {
  const agent = process.env.CASPER_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR!;
  writeFileSync("models.json", readFileSync(`${agent}/models.json`, "utf8"));
}
if (prompt === "inspect seed") {
  const agent = process.env.CASPER_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR!;
  writeFileSync("seed.json", JSON.stringify({
    providers: Object.keys(JSON.parse(readFileSync(`${agent}/auth.json`, "utf8"))),
    catalog: readFileSync(`${agent}/models-store.json`, "utf8"),
  }));
}
const emit = (event: unknown) => console.log(JSON.stringify(event));
if (prompt === "hang") { setInterval(() => {}, 1000); }
else if (casper && prompt === "checks fail") {
  // Casper's human output goes to stderr in --json mode; its own failed verdict exits 1.
  process.stderr.write("CASPER banner\n✗ Verified by Casper: test failed\n");
  emit({ v: 1, type: "assistant_message", text: "Implemented." });
  emit({ v: 1, type: "receipt", execution: "completed", outcome: "failed", exitCode: 1 });
  process.exitCode = 1;
}
else if (casper) {
  emit({ v: 1, type: "assistant_message", text: "Scripted answer." });
  emit({ v: 1, type: "receipt", execution: "completed", outcome: "unverified", exitCode: 0 });
} else {
  emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Scripted answer." }] } });
  emit({ type: "agent_end" });
}
