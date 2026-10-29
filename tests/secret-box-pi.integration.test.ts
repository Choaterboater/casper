import { expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { answer, calls, cleanUpAfterEach, fixture } from "./support/phase8-pi";
import { childTestLimit } from "./support/limits";

cleanUpAfterEach();

/** The value typed in casper_secret's hidden box, end to end with the real Pi runtime: it reaches the .env file and the
 * one command it was set for, and nothing else: not the model, the screen, the --json events, the saved conversation,
 * Casper's logs or either /export. */
const VALUE = "eyJhIjoiU0VDUkVULUJPWC1URVNULVZBTFVFIn0x";

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) found.push(path.join(entry.parentPath, entry.name));
  return found;
}

test("a secret typed in the box never reaches the model, the screen, events, the session file, logs or an export", async () => {
  let step = 0;
  const f = await fixture(() => {
    const now = step++;
    if (now === 0) return calls([{ name: "casper_secret", args: { name: "TUNNEL_TOKEN", why: "cloudflared needs it", saveTo: ".env" } }]);
    if (now === 1) return calls([{ name: "casper_secret", args: { name: "TUNNEL_TOKEN", why: "for the next command" } }]);
    if (now === 2) return calls([{ name: "bash", args: { command: "printf 'got %s\\n' \"$TUNNEL_TOKEN\"" } }]);
    if (now === 3) return calls([{ name: "bash", args: { command: "printf 'later %s\\n' \"${TUNNEL_TOKEN:-unset}\"" } }]);
    return answer("Done: the token is in .env.");
  });
  const app = path.join(import.meta.dir, "../src/app.ts");
  const harness = path.join(f.agent, "secret-box.ts");
  await Bun.write(harness, `import { PassThrough } from "node:stream";
import { CasperApp } from ${JSON.stringify(app)};
const input = Object.assign(new PassThrough(), { isTTY: true });
const lines = ["set up the cloudflare tunnel, prompt me for the token to hide", "/export", "/export all.jsonl"];
let output = "";
const events = [];
const boxes = [];
const casper = new CasperApp({
  input, sessionHomeDir: process.env.HOME, onEvent: (event) => events.push(event),
  // Written backwards, so this file doesn't hold it either.
  secretInput: async (box) => { boxes.push(box); return ${JSON.stringify([...VALUE].reverse().join(""))}.split("").reverse().join(""); },
  output: { write(text) {
    output += text;
    if (text === "> ") queueMicrotask(() => input.write((lines.shift() ?? "/exit") + "\\n"));
    if (/Type [\\d, ]*\\d or \\d: $/.test(text)) queueMicrotask(() => input.write("1\\n"));
  } },
});
casper.stopAsking = true;
try { await casper.runInteractive(process.cwd()); } finally { await casper.close(); }
console.log("SECRET_BOX=" + JSON.stringify({ output, events, boxes }));
`);
  const run = await f.run([harness]);
  expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
  const result: { output: string; events: unknown[]; boxes: Array<{ title: string; hint: string }> } = JSON.parse(run.stdout.split("SECRET_BOX=")[1]!);
  // The person saw two boxes that said what was asked and where it goes.
  expect(result.boxes.map((box) => box.title)).toEqual(["The AI asks for TUNNEL_TOKEN", "The AI asks for TUNNEL_TOKEN"]);
  expect(result.boxes[0]!.hint).toContain("It goes to the file .env");
  expect(result.boxes[1]!.hint).toContain("It goes to the AI's next command only, as $TUNNEL_TOKEN");
  // It went where it was meant to: the file (mode 600), and the next command only.
  expect(await readFile(path.join(f.project, ".env"), "utf8")).toBe(`TUNNEL_TOKEN=${VALUE}\n`);
  if (process.platform !== "win32") expect((await stat(path.join(f.project, ".env"))).mode & 0o777).toBe(0o600);
  const sent = JSON.stringify(f.payloads);
  expect(sent).toContain("Saved TUNNEL_TOKEN to .env");
  expect(sent).toContain("got <secret hidden>");
  expect(sent).toContain("later unset");
  // Nowhere else: what the model was sent, the screen, the events, and every file Casper and Pi wrote.
  expect(sent).not.toContain(VALUE);
  expect(result.output).not.toContain(VALUE);
  expect(JSON.stringify(result.events)).not.toContain(VALUE);
  expect(result.output).toContain("[export] Saved");
  const root = path.dirname(f.project);
  const files = await filesUnder(root);
  // Both exports and the saved conversation are among the files read.
  expect(files.some((file) => file.includes(`${path.sep}exports${path.sep}`) && file.endsWith(".md"))).toBe(true);
  expect(files).toContain(path.join(f.project, "all.jsonl"));
  expect((await readFile(path.join(f.project, "all.jsonl"), "utf8"))).toContain("got <secret hidden>");
  expect(files.some((file) => file.endsWith(".jsonl") && file.startsWith(f.agent))).toBe(true);
  const holding = [];
  for (const file of files) if ((await readFile(file)).includes(VALUE)) holding.push(path.relative(root, file));
  expect(holding).toEqual([path.join("project", ".env")]);
}, childTestLimit());
