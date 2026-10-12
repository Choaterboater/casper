import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { commandArgs, commandFileShown, fillCommand, loadUserCommands, userCommandRequest, userCommandsHelp, usableCommands } from "../src/app/user-commands";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { commandMenu } from "../src/tui/commands";
import { commandProblem } from "../src/tui/help";
import { removeTempDir } from "./support/temp-dir";

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir))); });

const ambientAgentDir = process.env.CASPER_AGENT_DIR;
afterEach(() => { if (ambientAgentDir === undefined) delete process.env.CASPER_AGENT_DIR; else process.env.CASPER_AGENT_DIR = ambientAgentDir; });

/** A home with ~/.casper/commands and Pi's ~/.casper/agent/prompts. */
async function home(files: Record<string, string>): Promise<string> {
  delete process.env.CASPER_AGENT_DIR;
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-user-commands-"));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}

const HELLO = "---\ndescription: Say hello to someone\nargument-hint: <name>\n---\nSay hello to $1, warmly. All words: $ARGUMENTS\n";

test("a command's words fill $1, $@, $ARGUMENTS, defaults and slices, as Pi fills a prompt template", () => {
  expect(commandArgs(`world "big planet" 'x y'`)).toEqual(["world", "big planet", "x y"]);
  expect(fillCommand("$1|$2|$@|$ARGUMENTS", ["a", "b c"])).toBe("a|b c|a b c|a b c");
  expect(fillCommand("${1:-none} ${3:-none} ${@:2} ${@:1:1}", ["a", "b", "c"])).toBe("a c b c a");
  expect(fillCommand("${ARGUMENTS:-nothing}", [])).toBe("nothing");
});

test("your commands come from ~/.casper/commands and Pi's prompts folder; the first folder wins a name", async () => {
  const dir = await home({
    ".casper/commands/hello.md": HELLO,
    ".casper/agent/prompts/hello.md": "Pi's hello",
    ".casper/agent/prompts/review.md": "Review the last change for bugs and say what you found.\n",
    ".casper/commands/notes.txt": "not a command",
  });
  const commands = loadUserCommands(dir);
  expect(commands.map((command) => command.name)).toEqual(["hello", "review"]);
  expect(commands[0]).toMatchObject({ description: "Say hello to someone", argumentHint: "<name>" });
  // No frontmatter: the first line is the description.
  expect(commands[1]!.description).toBe("Review the last change for bugs and say what you found.");
  expect(loadUserCommands(path.join(dir, "missing"))).toEqual([]);
  // Shown as you would type it, with / on every system.
  expect(commandFileShown(commands[0]!.file, dir)).toBe("~/.casper/commands/hello.md");
  expect(commandFileShown(commands[0]!.file, path.join(dir, "elsewhere"))).toBe(commands[0]!.file);
});

test("a description or hint is one line with no terminal controls, for the / menu and /help", async () => {
  const dir = await home({ ".casper/commands/red.md": "---\ndescription: \"two\\nlines \\e[31mred\"\nargument-hint: \"<a>\\n<b>\"\n---\nGo.\n" });
  const [command] = loadUserCommands(dir);
  expect(command).toMatchObject({ description: "two lines red", argumentHint: "<a> <b>" });
});

test("/hello world is your command's text with world in it; a Casper command is never taken over", async () => {
  const dir = await home({ ".casper/commands/hello.md": HELLO, ".casper/commands/help.md": "MINE", ".casper/commands/cost.md": "MINE" });
  const commands = loadUserCommands(dir);
  expect(userCommandRequest("/hello world", commands)?.text).toBe("Say hello to world, warmly. All words: world");
  // A built-in name or an alias stays Casper's.
  expect(userCommandRequest("/help", commands)).toBeUndefined();
  expect(userCommandRequest("/cost", commands)).toBeUndefined();
  expect(userCommandRequest("/nope", commands)).toBeUndefined();
  expect(usableCommands(commands).map((command) => command.name)).toEqual(["hello"]);
  // The / menu: yours with Casper's, once, and /help is still Casper's row.
  const menu = commandMenu("hel", usableCommands(commands));
  expect(menu.find((item) => item.value === "hello")?.description).toBe("<name> — Say hello to someone");
  expect(menu.filter((item) => item.value === "help")).toHaveLength(1);
  expect(commandMenu("help", commands).find((item) => item.value === "help")?.description).not.toContain("MINE");
  // /help: a group of their own, and a hidden one says why.
  const help = userCommandsHelp(commands);
  expect(help).toContain("Your commands");
  expect(help).toMatch(/\/hello <name> +Say hello to someone/);
  expect(help).toContain("Hidden: Casper's /help has this name; rename help.md");
  expect(userCommandsHelp([])).toBe("");
});

test("an unknown name still gets the did-you-mean; your own name is not unknown", () => {
  expect(commandProblem("/verfy typecheck")).toContain("Did you mean /verify?");
  expect(commandProblem("/hello world", (name) => name === "hello")).toBeUndefined();
  expect(commandProblem("/helo world", (name) => name === "hello")).toContain('Unknown command "/helo"');
});

class Session implements RuntimeSession {
  constructor(private readonly prompts: string[]) {}
  private readonly listeners = new Set<RuntimeEventListener>();
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    for (const listener of this.listeners) { listener({ type: "assistant_text_delta", delta: "Done." }); listener({ type: "message_end" }); }
  }
  setTools(): void {}
  async abort(): Promise<void> {}
  subscribe(listener: RuntimeEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getState() { return { cwd: "", isStreaming: false }; }
}

test("Casper sends /hello world to the model as your command's text; /help and unknown names stay local", async () => {
  const homeDir = await home({ ".casper/commands/hello.md": HELLO, ".casper/commands/help.md": "MINE_MUST_NOT_RUN" });
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-user-commands-project-"));
  tempDirs.push(root);
  const prompts: string[] = [];
  const runtime: AgentRuntime = { start: async () => new Session(prompts), dispose: async () => {} };
  let output = "";
  const app = new CasperApp({
    runtimeFactory: () => runtime,
    sessionHomeDir: homeDir,
    loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
    output: { write: (text) => { output += text; } },
  });
  try {
    await app.runOnce("/hello world", root);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Say hello to world, warmly. All words: world");
    expect(prompts[0]).not.toContain("/hello");
    expect(output).toContain("[command] /hello sends ~/.casper/commands/hello.md.");

    output = "";
    await app.runOnce("/help", root);
    expect(output).toContain("Your commands");
    expect(prompts).toHaveLength(1);
    await expect(app.runOnce("/helo world", root)).rejects.toThrow("Unknown command");
    expect(prompts).toHaveLength(1);
    // A file with nothing after its frontmatter never starts a task with no request.
    await writeFile(path.join(homeDir, ".casper/commands/blank.md"), "---\ndescription: Nothing yet\n---\n");
    await expect(app.runOnce("/blank", root)).rejects.toThrow("/blank has no text to send");
    expect(prompts).toHaveLength(1);
  } finally { await app.close(); }
});
