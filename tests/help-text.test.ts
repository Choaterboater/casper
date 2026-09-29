import { expect, test } from "bun:test";
import { FULL_HELP_TEXT, HELP_TEXT, LOGIN_HELP } from "../src/tui/help";
import { CLI_OPTIONS } from "../src/cli-args";

test("help names Casper's own credential store and model routing, not Pi's", () => {
  // Built-on-Pi attribution lives in the README; runtime help describes Casper's behavior.
  for (const text of [HELP_TEXT, LOGIN_HELP, FULL_HELP_TEXT]) {
    expect(text).not.toMatch(/\bPi\b/);
    expect(text).not.toMatch(/shared (?:Pi\/Casper )?auth store/);
  }
  expect(LOGIN_HELP).toContain("Casper's credential store (~/.casper/agent)");
  expect(LOGIN_HELP).toContain("Claude and OpenRouter offer API key or browser sign-in");
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
  expect(HELP_TEXT).toContain("casper mcp check [repo]  Check an MCP server you built: its tests, labels and configs (no tool calls unless --live)");
  expect(FULL_HELP_TEXT).toContain("casper mcp check [repo] [--server <name>] [--live]");
  expect(FULL_HELP_TEXT).toContain("only run it on repos you trust");
});
