import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FULL_HELP_TEXT } from "../src/tui/help";

const documents = ["docs/TERMINAL_UX.md", "docs/VERIFICATION.md", "docs/RELEASE.md", "site/roadmap.html"];

test.each(documents)("%s describes plain-word plan changes instead of the old editor", file => {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  expect(text).toContain("3 Change the plan");
  expect(text).toMatch(/number(?:s|ed).*?(?:steps|plan)/s);
  expect(text).toMatch(/rewrites? (?:the whole |the )?plan/);
  expect(text).toMatch(/Enter (?:chooses Stop|stops|still stops)/);
  expect(text).not.toMatch(/3 Edit the plan|Enter goes on to.*edit lines|Your changes:|Your note:|choose 3 to see them/);
});

test("the plan help names numbered cases and all three choices", () => {
  const line = FULL_HELP_TEXT.split("\n").find(line => line.includes("/plan <request>"))!;
  expect(line).toContain("Numbered plan and test cases");
  expect(line).toContain("1 Stop, 2 Build, 3 Change the plan in plain words");
  expect(line).not.toContain("you edit");
});
