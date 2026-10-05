import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CasperApp } from "../../src/app";
import { askDefaults } from "../../src/tui/surface";

/**
 * An interactive Casper session on a fake terminal, answered by a script: SCENARIO_ANSWERS is a JSON list of
 * [text to wait for, keys to type]. Each answer waits for its text to appear after the previous answer's.
 * The real Pi runtime runs against whatever model HOME's agent folder names. Prints the screen at the end.
 */
const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing cwd");
const answers = JSON.parse(process.env.SCENARIO_ANSWERS ?? "[]") as Array<[string, string]>;
process.env.TERM = "xterm-256color";
delete process.env.NO_COLOR;
// The script answers a box as soon as it shows; tests/one-input-style.test.ts covers the real wait.
askDefaults.guardMs = 0;
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
let screen = "";
let from = 0;
const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 40, write(text: string) {
  screen += text;
  const next = answers[0];
  if (!next) return true;
  const plain = Bun.stripANSI(screen);
  const at = plain.indexOf(next[0], from);
  if (at >= 0) {
    answers.shift();
    from = at + next[0].length;
    // Type after the screen settles on this question, as a person would.
    setTimeout(() => input.write(next[1]), 0);
  }
  return true;
} });
const app = new CasperApp({ input, output: writer, verificationMode: "auto" });
const watchdog = setTimeout(() => { console.log("SCENARIO_SCREEN=" + JSON.stringify(Bun.stripANSI(screen).replace(/\r\n?/g, "\n"))); console.log("SCENARIO_STUCK waiting for " + JSON.stringify(answers[0])); process.exit(3); }, 60_000);
try {
  await app.runInteractive(cwd);
} finally {
  clearTimeout(watchdog);
  await app.close();
  input.destroy();
}
console.log("SCENARIO_SCREEN=" + JSON.stringify(Bun.stripANSI(screen).replace(/\r\n?/g, "\n")));
process.exit(0);
