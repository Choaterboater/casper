import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acpCommands, acpRefusal, commandHint, LEFT_OUT } from "../src/acp/commands";
import { hider } from "../src/acp/updates";
import { COMMAND_REGISTRY, findCommand } from "../src/tui/commands";
import { withEnv } from "./support/env";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
/** A home folder with these files in ~/.casper/commands. */
function home(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "casper-acp-commands-"));
  homes.push(dir);
  mkdirSync(path.join(dir, ".casper", "commands"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, ".casper", "commands", name), text);
  return dir;
}
const same = (text: string) => text;
/** The list for `dir`, with Pi's prompt folder inside it too (never a developer's own). */
const offer = (dir: string, hide: (text: string) => string = same) =>
  withEnv({ CASPER_AGENT_DIR: path.join(dir, ".casper", "agent") }, () => acpCommands(dir, hide));

test("every Casper command is offered over ACP or is in LEFT_OUT with a reason, in the registry's order; hidden ones never show", async () => {
  const offered = (await offer(home())).map((command) => command.name);
  for (const spec of COMMAND_REGISTRY) {
    if (spec.hidden) { expect(offered).not.toContain(spec.name); continue; }
    expect(offered.includes(spec.name) !== Object.hasOwn(LEFT_OUT, spec.name)).toBe(true);
  }
  for (const [name, reason] of Object.entries(LEFT_OUT)) { expect(findCommand(name)?.name).toBe(name); expect(reason).not.toBe(""); }
  const order = COMMAND_REGISTRY.map((spec) => spec.name);
  expect(offered).toEqual([...offered].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  for (const name of ["clear", "resume", "pane", "theme", "login", "effort", "model", "permissions", "export", "suggestion", "tree"]) expect(offered).not.toContain(name);
  for (const name of ["review", "status", "mcp", "diff", "usage", "plan"]) expect(offered).toContain(name);
  // No slash, and the words are the registry's.
  expect((await offer(home())).find((command) => command.name === "status")).toEqual({ name: "status", description: findCommand("status")!.description });
});

test("a command's input hint is its argument hint, else its first four subcommands (…when there are more); none when it takes nothing", async () => {
  const offered = new Map((await offer(home())).map((command) => [command.name, command]));
  expect(offered.get("review")!.input).toEqual({ hint: "[branch|commit]" });
  expect(offered.get("status")!.input).toBeUndefined();
  expect(commandHint(findCommand("lsp")!)).toBe("connect|disconnect");
  expect(commandHint(findCommand("mcp")!)).toBe("detail|add|setup|login|…");
  expect(commandHint(findCommand("hotkeys")!)).toBeUndefined();
});

test("your own commands follow Casper's; one with a Casper command's name is left out; a file that takes words gets a hint", async () => {
  const dir = home({
    "deploy.md": "---\ndescription: Ship it\nargument-hint: <env>\n---\nDeploy to $1\n",
    "tidy.md": "Tidy the imports in $ARGUMENTS\n",
    "hello.md": "Say hello\n",
    "status.md": "Mine, never shown\n",
  });
  const offered = await offer(dir);
  const mine = offered.slice(offered.findIndex((command) => command.name === "deploy"));
  expect(mine).toEqual([
    { name: "deploy", description: "Ship it", input: { hint: "<env>" } },
    { name: "hello", description: "Say hello" },
    { name: "tidy", description: "Tidy the imports in $ARGUMENTS", input: { hint: "[words]" } },
  ]);
  expect(offered.filter((command) => command.name === "status")).toHaveLength(1);
});

test("every word in the list is hidden; a command whose name hiding would change is left out", async () => {
  const secret = "value-from-the-env-1234";
  const dir = home({ "notes.md": `---\ndescription: Uses ${secret}\n---\nx\n`, [`${secret}.md`]: "Never listed\n" });
  const offered = await offer(dir, hider(() => [secret]));
  expect(JSON.stringify(offered)).not.toContain(secret);
  expect(offered.find((command) => command.name === "notes")).toEqual({ name: "notes", description: "Uses <secret hidden>" });
});

test("over ACP a command that moves Casper to another conversation or folder is refused in plain words; bare /branch and /project run", () => {
  expect(acpRefusal("/clear")).toBe("/clear starts a new conversation inside Casper, but this app keeps its own chats: start a new chat in the app. Nothing changed.");
  expect(acpRefusal("/new")).toStartWith("/new starts a new conversation");
  for (const line of ["/resume", "/resume abc", "/continue", "/continue fix the test", "/rewind", "/rewind 2", "/switch main", "/branch try-it", "/project api", "/project new web demo"]) {
    expect(acpRefusal(line)).toEndWith("Nothing changed.");
  }
  expect(acpRefusal("/project new web demo")).toContain("make the project, then open its folder in the app");
  for (const line of ["/branch", "/project", "/status", "/review main", "/model", "/nope", "not a command"]) expect(acpRefusal(line)).toBeUndefined();
});
