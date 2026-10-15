import { expect, test } from "bun:test";
import path from "node:path";
import { parseCliArgs } from "../src/cli-args";
import { terminalPrompt } from "../src/cli-main";
import { cleanEnv } from "./support/env";
import { childTestLimit, finished } from "./support/limits";
import { initialProjectRequest } from "../src/app/workspace";
import type { CasperApp } from "../src/app";
import type { TaskResult } from "../src/task/result";

// Explicit streams and CI make this policy independent of the test runner's own terminal.
test("only an unforced terminal prompt starts a session", () => {
  const prompt = parseCliArgs(["fix it"]);
  expect(terminalPrompt(prompt, true, true, {})).toBe(true);
  expect(terminalPrompt(prompt, false, true, {})).toBe(false);
  expect(terminalPrompt(prompt, true, false, {})).toBe(false);
  for (const CI of ["1", "true", "", "0"]) expect(terminalPrompt(prompt, true, true, { CI })).toBe(false);
  for (const args of [["-p", "fix it"], ["--print", "fix it"], ["--json", "fix it"], ["--require-verification", "fix it"], ["--max-turns", "2", "fix it"], ["-"], [], ["doctor"], ["new", "sample"]]) {
    expect(terminalPrompt(parseCliArgs(args), true, true, {})).toBe(false);
  }
  expect(terminalPrompt(parseCliArgs(["--cd", ".", "--model", "fixture/demo", "--effort", "high", "--continue", "fix it"]), true, true, {})).toBe(true);
  expect(terminalPrompt(parseCliArgs(["--resume", "abc", "fix it"]), true, true, {})).toBe(true);
});

test("lone-word startup question is limited to broad folders and safe on cancellation", async () => {
  const home = path.resolve(".casper/synthetic-home");
  const drive = path.parse(home).root;
  for (const cwd of [home, drive]) {
    for (const answer of [0, 1, -1]) {
      let asked = 0;
      const app = {
        sessionHomeDir: home, queuedPrompt: "synthetic-project-name", commandActive: false,
        terminal: { canAsk: true, pick: async (question: string, choices: { label: string }[]) => {
          asked++;
          expect(question).toBe('"synthetic-project-name" isn\'t a folder here.');
          expect(choices.map(choice => choice.label)).toEqual(["Ask it as a question", "Start a new project named synthetic-project-name"]);
          return choices[answer]?.label;
        } },
      } as unknown as CasperApp;
      const result = await initialProjectRequest(app, cwd, "synthetic-project-name");
      expect(asked).toBe(1);
      expect(result?.name).toBe(answer === 1 ? "synthetic-project-name" : undefined);
      expect(app.queuedPrompt).toBe(answer === 0 ? "synthetic-project-name" : undefined);
    }
  }
  const app = { sessionHomeDir: home, terminal: { canAsk: true, pick: async () => { throw new Error("must not ask"); } } } as unknown as CasperApp;
  for (const [cwd, prompt] of [[path.join(home, "project"), "kvcache"], [home, "explain kvcache"], [home, "/help"], [drive, "."]]) {
    expect(await initialProjectRequest(app, cwd!, prompt!)).toBeUndefined();
  }
});

test("startup project names are literal even when they name templates, and invalid names are normalized", async () => {
  for (const [word, name] of [["empty", "empty"], ["web-app", "web-app"], ["Hello", "hello"], ["?", "my-project"]]) {
    const app = {
      sessionHomeDir: path.resolve(".casper/synthetic-home"), queuedPrompt: word,
      terminal: { canAsk: true, pick: async (_question: string, choices: { label: string }[]) => {
        expect(choices[1]!.label).toBe(`Start a new project named ${name}`);
        return choices[1]!.label;
      } },
    } as unknown as CasperApp;
    expect(await initialProjectRequest(app, app.sessionHomeDir!, word!)).toEqual({ name, template: "empty", list: false });
    expect(app.queuedPrompt).toBeUndefined();
  }
});

const cliMain = path.resolve(import.meta.dir, "../src/cli-main.ts");
const app = path.resolve(import.meta.dir, "../src/app.ts");

