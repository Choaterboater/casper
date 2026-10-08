import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { codeBlocks } from "../src/app/peer-commands";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { canonicalLine, COMMANDS, findCommand } from "../src/tui/commands";
import { commandProblem, FULL_HELP_TEXT, HOTKEYS_TEXT, KEYS_HELP, unknownCommandMessage } from "../src/tui/help";
import { richApp } from "./support/app";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("the names every peer uses run here: /new is a new conversation, and the aliases run their command", () => {
  const aliases: Record<string, string> = { new: "clear", cost: "usage", config: "settings", thinking: "effort", quit: "exit" };
  for (const [alias, name] of Object.entries(aliases)) {
    expect([alias, findCommand(alias)?.name]).toEqual([alias, name]);
    expect(COMMANDS.find((command) => command.name === alias)?.description).toContain(`(same as /${name})`);
  }
  for (const name of ["theme", "hotkeys", "copy", "export", "rename", "logout"]) expect([name, findCommand(name)?.name]).toEqual([name, name]);
  expect(canonicalLine("/cost")).toBe("/usage");
  expect(canonicalLine("/thinking high --session")).toBe("/effort high --session");
  expect(canonicalLine("/new")).toBe("/clear");
  expect(canonicalLine("/usage")).toBe("/usage");
  // None of them is unknown any more, and none gets a misleading did-you-mean.
  for (const line of ["/theme", "/config", "/cost", "/thinking", "/thinking high", "/hotkeys", "/copy", "/copy 2", "/export", "/export notes.md",
    "/rename evpn lab", "/logout", "/logout openrouter", "/new", "/project new", "/project new python-cli tool"]) {
    expect([line, commandProblem(line)]).toEqual([line, undefined]);
  }
  // The old /new <name> says where new projects went; /tree still works but is out of the menu.
  expect(commandProblem("/new my-tool")).toBe("/new now starts a new conversation, like /clear. For a new project type /project new my-tool");
  expect(COMMANDS.some((command) => command.name === "tree")).toBe(false);
  expect(commandProblem("/tree")).toBeUndefined();
  expect(unknownCommandMessage("/themes")).toContain("Did you mean /theme?");
  for (const entry of ["/clear, /new", "/usage, /cost", "/settings, /config", "/theme", "/hotkeys", "/copy [n]", "/export [file]", "/rename <title>",
    "/logout [provider]", "/project new [name]", "/branch                           Show named conversations"]) expect(FULL_HELP_TEXT).toContain(entry);
  expect(FULL_HELP_TEXT).not.toContain("  /tree ");
  expect(FULL_HELP_TEXT).toContain(`Keys: ${KEYS_HELP}`);
  expect(HOTKEYS_TEXT).toContain("\n  Esc stops work.\n  Ctrl-C cancels work; idle, it clears a draft; twice on empty exits.\n  Shift+Tab cycles effort.\n");
});

test("code blocks of an answer, in order, without their fences", () => {
  expect(codeBlocks("Run this:\n```sh\nbun test\n```\nthen\n~~~\na\nb\n~~~\n")).toEqual(["bun test", "a\nb"]);
  expect(codeBlocks("no code")).toEqual([]);
});

interface Fake { names: string[]; exported: string[]; signedIn: string[]; failExport?: boolean }

function fakeRuntime(fake: Fake, cwd: string): AgentRuntime {
  const turns = [
    { role: "user" as const, text: "Casper initial classification\n\nUser request:\nadd a ping check" },
    { role: "assistant" as const, text: "Added it.\n```sh\nping -c 1 192.0.2.1\n```\nRun the tests:\n```\nbun test\n```" },
  ];
  const session: RuntimeSession = {
    setTools: () => {},
    getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
    getState: () => ({ cwd, isStreaming: false }),
    subscribe: () => () => {},
    abort: async () => {},
    prompt: async () => {},
    clearConversation: async () => {},
    recentTurns: (count) => turns.slice(-count),
    getSessionInfo: () => ({ cwd, sessionId: "abcdef0123456789", sessionFile: "unused", ...(fake.names.length ? { name: fake.names.at(-1)! } : {}) }),
    setSessionName: (name) => { fake.names.push(name); },
    forkSession: async () => { throw new Error("not in this test"); },
    switchSession: async () => { throw new Error("not in this test"); },
    exportJsonl: (file) => { if (fake.failExport) throw new Error("disk full"); fake.exported.push(file); void Bun.write(file, "{\"type\":\"session\"}\n"); },
  };
  return {
    async start() { return session; },
    async dispose() {},
    async savedSignIns() { return fake.signedIn.map((provider) => ({ provider, type: "api_key" as const })); },
    async signOut(provider) { const had = fake.signedIn.includes(provider); fake.signedIn = fake.signedIn.filter((entry) => entry !== provider); return had; },
  };
}

