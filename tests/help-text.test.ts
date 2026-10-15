import { expect, test } from "bun:test";
import { CLI_HELP_TEXT, FULL_HELP_TEXT, HELP_TEXT, HOTKEYS_TEXT, LOGIN_HELP } from "../src/tui/help";
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

test("hotkeys and full help distinguish crew details from the always-available raw toggle", () => {
  for (const text of [HOTKEYS_TEXT, FULL_HELP_TEXT]) {
    expect(text).toContain("Ctrl+O opens or closes crew details while helpers are shown");
    expect(text).toContain("Alt+O always toggles raw steps");
  }
});

test("/help all lists the model role commands and every CLI flag", () => {
  for (const entry of ["/model roles", "/model role <fast|build|reason|review> <selector|clear>", "/model @role[:effort]", "casper --licenses", "casper --help, -h"]) {
    expect(FULL_HELP_TEXT).toContain(entry);
  }
  // Aliases can share a usage row (for example, -p and --print).
  const usageRows = CLI_HELP_TEXT.split("\n").filter((line) => line.trimStart().startsWith("casper "));
  for (const option of CLI_OPTIONS) {
    expect(usageRows.some((row) => row.split(/[\s,]+/).includes(option)), option).toBe(true);
  }
});

test("short, CLI and full help distinguish a session's first request from print mode", () => {
  for (const text of [HELP_TEXT, CLI_HELP_TEXT, FULL_HELP_TEXT]) {
    expect(text).toContain('casper "first request"  Open a session and start this request');
    expect(text).toContain('casper -p "request"');
    expect(text).toContain("Run one request and exit");
    expect(text).toContain("--print");
    expect(text).not.toContain("casper <prompt>      Run one prompt and exit");
  }
  expect(CLI_HELP_TEXT).toContain("casper               Start an interactive session");
  expect(CLI_OPTIONS).toContain("-p");
  expect(CLI_OPTIONS).toContain("--print");
});

test("CLI and full help explain every fallback to once semantics", () => {
  for (const text of [CLI_HELP_TEXT, FULL_HELP_TEXT]) {
    const fallback = text.split("\n").find((line) => line.startsWith("With an initial request,"));
    expect(fallback).toContain("runs once and exits instead");
    for (const reason of ["either stdin or stdout is not a TTY", "CI is set", "--json", "a lone - (prompt from stdin)", "--require-verification", "--max-turns"]) {
      expect(fallback).toContain(reason);
    }
    expect(fallback).toContain("-p/--print always runs once and needs a prompt");
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
  for (const entry of ["/undo [n]", "/redo [n]", "/rewind [n]", "/diff [n|list]", "/receipt <n>, /receipt list"]) expect(FULL_HELP_TEXT).toContain(entry);
});

test("help describes SGLang and MLX discovery without promising universal tools or MLX identity", () => {
  expect(FULL_HELP_TEXT).toContain("five loopback ports: 11434, 1234, 8080, 8000 and 30000 (SGLang); MLX shares 8080");
  expect(FULL_HELP_TEXT).toContain("(+ Add server)");
  expect(FULL_HELP_TEXT).toContain("like 192.0.2.10");
  expect(FULL_HELP_TEXT).toContain("With no port, detection tries the same five ports");
  expect(FULL_HELP_TEXT).toContain("All kinds are offered as fallbacks: Ollama, LM Studio, llama.cpp, vLLM, SGLang, MLX (MLX LM / vllm-mlx), OpenAI-style server");
  expect(FULL_HELP_TEXT).toContain("SGLang defaults to port 30000, MLX to 8080");
  expect(FULL_HELP_TEXT).toContain("not new login providers; no API keys needed");
  expect(FULL_HELP_TEXT).toContain("vllm-mlx's owned_by marker as MLX");
  expect(FULL_HELP_TEXT).toContain("MLX LM without a reliable identity marker stays OpenAI-style");
  expect(FULL_HELP_TEXT).toContain("when the model and server flags support them; SGLang may need --tool-call-parser");
});

test("/help lists setting up Casper's network server and its logins", () => {
  for (const text of [HELP_TEXT, FULL_HELP_TEXT]) expect(text).toContain("/mcp setup network");
  expect(HELP_TEXT).toContain("/mcp login ");
  expect(FULL_HELP_TEXT).toContain("/mcp login [mist|central|clearpass] [forget]");
  expect(FULL_HELP_TEXT).toContain("/allowed forget <n>");
  expect(FULL_HELP_TEXT).toContain("/mcp setup ssh [--name <name>] [host] [command]");
});
