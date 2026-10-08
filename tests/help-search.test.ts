import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { COMMANDS } from "../src/tui/commands";
import { FULL_HELP_TEXT, HELP_TEXT, helpFor, unknownCommandMessage, wrapHelp } from "../src/tui/help";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => removeTempDir(dir))); });

async function run(prompt: string): Promise<{ output: string; error?: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-help-")); roots.push(root);
  let output = "";
  const app = new CasperApp({ output: { write: (text) => { output += text; } }, runtimeFactory() { throw new Error("No model expected"); } });
  try { await app.runOnce(prompt, root); return { output }; }
  catch (error) { return { output, error: (error as Error).message }; }
  finally { await app.close(); }
}

test("every command in the / menu is in /help all", () => {
  const missing = COMMANDS.map((command) => `/${command.name}`).filter((name) => !new RegExp(`(?:^|\\s)${name}(?=[\\s,]|$)`, "m").test(FULL_HELP_TEXT));
  expect(missing).toEqual([]);
});

test("/help all lists /lab and /mcp allow", () => {
  for (const entry of ["/lab ", "/lab import <file>", "/mcp allow <name>"]) expect(FULL_HELP_TEXT).toContain(entry);
});

test("the short help is about 15 lines and names /mcp, /lab, /references and /verify add", () => {
  expect(HELP_TEXT.trimEnd().split("\n").length).toBeLessThanOrEqual(16);
  for (const entry of ["/mcp", "/lab", "/references", "/verify add", "/help <word>"]) expect(HELP_TEXT).toContain(entry);
});

test("the help uses plain words", () => {
  for (const jargon of [/\binert\b/i, /digest-bound/i, /\bDAP\b/, /cooked terminal/i]) expect(FULL_HELP_TEXT).not.toMatch(jargon);
});

test("/help <word> lists the help lines that mention it", () => {
  const text = helpFor("mcp");
  expect(text).toContain("/mcp connect <name>");
  expect(text).toContain("/mcp writes off");
  expect(text).not.toContain("/undo [n]");
  expect(helpFor("/lab")).toContain("/lab import <file>");
});

test("/help <word> with no match says so and points at /help all", () => {
  expect(helpFor("zebra")).toBe('[help] Nothing in the help mentions "zebra". /help all shows everything.\n');
  // A near miss of a command name gets "did you mean".
  expect(helpFor("resme")).toContain("Did you mean /resume?");
});

test("an unknown command gets a did-you-mean when one is close", () => {
  expect(unknownCommandMessage("/verfy")).toBe('Unknown command "/verfy". Did you mean /verify? Type /help for local commands.');
  expect(unknownCommandMessage("/sttaus")).toContain("Did you mean /status?");
  expect(unknownCommandMessage("/zzzzzz")).toBe('Unknown command "/zzzzzz". Type /help for local commands.');
});

test("long help rows wrap under their own description column", () => {
  const row = "  /details [quiet|normal|detailed]  For this session: failures only, steps folded (default), or every step with small diffs";
  const lines = wrapHelp(`${row}\n`, 60).trimEnd().split("\n");
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.every((line) => line.length <= 60)).toBe(true);
  const column = row.indexOf("For this session");
  for (const line of lines.slice(1)) expect(line.search(/\S/)).toBe(column);
  // Prose wraps at word boundaries with no indent; no width (piped output) leaves the text alone.
  const prose = "Approvals need a fresh yes from you, and the AI can never approve anything for you on its own.";
  expect(wrapHelp(prose, 40).split("\n").every((line) => line.length <= 40 && !line.startsWith(" "))).toBe(true);
  expect(wrapHelp(prose, undefined)).toBe(prose);
});

test("/help mcp and a mistyped command work in the app", async () => {
  const help = await run("/help mcp");
  expect(help.error).toBeUndefined();
  expect(help.output).toContain("/mcp connect <name>");
  const typo = await run("/verfy typecheck");
  expect(typo.error).toContain("Did you mean /verify?");
});

test("writes off is said in one sentence everywhere: /mcp, /help all and MCP.md", async () => {
  const { WRITES_OFF_MEANING } = await import("../src/mcp/presets");
  const { readFile } = await import("node:fs/promises");
  expect(WRITES_OFF_MEANING).toBe("Writes off: the server runs with its read-only settings, and every change asks you first.");
  expect(FULL_HELP_TEXT).toContain(WRITES_OFF_MEANING);
  expect(await readFile(new URL("../docs/MCP.md", import.meta.url), "utf8")).toContain(WRITES_OFF_MEANING);
  const commands = await readFile(new URL("../src/app/commands.ts", import.meta.url), "utf8");
  expect(commands).toContain("`${WRITES_OFF_MEANING} ");
});

test("an unknown /theme (or /colour) says where themes are", () => {
  for (const word of ["/theme", "/themes", "/colour", "/colors"]) {
    expect(unknownCommandMessage(word)).toBe(`Unknown command "${word}". Themes are in /settings (Theme). Type /help for local commands.`);
  }
  // A near miss of a real command still gets the did-you-mean.
  expect(unknownCommandMessage("/sttaus")).not.toContain("Themes are");
});
