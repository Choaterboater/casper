import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { COMMANDS } from "../src/tui/commands";

const doc = () => readFile(new URL("../docs/TERMINAL_UX.md", import.meta.url), "utf8");

test("TERMINAL_UX's command table lists every command in the / menu", async () => {
  const text = await doc();
  const table = text.slice(text.indexOf("### Commands"), text.indexOf("An unknown `/` command"));
  const missing = COMMANDS.map((command) => `/${command.name}`).filter((name) => !new RegExp(`\`${name}(?=[\\s\`])`).test(table));
  expect(missing).toEqual([]);
});

test("terminal polish is documented in its reference guide", async () => {
  const text = await doc();
  for (const claim of ["Enter to choose · Esc to skip", "120 columns", "twelve diff lines per file", "100 characters", "last sentence", "no empty `?` input row", "dim `–` notes", "four rows", "waited", "activity list remains above"]) expect(text).toContain(claim);

});

test("TERMINAL_UX's key table has Ctrl+T, and the doc no longer says there is no rollback", async () => {
  const text = await doc();
  const keys = text.slice(text.indexOf("### Keys"), text.indexOf("### Commands"));
  for (const key of ["Ctrl+T", "Ctrl+O", "Alt+O", "Ctrl+X", "Shift+Tab", "Esc"]) expect(keys).toContain(`| ${key}`);
  expect(text).not.toContain("no workspace rollback");
  expect(text).not.toContain("| `/diff` | Git status and tracked changes against HEAD |");
});
