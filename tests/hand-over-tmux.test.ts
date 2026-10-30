import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { answer, calls, cleanUpAfterEach, fixture, type Payload } from "./support/phase8-pi";
import { privateTmux } from "./support/private-tmux";

cleanUpAfterEach();
const mux = await privateTmux({ timeoutMs: 10_000 });
afterAll(async () => { await mux?.close(); });

/** The last user and tool text the model was sent. */
const lastTexts = (payload: Payload) => JSON.stringify(payload.messages.slice(-4));

test.skipIf(!mux)("real tmux: an interactive command, !cmd and 'let me run' get the terminal; the AI reads exit codes and tails; a paste is a request", async () => {
  let step = 0;
  const f = await fixture(() => {
    const now = step++;
    if (now === 0) return calls([{ name: "bash", args: { command: "passwd" } }]);
    if (now === 1) return answer("Greeted the person.");
    if (now === 2) return answer("Both of your commands are noted.");
    return answer("That was a pasted line.");
  });
  const root = path.dirname(f.project), home = path.join(root, "home"), bin = path.join(root, "bin");
  await mkdir(bin);
  // A fake passwd (a known interactive program): it reads from the terminal it was handed.
  await writeFile(path.join(bin, "passwd"), "#!/bin/sh\nprintf 'Your name: '\nread name\necho \"hello $name\"\nexit 3\n");
  await chmod(path.join(bin, "passwd"), 0o755);
  const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
  const env = { HOME: home, CASPER_AGENT_DIR: f.agent, PI_CODING_AGENT_DIR: f.agent, CASPER_OFFLINE: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", TERM: "xterm-256color",
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  const command = `env -u NO_COLOR ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${quote(process.execPath)} ${quote(path.join(import.meta.dir, "fixtures/hand-over-terminal.ts"))} ${quote(f.project)}`;
  const capture = () => mux!.run("capture-pane", "-p", "-t", "hand", "-S", "-400");
  const wait = async (match: (text: string) => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { const text = await capture(); if (match(text)) return text; await Bun.sleep(100); }
    throw new Error(`terminal never showed ${what}:\n${await capture()}`);
  };
  const type = async (text: string) => { await mux!.run("send-keys", "-t", "hand", "-l", text); await mux!.run("send-keys", "-t", "hand", "Enter"); };
  try {
    await mux!.run("new-session", "-d", "-s", "hand", "-x", "100", "-y", "50", command);
    await wait((text) => text.includes("idle"), "the idle prompt");
    // The AI's interactive command: no box (Yes to everything), a one-line note, then the program has the keyboard.
    await type("greet me");
    await wait((text) => text.includes("Your name:"), "the program's own prompt");
    expect(await capture()).toContain("[terminal] passwd has the terminal now; Casper comes back when it exits.");
    await type("Ada");
    await wait((text) => text.includes("Greeted the person."), "Casper back with the AI's answer");
    const told = lastTexts(f.payloads[1]!);
    expect(told).toContain("exited with code 3");
    expect(told).toContain("hello Ada");
    // The person's own commands: no box, the terminal, and a line saying how it ended.
    await wait((text) => text.includes("idle"), "the idle prompt again");
    await type("!printf 'own %s\\n' run; exit 4");
    await wait((text) => text.includes("exited with code 4"), "the ! command's end");
    await type("let me run printf 'words ok\\n'");
    await wait((text) => text.includes("exited with code 0"), "the plain-words command's end");
    expect(f.payloads).toHaveLength(2);
    await type("thanks");
    await wait((text) => text.includes("Both of your commands are noted."), "the next answer");
    const next = JSON.stringify(f.payloads[2]!.messages);
    expect(next).toContain("The person ran this command themselves");
    expect(next).toContain("own run");
    expect(next).toContain("words ok");
    // A pasted "let me run …" is an ordinary request: the model gets it, nothing runs.
    await wait((text) => text.split("Both of your commands are noted.")[1]?.includes("idle") ?? false, "the idle prompt after it");
    await mux!.run("set-buffer", "-b", "paste", "let me run printf 'pasted ran\\n'");
    await mux!.run("paste-buffer", "-p", "-b", "paste", "-t", "hand");
    await mux!.run("send-keys", "-t", "hand", "Enter");
    await wait((text) => text.includes("That was a pasted line."), "the pasted request's answer");
    expect(JSON.stringify(f.payloads[3]!.messages)).toContain("let me run printf");
    expect(await capture()).not.toContain("[run] printf 'pasted ran");
  } finally { await mux!.run("kill-session", "-t", "hand").catch(() => ""); }
}, 120_000);
