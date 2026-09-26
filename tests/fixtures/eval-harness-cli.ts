// Scripted external CLI: exercise argv, environment and wire protocols without credentials.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1);
const casper = args.includes("--json");
// OMP keeps its agent directory under ~/.omp, its models in models.yml and its credentials in agent.db.
const agent = process.env.CASPER_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR!;
const omp = agent?.endsWith(".omp/agent");
writeFileSync("observed.json", JSON.stringify({ args, home: process.env.HOME,
  casperDir: process.env.CASPER_AGENT_DIR, piDir: process.env.PI_CODING_AGENT_DIR,
  inheritedSecret: process.env.EVAL_HARNESS_SECRET ?? null,
  casperTelemetry: process.env.CASPER_TELEMETRY ?? null, piTelemetry: process.env.PI_TELEMETRY ?? null }));
if (prompt === "inspect models") {
  writeFileSync("models.json", readFileSync(`${agent}/${omp ? "models.yml" : "models.json"}`, "utf8"));
}
if (prompt === "inspect seed") {
  if (omp) {
    const db = new Database(`${agent}/agent.db`, { readonly: true });
    writeFileSync("seed.json", JSON.stringify({
      credentials: db.query("SELECT provider, credential_type, data, disabled_cause FROM auth_credentials").all(),
      schemaVersion: (db.query("SELECT version FROM auth_schema_version WHERE id = 1").get() as { version: number }).version,
      catalog: existsSync(`${agent}/models-store.json`),
    }));
    db.close();
  } else {
    writeFileSync("seed.json", JSON.stringify({
      providers: Object.keys(JSON.parse(readFileSync(`${agent}/auth.json`, "utf8"))),
      catalog: readFileSync(`${agent}/models-store.json`, "utf8"),
    }));
  }
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