// The CLI runs in an isolated child: mocking the app must not affect other suites.
async function dispatch(args: string[], streams = [true, true], CI?: string, task?: TaskResult) {
  const script = `import { mock } from "bun:test";
    mock.module(${JSON.stringify(app)}, () => ({ CasperApp: class {
      constructor(options) { console.error("OPTIONS " + JSON.stringify({model:options.model,effort:options.effort,conversation:options.conversation})); }
      async runOnce(prompt) { console.error("ONCE " + JSON.stringify(prompt)); }
      async runInteractive(cwd, prompt) { console.error("SESSION " + JSON.stringify(prompt)); }
      getCommandTaskResult() { return ${JSON.stringify(task) ?? "undefined"}; } sandboxReceipt() {} commandUsage() {} async close() {}
    } }));
    Object.defineProperty(process.stdin, "isTTY", {value:${streams[0]}});
    Object.defineProperty(process.stdout, "isTTY", {value:${streams[1]}});
    process.argv = [process.execPath, "casper", ...${JSON.stringify(args)}];
    const {runCli, reportFatal} = await import(${JSON.stringify(cliMain)});
    try { await runCli(); } catch (error) { reportFatal(error); }`;
  return finished(() => Bun.spawn([process.execPath, "-e", script], {
    env: cleanEnv({ CI, CASPER_AGENT_DIR: path.resolve(".casper"), CASPER_LOCAL_MODELS: "off" }),
    stdin: args.includes("-") ? new Blob(["fix it"]) : "pipe", stdout: "pipe", stderr: "pipe",
  }));
}

test("CLI sends the initial prompt into interactive mode with model, effort and resume intact", async () => {
  const result = await dispatch(["--model", "fixture/demo", "--effort", "high", "--resume", "abc", "fix it"]);
  expect(result.exit).toBe(0);
  expect(result.stderr).toContain('SESSION "fix it"');
  expect(result.stderr).not.toContain("ONCE");
  expect(result.stderr).toContain('"conversation":{"resume":"abc"}');
  expect(result.stderr).toContain('"model":"fixture/demo","effort":"high"');
}, childTestLimit());

test("CLI keeps explicit print, JSON, constrained and redirected requests one-shot", async () => {
  for (const [args, streams, CI] of [
    [["-p", "fix it"], [true, true]], [["--print", "fix it"], [true, true]],
    [["--json", "fix it"], [true, true]], [["--max-turns", "1", "fix it"], [true, true]],
    [["--require-verification", "fix it"], [true, true]], [["fix it"], [false, true]],
    [["fix it"], [true, false]], [["fix it"], [true, true], "1"], [["-"], [false, true]],
  ] as [string[], boolean[], string?][]) {
    const result = await dispatch(args, streams, CI);
    expect(result.stderr).toContain('ONCE "fix it"');
    expect(result.stderr).not.toContain("SESSION");
    if (args.includes("--json")) expect(JSON.parse(result.stdout.trim()).type).toBe("receipt");
  }
}, childTestLimit(3));

test("print mode keeps task exit codes and JSON receipt fields", async () => {
  for (const [task, flags, exit, outcome] of [
    [{ execution: "completed", changedPaths: [] }, [], 0, "unchanged"],
    [{ execution: "failed" }, [], 1, "failed"],
    [{ execution: "completed", turnLimit: 1 }, [], 2, "incomplete"],
    [{ execution: "completed", changedPaths: ["example.ts"] }, ["--require-verification"], 3, "not_verified"],
  ] as [TaskResult, string[], number, string][]) {
    const result = await dispatch(["-p", "--json", ...flags, "fix it"], [true, true], undefined, task);
    expect(result.exit).toBe(exit);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ type: "receipt", exitCode: exit, outcome, execution: task.execution, changed: task.changedPaths ?? [] });
  }
}, childTestLimit(4));

test("print mode rejects a folder rather than opening an interactive session", async () => {
  for (const flag of ["-p", "--print"]) {
    const result = await dispatch([flag, "."]);
    expect(result.exit).toBe(64);
    expect(result.stderr).toContain("-p/--print needs a prompt");
    expect(result.stderr).not.toContain("SESSION");
  }
}, childTestLimit());
