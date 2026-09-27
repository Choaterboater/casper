// Scripted benchmark CLI for the in-run stopper, in Casper's --json protocol. The first run to start leaves a wrong
// change (plus an installed file under node_modules) and a verified receipt at once; every later run records its pid
// in <state>/hung-<pid> and hangs until it is killed.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const state = args[0]!;
if (args.at(-1) !== "-") { console.log("scripted-stop 1.0.0"); process.exit(0); }
mkdirSync(state, { recursive: true });
let first = true;
try { mkdirSync(path.join(state, "first")); } catch { first = false; }
if (!first) {
  writeFileSync(path.join(state, `hung-${process.pid}`), "");
  setInterval(() => {}, 1000);
} else {
  writeFileSync("src/stopper-note.ts", "export const note = 1;\n");
  mkdirSync("node_modules/installed", { recursive: true });
  writeFileSync("node_modules/installed/index.js", "");
  const emit = (event: unknown) => console.log(JSON.stringify(event));
  emit({ v: 1, type: "assistant_message", text: "Implemented the change." });
  emit({ v: 1, type: "receipt", execution: "completed", outcome: "verified", exitCode: 0, usage: { turns: 1, tokens: 100, estimatedCost: 0.001 } });
}
