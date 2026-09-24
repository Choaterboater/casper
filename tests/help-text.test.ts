import { expect, test } from "bun:test";
import { FULL_HELP_TEXT, HELP_TEXT, LOGIN_HELP } from "../src/tui/help";

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
  for (const entry of ["/model roles", "/model role <fast|build|reason|review> <selector|clear>", "/model @role[:effort]", "casper --licenses", "casper --help, -h"]) {
    expect(FULL_HELP_TEXT).toContain(entry);
  }
});
