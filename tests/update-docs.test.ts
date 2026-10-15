import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const read = (name: string) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("background updates are documented as unreleased, with modes, terminal row, Windows handoff and verification guarantees", async () => {
  const config = await read("docs/CONFIGURATION.md");
  for (const text of ["**Updates**", "`auto` (the default)", "`notify` (**notify only**)", "`off`", "Old `updates: false` means `off`", "old `updates: true`", "three minutes", "never in one-shot or `--json`", "bun install --frozen-lockfile", "project-selected profile cannot change it"]) expect(config).toContain(text);
  const terminal = await read("docs/TERMINAL_UX.md");
  for (const text of ["right-aligned row just above the prompt", "idle or working", "✔ Update installed · restart to use it", "✔ restart to update", "`NO_COLOR`", "Plain terminals print one `[update]", "update failed · casper update"]) expect(terminal).toContain(text);
  const windows = await read("docs/WINDOWS.md");
  for (const text of ["Background updates (built, not released)", "WMI handoff", "restart to use it", "waits until this Casper exits", "Background handoffs wait for the whole session"]) expect(windows).toContain(text);
  const security = await read("docs/SECURITY.md");
  for (const text of ["Background self-updates (built, not released)", "same\n  `runUpdate` path as `casper update`", "SHA256SUMS signature", "SHA-256", "GitHub build provenance", "never during task checks", "No stash, rebase or branch switch", "private lock"]) expect(security).toContain(text);
  const release = await read("docs/RELEASE.md");
  const unreleased = release.split("## v0.2.36:")[1]!.split("## v0.2.35:")[0]!;
  expect(unreleased).toContain("Casper updates itself quietly by default");
  expect(unreleased).toContain("**Updates: auto / notify only / off**");
  const roadmap = await read("site/roadmap.html");
  const built = roadmap.split("Built, not released</strong>")[1]!.split("</aside>")[0]!;
  expect(built).toContain("Background self-updates");
  expect(built).toContain("Updates: auto / notify only / off");
  const choices = await read("docs/adr/0002-deliberate-choices.md");
  expect(choices).toContain("### 13. Changing the project's checks needs its own answer");
  expect(choices).toContain("### 14. Casper installs its own updates quietly by default");
});
