import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { withLoginDisplay } from "../src/tui/login";
import { signInWays } from "../src/runtime/pi-auth";
import { loginFailureText } from "../src/app/commands";
import { withLoginSurface } from "./support/login-surface";

const items = [{ id: "codex", label: "OpenAI Codex" }, { id: "copilot", label: "GitHub Copilot" }] as const;

test("login picker accepts application arrows and batched navigation without carrying input into the next screen", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  let choice: string | undefined;
  let completed = false;
  const pending = withLoginSurface({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, io => withLoginDisplay(io, controller.signal, async display => {
    choice = await display.choose("Choose provider", items);
    const next = await display.choose("Next screen", items);
    completed = true;
    return next;
  }));
  try {
    await waitFor(() => screen.includes("Choose provider"));
    input.write("\x1bOB");
    input.write("\r1");
    await waitFor(() => screen.includes("Next screen"));
    expect(choice).toBe("copilot");
    await Bun.sleep(30);
    expect(completed).toBe(false);
    input.write("\x1b[200~1\x1b[201~");
    await Bun.sleep(30);
    expect(completed).toBe(false);
    input.write("2");
    expect(await pending).toBe("copilot");
  } finally { controller.abort(); await pending; input.destroy(); }
});

test("login picker handles fragmented and batched arrows, wraparound and encoded Enter", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  let completed = false;
  const pending = withLoginSurface({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, io => withLoginDisplay(io, controller.signal,
    display => display.choose("Choose provider", items))).then(choice => { completed = true; return choice; });
  try {
    await waitFor(() => screen.includes("Choose provider"));
    input.write("\x1b[200~\x1b[B\r\x1b[201~");
    await Bun.sleep(30);
    expect(completed).toBe(false);
    input.write("\x1b");
    input.write("[B");
    input.write("\x1b[B\x1b[B\x1b[A"); // Copilot -> Codex (wraps) -> Copilot -> Codex.
    input.write("\x1b[13u");
    await waitFor(() => completed);
    expect(await pending).toBe("codex");
  } finally { controller.abort(); await pending; input.destroy(); }
});

