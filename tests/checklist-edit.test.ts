import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { fakeWriter, interactiveTerminal } from "./support/tty";
import { removeTempDir } from "./support/temp-dir";

// The rich-surface path is gated on `TERM !== "dumb"`.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const HEADING = "What should change?";
const HINT = 'Type a change ("drop step 2") or ask ("why step 3?") · Enter sends · Esc stops without building';
const CASES = ["limit(0) throws", "the 6th call is rejected"];

test.each(["drop steps 1 and 4", "also test X"])("the change input is an empty line that accepts plain words: %s", async (change) => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const answer = session.terminal.askLine(HEADING, HINT);
    await session.screen.until(output => output.includes(HEADING) && output.includes(HINT));
    expect(Bun.stripANSI(session.screen.output)).not.toContain("limit(0) throws");
    session.input.write(`${change}\r`);
    expect(await answer).toBe(change);
  } finally { session.close(); }
});

test("the raw multi-line editor is removed", () => {
  const session = interactiveTerminal();
  try { expect("editLines" in session.terminal).toBe(false); }
  finally { session.close(); }
});

test("a multiline paste stays one line in the change input", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.start();
    const answer = session.terminal.askLine(HEADING, HINT);
    session.input.write("\x1b[200~drop step 1\nalso test X\x1b[201~");
    await session.screen.until(output => output.includes("drop step 1 also test X"));
    session.input.write("\r");
    expect(await answer).toBe("drop step 1 also test X");
  } finally { session.close(); }
});

test("empty Enter returns an empty change, not plan text", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.start();
    const answer = session.terminal.askLine(HEADING, HINT);
    session.input.write("\r");
    expect(await answer).toBe("");
  } finally { session.close(); }
});

test("Escape returns undefined and a pretyped draft survives the change input", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const command = session.terminal.readCommand();
    session.input.write("partial");
    await session.screen.until(output => output.includes("partial"));
    const answer = session.terminal.askLine(HEADING, HINT);
    await session.screen.until(output => output.includes(HINT));
    session.input.write("\x1b");
    expect(await answer).toBeUndefined();
    session.input.write("\r");
    expect(await command).toBe("partial");
  } finally { session.close(); }
});

test.each(["abort", "Ctrl-C", "close"])("%s returns undefined from the change input", async (action) => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const controller = new AbortController();
    const answer = session.terminal.askLine(HEADING, HINT, controller.signal);
    await session.screen.until(output => output.includes(HINT));
    if (action === "abort") controller.abort();
    else if (action === "Ctrl-C") session.input.write("\x03");
    else session.terminal.close();
    expect(await answer).toBeUndefined();
  } finally { session.close(); }
});

/** An interactive CasperApp; `config` is the project's verification setting (checklist on by default here).
 * The fake model lists `cases` and records each task prompt and each checklist call. */
async function checklistApp(config = "verification:\n  checklist: true\n", cases: readonly string[] = CASES) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-checklist-edit-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  if (config) await writeFile(path.join(project, ".casper/project.yaml"), config);
  const prompts: string[] = [];
  let checklistCalls = 0;
  const runtime: AgentRuntime = {
    start: async () => ({
      getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
      getState: () => ({ cwd: project, isStreaming: false }),
      setTools: () => {},
      subscribe: () => () => {},
      abort: async () => {},
      prompt: async text => { prompts.push(text); },
      complete: async () => { checklistCalls++; return { text: JSON.stringify(cases), usage: { tokens: 10, estimatedCost: 0 } }; },
    }),
    dispose: async () => {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = new CasperApp({
    input, output: screen.writer, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  await screen.until(output => output.includes("idle"));
  /** Sends a request that is expected to run without the checklist editor, and waits for it to finish. */
  const plain = async (request: string) => {
    const from = screen.output.length;
    input.write(`${request}\r`);
    await screen.until(() => prompts.length > 0 && Bun.stripANSI(screen.output.slice(from)).includes("idle"));
    return Bun.stripANSI(screen.output.slice(from)).replaceAll("\r\n", "\n");
  };
  return { app, input, prompts, screen, plain, checklistCalls: () => checklistCalls, close: async () => {
    input.write("/exit\r"); await interactive; await app.close(); input.destroy();
    await removeTempDir(root);
  } };
}

/** Asks for several things: it is built at once, and the checklist is still made quietly. */
const BIG = "add a rate limiter to the API, then add a /health endpoint, then add request logging, and also add a config file for the limits";

test("interactive: the cases are made quietly, reach the task prompt, and /receipt lists them", async () => {
  const fixture = await checklistApp();
  try {
    const shown = await fixture.plain("add a rate limiter");
    expect(fixture.checklistCalls()).toBe(1);
    // Nothing before work: no editor and no printed list.
    expect(shown).not.toContain("Casper checklist");
    expect(shown).not.toContain("limit(0) throws");
    expect(fixture.prompts.at(-1)).toContain("- limit(0) throws\n- the 6th call is rejected");
    expect(fixture.app.getLastTaskResult()?.checklist).toEqual(CASES);
    const from = fixture.screen.output.length;
    fixture.input.write("/receipt\r");
    await fixture.screen.until(() => Bun.stripANSI(fixture.screen.output.slice(from)).includes("the 6th call is rejected"));
    const receipt = Bun.stripANSI(fixture.screen.output.slice(from)).replaceAll("\r\n", "\n");
    expect(receipt).toContain("checklist    2 cases from your request (handed to the model to test; not evidence)");
    expect(receipt).toContain("- limit(0) throws");
  } finally { await fixture.close(); }
});

test("a request that asks for several things opens no editor or panel: the cases go straight to the model", async () => {
  const fixture = await checklistApp();
  try {
    const shown = await fixture.plain(BIG);
    expect(shown).not.toContain("Esc starts without a checklist");
    expect(shown).not.toContain("Suggested: plan first");
    expect(fixture.checklistCalls()).toBe(1);
    expect(fixture.prompts.at(-1)).toContain("- limit(0) throws\n- the 6th call is rejected");
    expect(fixture.app.getLastTaskResult()?.checklist).toEqual(CASES);
  } finally { await fixture.close(); }
});

test("interactive default: a code-change request gets the checklist with no setting; a question does not", async () => {
  const fixture = await checklistApp("");
  try {
    const asked = await fixture.plain("explain how the rate limiter works");
    expect(fixture.checklistCalls()).toBe(0);
    expect(asked).not.toContain("Casper checklist");
    await fixture.plain("add a rate limiter");
    expect(fixture.checklistCalls()).toBe(1);
    expect(fixture.prompts.at(-1)).toContain("- limit(0) throws\n- the 6th call is rejected");
  } finally { await fixture.close(); }
});

test("interactive: verification.checklist: false turns the default off", async () => {
  const fixture = await checklistApp("verification:\n  checklist: false\n");
  try {
    await fixture.plain("add a rate limiter");
    expect(fixture.checklistCalls()).toBe(0);
    expect(fixture.prompts[0]).not.toContain("Casper's checklist");
  } finally { await fixture.close(); }
});

test("a list cut at 80 cases says how many were left out, in one line", async () => {
  const many = Array.from({ length: 83 }, (_, index) => `case ${index}`);
  const fixture = await checklistApp(undefined, many);
  try {
    const shown = await fixture.plain("add a rate limiter");
    expect(shown).toContain("– Checklist kept 80 cases; 3 more were left out\n");
    expect(shown).not.toContain("case 0");
  } finally { await fixture.close(); }
});