async function oneShot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-peer-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  await writeFile(path.join(project, "notes.txt"), "a project\n");
  const fake: Fake = { names: [], exported: [], signedIn: ["openrouter", "anthropic"] };
  const copied: string[] = [];
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => fakeRuntime(fake, project), sessionHomeDir: home, output: { write: (text) => { output += text; } },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    copyText: async (text) => { copied.push(text); },
  });
  cleanup.push(async () => { await app.close(); await removeTempDir(root); });
  // A one-shot run throws a usage error; it is returned with what was printed.
  const run = async (line: string) => {
    const from = output.length;
    const error = await app.runOnce(line, project).then(() => "", (thrown: Error) => thrown.message);
    return output.slice(from) + error;
  };
  return { app, project, fake, copied, run };
}

test("/copy, /export, /rename and /logout work on the conversation, the clipboard, a file and the saved sign-ins", async () => {
  const f = await oneShot();
  expect(await f.run("/copy")).toContain("[copy] Nothing to copy yet: no answer in this conversation.");
  await f.run("add a ping check");
  expect(await f.run("/copy")).toContain("[copy] Copied the last answer (8 lines).");
  expect(await f.run("/copy 2")).toContain("[copy] Copied code block 2 of the last answer (1 line).");
  expect(f.copied).toEqual([expect.stringContaining("Added it."), "bun test"]);
  expect(await f.run("/copy 3")).toContain("[copy] The last answer has 2 code blocks; /copy copies all of it.");
  expect(await f.run("/copy x")).toContain("Usage: /copy [n]");

  expect(await f.run("/rename EVPN lab")).toContain('[session] This conversation is now "EVPN lab"; /resume lists it by that name.');
  // It replaces the name the first request gave it.
  expect(f.fake.names).toEqual(["add a ping check", "EVPN lab"]);
  expect(await f.run("/rename")).toContain("Usage: /rename <title>");

  expect(await f.run("/export")).toMatch(/\[export\] Saved 2 messages to .*casper-conversation-abcdef01\.md\./);
  const markdown = await readFile(path.join(f.project, "casper-conversation-abcdef01.md"), "utf8");
  expect(markdown).toStartWith("# EVPN lab\n\n## You\n\nadd a ping check\n\n## Casper\n\nAdded it.");
  expect(markdown).not.toContain("Casper initial classification");
  expect(await f.run("/export")).toContain("is already there; nothing was changed. Give another name: /export <file>");
  expect(await f.run("/export all.jsonl")).toContain("[export] Saved every message to");
  expect(f.fake.exported).toEqual([path.join(f.project, "all.jsonl")]);
  // A .jsonl that fails leaves no empty file behind: the same name works next time.
  f.fake.failExport = true;
  expect(await f.run("/export broken.jsonl")).toContain("[export] Not saved: disk full.");
  expect(await Bun.file(path.join(f.project, "broken.jsonl")).exists()).toBe(false);
  f.fake.failExport = false;

  expect(await f.run("/logout")).toMatch(/Sign-ins Casper saved:\n  openrouter +API key\n  anthropic +API key\nType \/logout <provider> to remove one\./);
  expect(await f.run("/logout openrouter")).toContain("[logout] Removed the saved sign-in for openrouter. Environment variables are unchanged; /login signs in again.");
  expect(await f.run("/logout openrouter")).toContain('[logout] No saved sign-in for "openrouter". Saved: anthropic.');
  expect(f.fake.signedIn).toEqual(["anthropic"]);

  expect(await f.run("/hotkeys")).toContain(HOTKEYS_TEXT);
  expect(await f.run("/cost")).toContain("Cost: ");
  expect(await f.run("/theme")).toContain("Theme: default\nRun /theme in a Casper session to change it by number.");
  expect(await f.run("/config")).toContain("Settings (");
  expect(await f.run("/new")).toContain("[session] New conversation for this run only");
  expect(await f.run("/project new --list")).toContain("python-cli");
  // The old spelling never starts the new-project questions.
  const moved = await f.run("/new my-tool");
  expect(moved).toContain("For a new project type /project new my-tool");
});

test("on the screen: /new starts a new conversation, never the new-project questions; /theme opens the Theme question", async () => {
  const app = await richApp((project) => fakeRuntime({ names: [], exported: [], signedIn: [] }, project));
  try {
    await app.until((text) => text.includes("idle"));
    let from = app.screen().length;
    app.input.write("/new my-tool\r");
    await app.until((text) => text.slice(from).includes("For a new project type /project new my-tool"));
    from = app.screen().length;
    app.input.write("/new\r");
    await app.until((text) => text.slice(from).includes("[session] New conversation."));
    expect(app.screen().slice(from)).not.toContain("What are you building?");
    from = app.screen().length;
    app.input.write("/theme\r");
    await app.until((text) => text.slice(from).includes("Theme: default. It changes the colours only"));
    expect(app.screen().slice(from)).not.toContain("Pick one to change:");
    app.input.write("\x1b");
  } finally { await app.close(); }
}, 30_000);