test("private login input never echoes or submits a secret with its pasted Enter", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  let completed = false;
  const secret = "synthetic-private-key";
  const pending = withLoginSurface({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, io => withLoginDisplay(io, controller.signal,
    display => display.privateInput("Private API key"))).then(value => { completed = true; return value; });
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

test("the sign-in list is numbered: a digit picks that row at once, and Esc cancels", async () => {
  for (const [key, expected] of [["2", "copilot"], ["1", "codex"], ["\x1b", undefined]] as const) {
    const input = new PassThrough();
    const controller = new AbortController();
    let screen = "";
    const pending = withLoginSurface({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, io => withLoginDisplay(io, controller.signal,
      display => display.choose("Sign in", items)));
    try {
      await waitFor(() => screen.includes("Sign in"));
      const visible = Bun.stripANSI(screen);
      expect(visible).toContain("1 OpenAI Codex");
      expect(visible).toContain("2 GitHub Copilot");
      expect(visible).toContain("Esc cancels");
      expect(visible).not.toContain("Cancel\n");
      input.write(key);
      expect(await pending).toBe(expected);
    } finally { controller.abort(); await pending; input.destroy(); }
  }
});

test("one sign-in list: OpenRouter first, provider and method together; /login <provider> lists only its ways", () => {
  const ways = signInWays();
  expect(ways.map(({ provider, method }) => `${provider}:${method}`).slice(0, 4))
    .toEqual(["openrouter:api_key", "openrouter:oauth", "anthropic:api_key", "anthropic:oauth"]);
  expect(ways.map(({ provider }) => provider)).toContain("openai-codex");
  expect(ways.map(({ provider }) => provider)).toContain("github-copilot");
  for (const way of ways) expect(way.label).not.toMatch(/device code|oauth|loopback/i);
  expect(signInWays("anthropic").map(({ method }) => method)).toEqual(["api_key", "oauth"]);
  expect(signInWays("github-copilot")).toHaveLength(1);
});

test("a failed sign-in says the reason Casper has, in plain words, and the next step", () => {
  const failed = (detail?: string, reason: "unavailable" | "provider" | "destination" = "provider") =>
    loginFailureText({ status: "failed", effect: "none", reason, ...(detail ? { detail } : {}) });
  expect(failed("timed out after 15 minutes")).toBe("[login] Sign-in failed: timed out after 15 minutes. Nothing was saved. Type /login to try again.\n");
  expect(failed("couldn't reach OpenRouter")).toContain("couldn't reach OpenRouter");
  expect(failed(undefined)).toBe("[login] Sign-in didn't finish. Nothing was saved. Type /login to try again.\n");
  expect(failed("CASPER_TUI_WRITE_LOG is set", "unavailable")).toBe("[login] Sign-in is off while CASPER_TUI_WRITE_LOG is set. Unset it, then type /login.\n");
  for (const text of [failed(undefined, "unavailable"), failed("x")]) {
    expect(text).not.toMatch(/loopback|eligibility|CASPER_TUI_WRITE_LOG|fallback/);
  }
  expect(failed("\"~/.casper/agent/auth.json\" is a symbolic link; replace it with a regular file", "destination"))
    .toBe("[login] Can't save the key: \"~/.casper/agent/auth.json\" is a symbolic link; replace it with a regular file. Nothing was changed.\n");
});

test("a visible text box: the suggestion shows, the first key typed replaces it, Backspace edits, a check keeps it open", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  const pending = withLoginSurface({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, io => withLoginDisplay(io, controller.signal, async display => {
    const kept = await display.textInput("Name it.", undefined, { title: "Found Ollama", initial: "ollama-myserver" });
    const typed = await display.textInput("Name it.", undefined, { title: "Found Ollama again", initial: "ollama-myserver",
      check: (text) => text === "bad" ? "That name won't do." : undefined });
    return { kept, typed };
  }));
  try {
    await waitFor(() => screen.includes("ollama-myserver") && screen.includes("Found Ollama"));
    input.write("\r");
    await waitFor(() => screen.includes("Found Ollama again"));
    for (const key of "bad") input.write(key); // The first key replaces the suggestion.
    await waitFor(() => screen.includes("> bad"));
    input.write("\r");
    await waitFor(() => screen.includes("That name won't do."));
    input.write("\x7f"); input.write("\x7f"); input.write("\x7f");
    for (const key of "den-pc") input.write(key);
    await waitFor(() => screen.includes("> den-pc"));
    input.write("\r");
    expect(await pending).toEqual({ kept: "ollama-myserver", typed: "den-pc" });
  } finally { controller.abort(); await pending.catch(() => {}); input.destroy(); }
});

test("an address tried before stays in the box to fix: typing adds to it", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  const pending = withLoginSurface({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, io => withLoginDisplay(io, controller.signal,
    display => display.textInput("Where is the server?", undefined, { title: "Add a model server", initial: "myserver", editable: true })));
  try {
    await waitFor(() => screen.includes("> myserver"));
    expect(screen).not.toContain("typing replaces it");
    for (const key of ":5000") input.write(key);
    await waitFor(() => screen.includes("> myserver:5000"));
    input.write("\r");
    expect(await pending).toBe("myserver:5000");
  } finally { controller.abort(); await pending.catch(() => {}); input.destroy(); }
});

test("Esc in a visible text box cancels it", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let screen = "";
  const pending = withLoginSurface({ input, output: { write(text) { screen += text; } }, color: false, onEOF() {} }, io => withLoginDisplay(io, controller.signal,
    display => display.textInput("Where is the server?", undefined, { title: "Add a model server" })));
  try {
    await waitFor(() => screen.includes("Where is the server?"));
    input.write("\x1b");
    expect(await pending.then(() => "answered", (error: Error) => error.message)).toBe("Input cancelled");
  } finally { controller.abort(); await pending.catch(() => {}); input.destroy(); }
});
