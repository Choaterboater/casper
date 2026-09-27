import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { fakeWriter, interactiveTerminal } from "./support/tty";

// The rich-surface path is gated on `TERM !== "dumb"`.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const HEADING = "Casper checklist: 2 cases from your request.";
const HINT = "Enter starts with these · Esc starts without";
const CASES = ["limit(0) throws", "the 6th call is rejected"];

test("editLines fills the editor with the lines under a heading and hint; Enter returns them", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const edited = session.terminal.editLines(HEADING, HINT, CASES);
    await session.screen.until(output => output.includes(HEADING) && output.includes(HINT) && output.includes("the 6th call is rejected"));
    session.input.write("\r");
    expect(await edited).toEqual(CASES);
  } finally { session.close(); }
});

test("editLines returns the lines as edited", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const edited = session.terminal.editLines(HEADING, HINT, CASES);
    await session.screen.until(output => output.includes("the 6th call is rejected"));
    session.input.write("\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7fallowed\n");
    session.input.write("limit(-1) throws\r");
    expect(await edited).toEqual(["limit(0) throws", "the 6th call is allowed", "limit(-1) throws"]);
  } finally { session.close(); }
});

test("Escape returns undefined and a pretyped draft survives the edit", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const command = session.terminal.readCommand();
    session.input.write("partial");
    await session.screen.until(output => output.includes("partial"));
    const edited = session.terminal.editLines(HEADING, HINT, CASES);
    await session.screen.until(output => output.includes(HINT));
    session.input.write("\x1b");
    expect(await edited).toBeUndefined();
    session.input.write("\r");
    expect(await command).toBe("partial");
  } finally { session.close(); }
});

test("abort, Ctrl-C and closing the terminal each return undefined", async () => {
  const session = interactiveTerminal();
  try {
    session.terminal.setStatus("fixture"); session.terminal.start();
    const controller = new AbortController();
    const aborted = session.terminal.editLines(HEADING, HINT, CASES, controller.signal);
    await session.screen.until(output => output.includes(HINT));
    controller.abort();
    expect(await aborted).toBeUndefined();
    const interrupted = session.terminal.editLines(HEADING, HINT, CASES);
    session.input.write("\x03");
    expect(await interrupted).toBeUndefined();
    const closed = session.terminal.editLines(HEADING, HINT, CASES);
    session.terminal.close();
    expect(await closed).toBeUndefined();
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
  /** Sends a request, waits for the checklist editor, types `keys`, and waits for the task to finish. */
  const run = async (request: string, keys: string, done: (output: string) => boolean) => {
    const from = screen.output.length;
    input.write(`${request}\r`);
    const since = () => Bun.stripANSI(screen.output.slice(from)).replaceAll("\r\n", "\n");
    await screen.until(() => since().includes("Esc starts without a checklist"));
    input.write(keys);
    await screen.until(() => done(since()));
    return since();
  };
  /** Sends a request that is expected to run without the checklist editor, and waits for it to finish. */
  const plain = async (request: string) => {
    const from = screen.output.length;
    input.write(`${request}\r`);
    await screen.until(() => prompts.length > 0 && Bun.stripANSI(screen.output.slice(from)).includes("idle"));
    return Bun.stripANSI(screen.output.slice(from)).replaceAll("\r\n", "\n");
  };
  return { app, prompts, screen, run, plain, checklistCalls: () => checklistCalls, close: async () => {
    input.write("/exit\r"); await interactive; await app.close(); input.destroy();
    await rm(root, { recursive: true, force: true });
  } };
}

const finished = (output: string) => output.includes("idle") && /Casper checklist \(|\[checklist\]|\[cancel\]/.test(output);

test("interactive: Enter keeps the listed cases; an edit replaces them in the task prompt and the receipt", async () => {
  const fixture = await checklistApp();
  try {
    const kept = await fixture.run("add a rate limiter", "\r", finished);
    expect(kept).toContain("Casper checklist: 2 cases from your request.");
    expect(kept).toContain("Casper checklist (2 cases from your request):\n  - limit(0) throws\n  - the 6th call is rejected\n");
    expect(fixture.prompts.at(-1)).toContain("- limit(0) throws\n- the 6th call is rejected");
    expect(fixture.app.getLastTaskResult()?.checklist).toEqual(CASES);

    const edited = await fixture.run("add a rate limiter", "\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7fallowed\n- limit(-1) throws\r", finished);
    expect(edited).toContain("Casper checklist (3 cases, edited by you):\n  - limit(0) throws\n  - the 6th call is allowed\n  - limit(-1) throws\n");
    expect(fixture.prompts.at(-1)).toContain("- limit(0) throws\n- the 6th call is allowed\n- limit(-1) throws");
    expect(fixture.app.getLastTaskResult()?.checklist).toEqual(["limit(0) throws", "the 6th call is allowed", "limit(-1) throws"]);
  } finally { await fixture.close(); }
});

test("interactive: Esc starts the task without a checklist", async () => {
  const fixture = await checklistApp();
  try {
    const skipped = await fixture.run("add a rate limiter", "\x1b", finished);
    expect(skipped).toContain("[checklist] skipped; the task starts without one");
    expect(fixture.prompts).toHaveLength(1);
    expect(fixture.prompts[0]).not.toContain("Casper's checklist");
    expect(fixture.app.getLastTaskResult()?.checklist).toBeUndefined();
  } finally { await fixture.close(); }
});

test("interactive: Ctrl-C while editing cancels the task before the model starts", async () => {
  const fixture = await checklistApp();
  try {
    const cancelled = await fixture.run("add a rate limiter", "\x03", finished);
    expect(cancelled).toContain("[cancel]");
    expect(fixture.prompts).toHaveLength(0);
  } finally { await fixture.close(); }
});

test("interactive default: a code-change request gets the checklist with no setting; a question does not", async () => {
  const fixture = await checklistApp("");
  try {
    const asked = await fixture.plain("explain how the rate limiter works");
    expect(fixture.checklistCalls()).toBe(0);
    expect(asked).not.toContain("Casper checklist");
    const changed = await fixture.run("add a rate limiter", "\r", finished);
    expect(fixture.checklistCalls()).toBe(1);
    expect(changed).toContain("Casper checklist (2 cases from your request):");
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

test("a list cut at 80 cases says how many were left out", async () => {
  const many = Array.from({ length: 83 }, (_, index) => `case ${index}`);
  const fixture = await checklistApp(undefined, many);
  try {
    const shown = await fixture.run("add a rate limiter", "\r", finished);
    expect(shown).toContain("Casper checklist: 80 cases from your request (3 more were left out).");
    expect(shown).toContain("Casper checklist (80 cases from your request; 3 more were left out):");
  } finally { await fixture.close(); }
});
