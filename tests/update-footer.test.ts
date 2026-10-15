import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CasperApp } from "../src/app";
import { updateFooter, updateNoteText } from "../src/app/footer";

const INSTALLED = "✔ Update installed · restart to use it";

// The host's CI flag disables notices by design. Each behavior test owns its enabled/disabled environment.
const UPDATE_ENV = ["CI", "CASPER_NO_UPDATE_CHECK"] as const;
let savedEnv: Partial<Record<typeof UPDATE_ENV[number], string>>;
beforeEach(() => {
  savedEnv = {};
  for (const name of UPDATE_ENV) { savedEnv[name] = process.env[name]; delete process.env[name]; }
});
afterEach(() => {
  for (const name of UPDATE_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
  }
});

function fixture() {
  const notes: Array<string | undefined> = [];
  const app = {
    projectContext: { updates: "auto", info: { name: "demo-project", root: process.cwd() } },
    homeDir: () => "fixture-home",
    updatedInSession: false,
    updateNote: undefined as string | undefined,
    commandActive: false,
    terminal: { rich: true, setTitle() {}, setBadge() {}, setStatus() {}, setUpdate(note?: string) { notes.push(note); } },
    observations: { spent: () => ({ tokens: 0, cost: 0 }) },
    spentBefore: { tokens: 0, cost: 0 },
    subagents: { runs: () => [] },
  };
  return { app, notes, host: app as unknown as CasperApp };
}

test("an update installed in this session gets the full installed line, ahead of any stale app notice", () => {
  const { app, host } = fixture();
  app.updatedInSession = true;
  for (const note of [undefined, "Update ready · casper update", "Update failed · casper update"]) {
    app.updateNote = note;
    expect(updateNoteText(host)).toBe(INSTALLED);
  }
});

test("ready, installed and failed app notices pass through unchanged when no session update overrides them", () => {
  const { app, host } = fixture();
  for (const note of [undefined, "Update ready · casper update", INSTALLED, "Update failed · casper update"]) {
    app.updateNote = note;
    expect(updateNoteText(host)).toBe(note);
  }
});

test.each([...UPDATE_ENV])("%s explicitly disables both background and installed notices", (name) => {
  const { app, host } = fixture();
  app.updateNote = INSTALLED;
  process.env[name] = "1";
  for (const installed of [false, true]) {
    app.updatedInSession = installed;
    expect(updateNoteText(host)).toBeUndefined();
  }
});

test("turning updates off hides both background and in-session installed notices", () => {
  const { app, host } = fixture();
  app.updateNote = INSTALLED;
  app.projectContext.updates = "off";
  for (const installed of [false, true]) {
    app.updatedInSession = installed;
    expect(updateNoteText(host)).toBeUndefined();
  }
  app.projectContext.updates = "auto";
  expect(updateNoteText(host)).toBe(INSTALLED);
});

test("footer refresh forwards the update row while idle and working, and clears it when updates are disabled", () => {
  const { app, host, notes } = fixture();
  app.updatedInSession = true;
  for (const active of [false, true]) {
    app.commandActive = active;
    updateFooter(host);
    expect(notes.at(-1)).toBe(INSTALLED);
  }
  app.projectContext.updates = "off";
  updateFooter(host);
  expect(notes.at(-1)).toBeUndefined();
});
