import { expect } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { answer, calls, cleanUpAfterEach, fixture } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

cleanUpAfterEach();

/** The sudo password typed in Casper's box, end to end with the real Pi runtime: it reaches sudo (a fake on the PATH that
 * asks through SUDO_ASKPASS, as the real one does with -A) and nothing else: not the model, the screen, the --json
 * events, the saved conversation, Casper's logs or either /export. Made-up password; the files hold it only reversed. */
const PASSWORD = "Sudo-Box-Test-Password-7";
const REVERSED = [...PASSWORD].reverse().join("");

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) found.push(path.join(entry.parentPath, entry.name));
  return found;
}

posixOnly("a sudo password typed in the box never reaches the model, the screen, events, the session file, logs or an export", async () => {
  let step = 0;
  const f = await fixture(() => {
    const now = step++;
    if (now === 0) return calls([{ name: "bash", args: { command: "sudo printf 'root ok\\n'" } }]);
    return answer("Done: the command ran as root.");
  });
  // A short home: the askpass socket's path must stay under the Unix limit (macOS's temp folder is long).
  const home = await realpath(await mkdtemp("/tmp/cs-"));
  try {
    // The fixture's model settings, in that home.
    await cp(path.join(path.dirname(f.project), "home", ".casper"), path.join(home, ".casper"), { recursive: true });
    const bin = path.join(f.agent, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "sudo"), [
      "#!/bin/sh",
      "[ \"$1\" = -A ] || { echo 'sudo: a terminal is required to read the password' >&2; exit 1; }",
      "shift",
      "pw=$(\"$SUDO_ASKPASS\" '[sudo] password for casper: ') || { echo 'sudo: no password was provided' >&2; exit 1; }",
      `[ "$(printf %s "$pw" | rev)" = '${REVERSED}' ] || { echo 'Sorry, try again.' >&2; exit 1; }`,
      "echo \"sudo saw: $pw\"",
      "exec \"$@\"",
      "",
    ].join("\n"));
    await chmod(path.join(bin, "sudo"), 0o755);
    const app = path.join(import.meta.dir, "../src/app.ts");
    const harness = path.join(f.agent, "sudo-box.ts");
    await Bun.write(harness, `import { PassThrough } from "node:stream";
import { CasperApp } from ${JSON.stringify(app)};
process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH;
const input = Object.assign(new PassThrough(), { isTTY: true });
const lines = ["restart the service as root", "/export", "/export all.jsonl"];
let output = "", since = "";
const events = [];
const boxes = [];
const casper = new CasperApp({
  input, sessionHomeDir: process.env.HOME, onEvent: (event) => events.push(event),
  secretInput: async (box) => { boxes.push(box); return ${JSON.stringify(REVERSED)}.split("").reverse().join(""); },
  output: { write(text) {
    output += text; since += text;
    if (text === "> ") queueMicrotask(() => input.write((lines.shift() ?? "/exit") + "\\n"));
    // Casper's sudo question: 2 Yes, this once. Any other numbered question: 1.
    if (/Type [\\d, ]*\\d or \\d: $/.test(text)) { const pick = since.includes("sudo on this computer asks") ? "2" : "1"; since = ""; queueMicrotask(() => input.write(pick + "\\n")); }
  } },
});
casper.stopAsking = true;
try { await casper.runInteractive(process.cwd()); } finally { await casper.close(); }
console.log("SUDO_BOX=" + JSON.stringify({ output, events, boxes }));
`);
    const run = await f.run([harness], { HOME: home });
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    const result: { output: string; events: unknown[]; boxes: Array<{ title: string; hint: string }> } = JSON.parse(run.stdout.split("SUDO_BOX=")[1]!);
    // One numbered question, then one box, in Casper's words.
    expect(result.output).toContain("sudo on this computer asks for your password. Type it in Casper's hidden box? The AI never sees it.\n  1 No");
    expect(result.output).toMatch(/sudo on this computer asks for your password\..*→ Yes, this once/);
    expect(result.boxes.map((box) => box.title)).toEqual(["Enter sudo password"]);
    expect(result.boxes[0]!.hint).toBe("It goes to sudo only. The AI never sees it, and Casper never saves it.");
    // It reached sudo: the command ran, and the AI read that sudo saw something it can't read.
    const sent = JSON.stringify(f.payloads);
    expect(sent).toContain("root ok");
    expect(sent).toContain("sudo saw: <secret hidden>");
    // Nowhere else: what the model was sent, the screen, the events, and every file Casper and Pi wrote.
    expect(sent).not.toContain(PASSWORD);
    expect(result.output).not.toContain(PASSWORD);
    expect(JSON.stringify(result.events)).not.toContain(PASSWORD);
    expect(result.output).toContain("[export] Saved");
    const root = path.dirname(f.project);
    const files = [...await filesUnder(root), ...await filesUnder(home)];
    expect(files).toContain(path.join(f.project, "all.jsonl"));
    expect(await readFile(path.join(f.project, "all.jsonl"), "utf8")).toContain("sudo saw: <secret hidden>");
    expect(files.some((file) => file.endsWith(".jsonl") && file.startsWith(f.agent))).toBe(true);
    const holding = [];
    for (const file of files) if ((await readFile(file)).includes(PASSWORD)) holding.push(file);
    expect(holding).toEqual([]);
  } finally { await removeTempDir(home); }
}, childTestLimit());
