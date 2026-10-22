import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { deliberateChoices } from "../tools/adr-index";

const read = (name: string) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("background updates document modes, terminal row, Windows handoff and verification guarantees", async () => {
  const config = await read("docs/CONFIGURATION.md");
  for (const text of ["**Updates**", "`auto` (the default)", "`notify` (**notify only**)", "`off`", "Old `updates: false` means `off`", "old `updates: true`", "three minutes", "never in one-shot or `--json`", "bun install --frozen-lockfile", "project-selected profile cannot change it"]) expect(config).toContain(text);
  const terminal = await read("docs/TERMINAL_UX.md");
  for (const text of ["right-aligned row just above the prompt", "idle or working", "✔ Update installed · restart to use it", "✔ restart to update", "`NO_COLOR`", "Plain terminals print one `[update]", "update failed · casper update"]) expect(terminal).toContain(text);
  const windows = await read("docs/WINDOWS.md");
  for (const text of ["### Background updates", "WMI handoff", "restart to use it", "waits until this Casper exits", "Background handoffs wait for the whole session"]) expect(windows).toContain(text);
  const security = await read("docs/SECURITY.md");
  for (const text of ["Background self-updates (since v0.2.36)", "same\n  `runUpdate` path as `casper update`", "SHA256SUMS signature", "SHA-256", "GitHub build provenance", "never during task checks", "No stash, rebase or branch switch", "private lock"]) expect(security).toContain(text);
  const choices = await deliberateChoices();
  expect(choices).toContain("# 13. Changing the project's checks needs its own answer");
  expect(choices).toContain("# 14. Casper installs its own updates quietly by default");
  expect(choices).toContain("a native configured-check rewrite persists without its answer");
  expect(choices).toContain("a weaker verification path, an install overlapping task checks");
});

test("checkout updates document that untracked files don't hold them back and that a held checkout says why", async () => {
  const held = "`Casper update ready · checkout has uncommitted changes · casper update`";
  const config = await read("docs/CONFIGURATION.md");
  for (const text of ["Untracked files don't stop it", "shows as a failed update", held, "`checkout on another branch`", "`checkout tracks another upstream`", "`checkout has local commits`", "`default branch unknown`"]) expect(config).toContain(text);
  const terminal = await read("docs/TERMINAL_UX.md");
  for (const text of [held, "a narrow window keeps `Casper update ready`"]) expect(terminal).toContain(text);
  expect(await read("docs/SECURITY.md")).toContain("untracked files stay");
  expect(await read("docs/DEVELOPING.md")).toContain("Untracked files, such as your own notes, don't stop it");
  const choices = await deliberateChoices();
  expect(choices).toContain("# 30. Untracked files don't hold back a checkout's own update");
  expect(choices).toContain("an untracked file overwritten or removed by a background update");
});
