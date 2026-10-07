import { expect, test } from "bun:test";
import { CLI_HELP_TEXT, FULL_HELP_TEXT, HELP_TEXT, LOGIN_HELP } from "../src/tui/help";
import { CLI_OPTIONS } from "../src/cli-args";

test("help names Casper's own credential store and model routing, not Pi's", () => {
  // Built-on-Pi attribution lives in the README; runtime help describes Casper's behavior.
  for (const text of [HELP_TEXT, LOGIN_HELP, FULL_HELP_TEXT]) {
    expect(text).not.toMatch(/\bPi\b/);
    expect(text).not.toMatch(/shared (?:Pi\/Casper )?auth store/);
  }
  // Two plain lines: where to sign in, and never in chat.
  expect(LOGIN_HELP.trimEnd().split("\n")).toHaveLength(2);
  expect(LOGIN_HELP).toContain("Run casper and type /login");
  expect(LOGIN_HELP).toContain("chat");
  expect(FULL_HELP_TEXT).toContain("Children use Casper roles (explorer→fast, reviewer→review) or the startup default.");
  expect(FULL_HELP_TEXT).toContain("Learning uses the startup default");
});

test("/help all lists the model role commands and every CLI flag", () => {
  for (const entry of ["/model roles", "/model role <fast|build|reason|review> <selector|clear>", "/model @role[:effort]", "casper --licenses", "casper --help, -h",
    ...CLI_OPTIONS.map((option) => `casper ${option}`)]) {
    expect(FULL_HELP_TEXT).toContain(entry);
  }
});

test("user-facing runtime and session strings name conversations, not the engine", async () => {
  const { readFile } = await import("node:fs/promises");
  const sources = await Promise.all(["src/app/commands.ts", "src/runtime/pi.ts", "src/sessions/manager.ts"].map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
  // Error and prompt literals only; comments and identifiers may still name the engine.
  const literals = sources.flatMap((source) => source.match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? []);
  expect(literals.filter((literal) => /\bPi\b/.test(literal))).toEqual([]);
});

test("help says CLI server flags cover only the user's own definitions", async () => {
  const { FULL_HELP_TEXT } = await import("../src/tui/help");
  expect(FULL_HELP_TEXT).toContain("--mcp <name>  Authorize and connect your own (user/profile) MCP server");
  expect(FULL_HELP_TEXT).toContain("Project-defined servers need interactive /mcp or /lsp connect review");
});

test("help lists casper mcp check", () => {
  expect(CLI_HELP_TEXT).toContain("casper mcp check [repo]  Check an MCP server you built: its tests, labels and configs (no tool calls unless --live)");
  expect(FULL_HELP_TEXT).toContain("casper mcp check [repo] [--server <name>] [--live]");
  expect(FULL_HELP_TEXT).toContain("only run it on repos you trust");
});

test("help says only access_check makes a login read-only", () => {
  expect(FULL_HELP_TEXT).not.toContain("Read-only comes from the product (readOnlyHint");
  expect(FULL_HELP_TEXT).toContain("A login is read-only only when the product says so (access_check); labels only make things stricter.");
});

test("the short help's slash commands line up in one column", () => {
  const rows = HELP_TEXT.split("\n").filter((line) => /^  \/[a-z]/.test(line) && / {2,}\S/.test(line.slice(3)));
  const columns = new Set(rows.map((line) => line.search(/(?<=\S) {2,}\S/) + line.slice(line.search(/(?<=\S) {2,}\S/)).search(/\S/)));
  expect(rows.length).toBeGreaterThan(5);
  expect([...columns]).toHaveLength(1);
});

test("help lists casper <folder>, /undo, /redo, /diff n and /receipt n", () => {
  expect(HELP_TEXT).toContain("  casper [folder]        Open Casper here, or in that folder\n");
  expect(HELP_TEXT).toContain("  /diff, /undo, /redo    See the last task's changes, or put its files back");
  expect(CLI_HELP_TEXT).toContain("  casper <folder>      Open that folder");
  expect(FULL_HELP_TEXT).toContain("options go before the prompt (quote the whole request to send them as words)");
  for (const entry of ["/undo [n]", "/redo [n]", "/diff [n|list]", "/receipt <n>, /receipt list"]) expect(FULL_HELP_TEXT).toContain(entry);
});

test("/help lists setting up Casper's network server and its logins", () => {
  for (const text of [HELP_TEXT, FULL_HELP_TEXT]) expect(text).toContain("/mcp setup network");
  expect(HELP_TEXT).toContain("/mcp login ");
  expect(FULL_HELP_TEXT).toContain("/mcp login [mist|central|clearpass] [forget]");
  expect(FULL_HELP_TEXT).toContain("/allowed forget <n>");
  expect(FULL_HELP_TEXT).toContain("/mcp setup ssh [host] [command]");
});
