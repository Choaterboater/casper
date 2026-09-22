import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { withLoginDisplay } from "../src/tui/login";

const items = [{ id: "codex", label: "OpenAI Codex" }, { id: "copilot", label: "GitHub Copilot" }] as const;

test("login picker accepts application arrows and batched navigation without carrying input into consent", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  let choice: string | undefined;
  let completed = false;
  const pending = withLoginDisplay({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, controller.signal, async display => {
    choice = await display.choose("Choose provider", items);
    const consent = await display.consent("/synthetic/auth.json", choice ?? "none", "a device code", "Synthetic provider.");
    completed = true;
    return consent;
  });
  try {
    await waitFor(() => screen.includes("Choose provider"));
    input.write("\x1bOB");
    input.write("\rY");
    await waitFor(() => screen.includes("Press Y"));
    expect(choice).toBe("copilot");
    expect(completed).toBe(false);
    input.write("\x1b[200~Y\x1b[201~");
    input.write("YES");
    await Bun.sleep(30);
    expect(completed).toBe(false);
    input.write("Y");
    expect(await pending).toBe(true);
  } finally { controller.abort(); await pending; input.destroy(); }
});

test("login picker handles fragmented and batched arrows, wraparound, encoded Enter and cancellation", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  let completed = false;
  const pending = withLoginDisplay({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, controller.signal,
    display => display.choose("Choose provider", items)).then(choice => { completed = true; return choice; });
  try {
    await waitFor(() => screen.includes("Choose provider"));
    input.write("\x1b[200~\x1b[B\r\x1b[201~");
    await Bun.sleep(30);
    expect(completed).toBe(false);
    input.write("\x1b");
    input.write("[B");
    input.write("\x1b[B\x1b[B\x1b[A"); // Copilot -> Cancel -> Codex -> Cancel.
    input.write("\x1b[13u");
    await waitFor(() => completed);
    expect(await pending).toBeUndefined();
  } finally { controller.abort(); await pending; input.destroy(); }
});

test("private login input never echoes or submits a secret with its pasted Enter", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  let completed = false;
  const secret = "synthetic-private-key";
  const pending = withLoginDisplay({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, controller.signal,
    display => display.privateInput("Private API key")).then(value => { completed = true; return value; });
  try {
    await waitFor(() => screen.includes("Private API key"));
    input.write(`\x1b[200~${secret}\x1b[201~\r`);
    await Bun.sleep(30);
    expect(completed).toBe(false);
    expect(screen).not.toContain(secret);
    input.write("\r");
    expect(await pending).toBe(secret);
    expect(screen).not.toContain(secret);
  } finally { controller.abort(); await pending.catch(() => {}); input.destroy(); }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Login did not reach the expected interaction state");
    await Bun.sleep(5);
  }
}
