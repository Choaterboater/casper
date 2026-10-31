import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { bundledFlows, findFlow } from "../src/flows/catalog";
import { loadProjectContext } from "../src/project/context";
import type { RuntimeTool, AgentRuntime, RuntimeEventListener, RuntimeStartOptions } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { isScreenTranscript } from "../src/app/request-words";
import { removeTempDir } from "./support/temp-dir";
import { ansiCells, cellsFor, cellSnapshot } from "./support/ansi-cells";

// The rich-surface path is gated on `TERM !== "dumb"`.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const REQUEST = "add a rate limiter to the API, then add a /health endpoint, then add request logging, and also add a config file for the limits";
const CASES = ["limit(0) throws", "the 6th call is rejected"];
const PLAN = "Plan:\n1. Add a Limiter class in limiter.py\n2. Call it from app.py\n\nTests:\n- limit(0) throws\n- a /health request answers 200\n";

/** A fake TTY that keeps both the original escape codes and plain text as they arrive. */
function plainScreen(columns = 120) {
  let output = "", raw = "";
  const waiters: Array<{ test: (output: string) => boolean; resolve: () => void }> = [];
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns, rows: 40, write(text: string) {
    raw += text;
    output += Bun.stripANSI(text).replaceAll("\r\n", "\n");
    for (const waiter of [...waiters]) if (waiter.test(output)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  return { writer, get output() { return output; }, get raw() { return raw; }, until(test: (output: string) => boolean): Promise<void> {
    if (test(output)) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error(`screen did not match; it ends with:\n${output.slice(-2500)}`)), 25_000);
    waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
    return promise;
  } };
}

/** The fake model: on a plan turn it tries an edit and two shell commands through Casper's gate, then answers
 * with PLAN; otherwise it writes a file. */
async function fixture(tty = true, setup: { planWrites?: boolean; planCode?: boolean; answer?: string; rewrites?: string[]; rewriteFails?: boolean; rewriteWrites?: boolean; planFails?: boolean; homeConfig?: string; empty?: boolean; reportSteps?: boolean; columns?: number; toolsSeen?: string[][] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-plan-first-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  if (!setup.empty) await writeFile(path.join(project, "app.py"), "print('app')\n");
  if (setup.homeConfig) { await mkdir(path.join(home, ".casper"), { recursive: true }); await writeFile(path.join(home, ".casper/config.yaml"), setup.homeConfig); }
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  checklist: true\n"
    + (setup.planCode ? `  mode: auto\nverify:\n  test: ${JSON.stringify(`"${process.execPath}" -e "process.exit(0)"`)}\n` : ""));
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const prompts: string[] = [];
  const gate: Array<{ tool: string; reason: string | undefined }> = [];
  let checklistCalls = 0;
  const checklistAsked: string[] = [];
  let planCalls = 0;
  let options: RuntimeStartOptions | undefined;
  let tools: RuntimeTool[] = [];
  const runtime: AgentRuntime = {
    start: async (started) => {
      options = started;
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        setTools: value => { tools = value; }, abort: async () => {},
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        complete: async (input) => { checklistCalls++; checklistAsked.push(input.user); return { text: JSON.stringify(CASES), usage: { tokens: 10, estimatedCost: 0 } }; },
        prompt: async (text) => {
          prompts.push(text);
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          for (const [tool, input] of [["edit", { path: "app.py", oldText: "app", newText: "x" }], ["bash", { command: "rm app.py" }],
            ["bash", { command: "ls -la && git log --oneline" }], ["mcp", { server: "central", tool: "delete_site" }], ["read", { path: "app.py" }]] as const) {
            gate.push({ tool: `${tool} ${JSON.stringify(input)}`, reason: options?.beforeToolGate?.(tool, input as Record<string, unknown>) });
          }
          if (text.includes('Casper flow "plan-first"')) {
            planCalls++;
            // A change Casper's gate cannot see (a tool that says nothing about writing, say).
            if (setup.planWrites) await writeFile(path.join(project, "notes.txt"), "written while planning\n");
            if (setup.planCode) await writeFile(path.join(project, "app.py"), "print('broken while planning')\n");
            if (setup.rewriteWrites && planCalls > 1) await writeFile(path.join(project, "notes.txt"), "written during a rewrite\n");
            emit({ type: "assistant_text_delta", delta: (planCalls > 1 ? setup.rewrites?.[planCalls - 2] : undefined) ?? setup.answer ?? PLAN });
            if (setup.planFails || (setup.rewriteFails && planCalls > 1)) { emit({ type: "assistant_response_end", stopReason: "error", errorMessage: "provider went away" }); return; }
          }
          else {
            setup.toolsSeen?.push(tools.map(tool => tool.name));
            const tool = tools.find(tool => tool.name === "plan_step");
            if (setup.reportSteps && tool) {
              await tool.execute({ step: 1, status: "done" });
              await tool.execute({ step: 2, status: "active" });
              await Bun.sleep(80); // Give the real renderer a frame during this model/tool round-trip.
              await tool.execute({ step: 2, status: "not-done", reason: "Needs an API decision" });
            }
            await writeFile(path.join(project, "limiter.py"), `# ${prompts.length}\n`); emit({ type: "assistant_text_delta", delta: "Built.\n" });
          }
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    dispose: async () => {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode() {} });
  const screen = plainScreen(setup.columns);
  let plain = "";
  const app = new CasperApp({
    input, output: tty ? screen.writer : { write: (text: string) => { plain += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = tty ? app.runInteractive(project) : undefined;
  if (tty) await screen.until((output) => output.includes(process.env.TERM === "dumb" ? "> " : "idle"));
  return { app, input, screen, prompts, gate, project, plain: () => plain, checklistCalls: () => checklistCalls, checklistAsked, close: async () => {
    await app.close(); input.destroy();
    if (interactive) await interactive;
    await removeTempDir(root);
  } };
}

const waiting = (question: string) => (output: string) => output.includes(question) && output.slice(output.lastIndexOf(question)).includes("? waiting for you");
const isIdle = (output: string) => /(?:^|[\r\n])idle +[^\r\n]*$/.test(output.trimEnd());
const idleAfter = (marker: string) => (output: string) => output.includes(marker) && isIdle(output.slice(output.lastIndexOf(marker)));

const HINT = "– Big job (this asks for 4 things): /plan first next time to see the steps before any change";

test("a big vague request builds straight away, with a one-line hint to /plan first next time", async () => {
  const f = await fixture();
  try {
    f.input.write(`${REQUEST}\r`);
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).toContain(HINT);
    // No panel before work: nothing waited for an answer.
    expect(f.screen.output).not.toContain("Suggested: plan first");
    expect(f.screen.output).not.toContain("? waiting for you");
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain("- limit(0) throws\n- the 6th call is rejected");
    expect(f.prompts[0]).not.toContain('Casper flow "plan-first"');
    expect(f.gate.every(({ reason }) => reason === undefined)).toBe(true);
  } finally { await f.close(); }
}, 60_000);

test("/plan: the plan turn refuses changes; 2 builds the plan", async () => {
  const f = await fixture();
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    expect(f.screen.output).not.toContain("Big job");
    // Casper's plan screen, once: numbered steps and cases, not the raw answer too.
    expect(f.screen.output).toContain("── Plan");
    expect(f.screen.output).toMatch(/  1\. Add a Limiter class +limiter\.py/);
    expect(f.screen.output).toContain("Done means");
    expect(f.screen.output).toContain("1. limit(0) throws");
    expect(f.screen.output).toContain("2. a /health request answers 200");
    expect(f.screen.output).not.toContain("Esc stops without building");
    expect(f.screen.output.split("Add a Limiter class").length - 1).toBe(1);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain(findFlow(bundledFlows(), "plan-first")!.body.trim());
    const reasons = Object.fromEntries(f.gate.map(({ tool, reason }) => [tool.split(" ")[0] + (tool.includes("rm ") ? " rm" : tool.includes("ls ") ? " ls" : ""), reason]));
    expect(reasons.edit).toStartWith("Not run: Planning only: Casper blocks file changes until you choose Build");
    expect(reasons["bash rm"]).toStartWith("Not run: Planning only");
    expect(reasons["bash ls"]).toBeUndefined();
    expect(reasons.mcp).toStartWith("Not run: Planning only");
    expect(reasons.read).toBeUndefined();
    expect(f.screen.output).toContain("❯ 1. Stop");
    expect(f.screen.output).toContain("  2. Build");
    expect(f.screen.output).toContain("  3. Change the plan");
    // A call blocked while planning reads "not run", never "failed".
    expect(f.screen.output).not.toMatch(/✗ (?:bash|edit|write)[^\n]*failed/);
    expect(f.prompts).toHaveLength(1);
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("Casper plan (the user read and accepted it). Follow these steps in order:\n1. Add a Limiter class in limiter.py\n2. Call it from app.py");
    expect(f.prompts[1]).toContain("- limit(0) throws\n- a /health request answers 200");
    expect(f.prompts[1]).not.toContain('Casper flow "plan-first"');
    // The build turn runs without the plan gate, and the cases come from the plan, not a checklist call.
    expect(f.gate.slice(5).every(({ reason }) => reason === undefined)).toBe(true);
    expect(f.checklistCalls()).toBe(0);
    expect(f.app.getLastTaskResult()?.checklist).toEqual(["limit(0) throws", "a /health request answers 200"]);
  } finally { await f.close(); }
}, 60_000);

test("Esc in the change input stops without building", async () => {
  const f = await fixture();
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("3");
    await f.screen.until((output) => output.includes("Esc stops without building"));
    f.input.write("\x1b");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
    expect(f.prompts).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);

test("Enter at Build this plan? stops without building (rich terminal)", async () => {
  const f = await fixture();
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    expect(f.prompts).toHaveLength(1);
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
    expect(f.prompts).toHaveLength(1);
    expect(f.screen.output).not.toContain("Built.");
  } finally { await f.close(); }
}, 60_000);

test("a short fix gets no plan-first choice", async () => {
  const f = await fixture();
  try {
    f.input.write("fix the typo in README\r");
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).not.toContain("plan first");
    // The checklist is made quietly: no panel or list before work, and the cases still reach the model.
    expect(f.screen.output).not.toContain("Esc starts without a checklist");
    expect(f.screen.output).not.toContain("Casper checklist");
    expect(f.checklistCalls()).toBe(1);
    expect(f.prompts[0]).toContain("- limit(0) throws");
  } finally { await f.close(); }
}, 60_000);

/** A build request that already lists concrete requirements: a benchmark prompt, asked in an existing project
 * (in an empty folder the new-project question comes first instead). */
const DETAILED = [
  "Add an IPv4 subnet calculator to this project.",
  "- Input an address with a prefix (for example 10.1.2.3/22). Show the network, broadcast, first and last usable host, number of usable hosts, subnet mask and wildcard mask.",
  "- Also split a network into N equal subnets (N a power of two) and list them.",
  "- Handle /31 and /32 correctly, and reject bad input with a clear message.",
  "- Use Bun and TypeScript, no framework. `bun run dev` serves the page; the math lives in its own module.",
  "- Include unit tests for the math (`bun test`), with edge cases, and a short README saying how to run it.",
  "When you're done, run the tests and make sure they pass.",
].join("\n");

test("a request that already lists concrete requirements builds without the plan-first question", async () => {
  const f = await fixture();
  try {
    // Pasted as one bracketed block so its newlines stay in the request.
    f.input.write(`\x1b[200~${DETAILED}\x1b[201~`);
    await f.screen.until((output) => output.includes("make sure they pass"));
    f.input.write("\r");
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).not.toContain("plan first");
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).not.toContain('Casper flow "plan-first"');
    expect(f.prompts[0]).toContain("- limit(0) throws");
  } finally { await f.close(); }
}, 60_000);

test("Suggestions off in /settings (suggestions: false) leaves the hint out too", async () => {
  const f = await fixture(true, { homeConfig: "suggestions: false\n" });
  try {
    f.input.write(`${REQUEST}\r`);
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).not.toContain("Big job");
    expect(f.prompts).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);

test("using /plan counts as taking the hint, so it does not fade while you plan", async () => {
  const f = await fixture();
  const hints = () => f.screen.output.split(HINT).length - 1;
  const build = async (count: number) => {
    f.input.write(`${REQUEST}\r`);
    await f.screen.until((output) => output.split("Built.").length - 1 === count && isIdle(output));
  };
  try {
    await build(1); await build(2);
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
    // Two ignored, then /plan: the count starts again, so two more still show it.
    await build(3); await build(4);
    expect(hints()).toBe(4);
  } finally { await f.close(); }
}, 90_000);

test("/suggestions off plan-first stops the hint for a big vague request", async () => {
  const f = await fixture();
  try {
    f.input.write("/suggestions off plan-first\r");
    await f.screen.until((output) => isIdle(output) && output.includes("plan-first"));
    f.input.write(`${REQUEST}\r`);
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).not.toContain("Big job");
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).not.toContain('Casper flow "plan-first"');
  } finally { await f.close(); }
}, 60_000);

test("/plan in a run that cannot ask shows the plan and builds nothing", async () => {
  const f = await fixture(false);
  try {
    await f.app.runOnce(`/plan ${REQUEST}`, f.project);
    expect(f.plain()).toContain("Casper plan\n");
    expect(f.plain()).toMatch(/  1\. Add a Limiter class +limiter\.py/);
    expect(f.plain()).toContain("Done means\n  1. limit(0) throws\n  2. a /health request answers 200");
    // The answer is shown once, as Casper's plan, not also as the model streamed it.
    expect(f.plain().split("Add a Limiter class").length - 1).toBe(1);
    expect(f.plain()).toContain("[plan] This run can't ask you to build, so Casper stopped after the plan. Nothing was built.");
    expect(f.prompts).toHaveLength(1);
    expect(f.checklistCalls()).toBe(0);
  } finally { await f.close(); }
}, 60_000);

test("a file that changes while planning anyway is named, and the receipt keeps it", async () => {
  const f = await fixture(true, { planWrites: true });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    expect(f.screen.output).toContain("– Changed while planning: notes.txt");
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.app.getLastTaskResult()?.changedWhilePlanning).toEqual(["notes.txt"]);
    // The receipt card names it on its Changed row.
    expect(f.screen.output.slice(f.screen.output.lastIndexOf("Built."))).toContain("Changed while planning: notes.txt");
  } finally { await f.close(); }
}, 60_000);

test("code that changes while planning is not taken as the code from before the change: the proof says it can't compare", async () => {
  const f = await fixture(true, { planCode: true });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    const proof = f.app.getLastTaskResult()?.proof;
    expect(proof?.status).toBe("unavailable");
    expect(proof?.status === "unavailable" ? proof.reason : "").toContain("changed while planning (app.py)");
  } finally { await f.close(); }
}, 60_000);

test("the plain terminal asks Build this plan? with numbers: Enter stops and builds nothing, 2 builds", async () => {
  const term = process.env.TERM;
  process.env.TERM = "dumb";
  try {
    for (const [answer, builds] of [["", false], ["2", true]] as const) {
      const f = await fixture(true);
      try {
        f.input.write(`/plan ${REQUEST}\n`);
        await f.screen.until((output) => output.includes("Build this plan?") && /Type [\d, ]*\d or \d:$/.test(output.trimEnd()));
        expect(f.screen.output).toMatch(/  1\. Add a Limiter class +limiter\.py/);
        expect(f.screen.output).toContain("Done means\n  1. limit(0) throws\n  2. a /health request answers 200");
        expect(f.screen.output).toContain("  1 Stop · nothing is built");
        expect(f.screen.output).toContain("  2 Build · the model builds these steps and tests these cases\n");
        expect(f.screen.output).toContain("  3 Change the plan · tell the model what to change, then choose again\n");
        f.input.write(`${answer}\n`);
        if (builds) await f.screen.until((output) => output.includes("Built."));
        else await f.screen.until((output) => output.includes("[plan] Stopped without building."));
        expect(f.prompts).toHaveLength(builds ? 2 : 1);
      } finally { await f.close(); }
    }
  } finally { process.env.TERM = term; }
}, 90_000);

test("empty Enter in Change the plan asks again without calling the model or building", async () => {
  const f = await fixture();
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("3");
    await f.screen.until(waiting("What should change?"));
    const from = f.screen.output.length;
    f.input.write("\r");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.prompts).toHaveLength(1);
    expect(f.screen.output.slice(from)).toMatch(/  1\. Add a Limiter class +limiter\.py/);
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
    expect(f.prompts).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);

test("the confusing editor hint is no longer shown", async () => {
  const f = await fixture();
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("3");
    await f.screen.until(waiting("What should change?"));
    expect(f.screen.output).not.toContain("Enter goes on to 1 Stop · 2 Build · edit lines");
    expect(f.screen.output).not.toContain("Edit the plan");
    f.input.write("\x1b");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
  } finally { await f.close(); }
}, 60_000);

test.each(["xterm-256color", "dumb"])("after a change request the model rewrites the plan and shows it with the same choices (%s)", async term => {
  const previous = process.env.TERM;
  process.env.TERM = term;
  const rewritten = "Steps:\n1. Call the limiter from the API\n\nTests:\n- X passes\n\nDetails:\nUse the existing API handler.";
  const f = await fixture(true, { rewrites: [rewritten] });
  const enter = term === "dumb" ? "\n" : "\r";
  const ready = (question: string) => term === "dumb" ? (output: string) => output.includes(question) && /(?:Type [\d, ]*\d or \d:|>)$/.test(output.trimEnd()) : waiting(question);
  try {
    f.input.write(`/plan ${REQUEST}${enter}`);
    await f.screen.until(ready("Build this plan?"));
    f.input.write(`3${term === "dumb" ? "\n" : ""}`);
    await f.screen.until(ready("What should change?"));
    const from = f.screen.output.length;
    f.input.write(`also test X${enter}`);
    await f.screen.until(output => ready("Build this plan?")(output.slice(from)));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain(`Request: ${REQUEST}`);
    expect(f.prompts[1]).toContain("User's change: also test X");
    expect(f.prompts[1]).toContain("Steps:\n1. Add a Limiter class in limiter.py\n2. Call it from app.py");
    const shown = f.screen.output.slice(from);
    expect(shown).toContain("  1. Call the limiter from the API");
    expect(shown).toContain("  1. X passes");
    expect(shown).toContain(term === "dumb" ? "  1 Stop" : "❯ 1. Stop");
    expect(shown).toContain(term === "dumb" ? "  2 Build" : "  2. Build");
    expect(shown).toContain(term === "dumb" ? "  3 Change the plan" : "  3. Change the plan");
    // No build occurred, and the rewrite still refuses edits and MCP writes.
    expect(shown).not.toContain("Built.");
    expect(f.gate.slice(5, 10).filter(({ reason }) => reason !== undefined)).toHaveLength(3);
    f.input.write(`2${term === "dumb" ? "\n" : ""}`);
    await f.screen.until(term === "dumb" ? output => output.includes("Built.") && />$/.test(output.trimEnd()) : idleAfter("Built."));
    expect(f.prompts).toHaveLength(3);
    expect(f.prompts[2]).toContain("Follow these steps in order:\n1. Call the limiter from the API");
    expect(f.prompts[2]).not.toContain("Follow these steps in order:\n1. Add a Limiter class");
    expect(f.app.getLastTaskResult()?.checklist).toEqual(["X passes"]);
  } finally {
    await f.close();
    if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous;
  }
}, 60_000);

test("drop steps 1 and 4 rewrites the plan, and another change uses the latest numbering", async () => {
  const original = "Steps:\n1. Add exports\n2. Keep API logging\n3. Keep the config\n4. Add a dashboard\n\nTests:\n- the API logs\n- the config loads";
  const revised = "Steps:\n1. Keep API logging\n2. Keep the config\n\nTests:\n- the API logs\n- the config loads";
  const final = "Steps:\n1. Keep API logging\n\nTests:\n- the API logs";
  const f = await fixture(true, { answer: original, rewrites: [revised, final] });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    for (const change of ["drop steps 1 and 4", "drop step 2"]) {
      f.input.write("3");
      await f.screen.until(output => waiting("What should change?")(output.slice(output.lastIndexOf("Build this plan?"))));
      const from = f.screen.output.length;
      f.input.write(`${change}\r`);
      await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
      expect(f.screen.output.slice(from)).toContain("  1. Keep API logging");
    }
    expect(f.prompts).toHaveLength(3);
    expect(f.prompts[1]).toContain("User's change: drop steps 1 and 4");
    expect(f.prompts[2]).toContain("Current plan:\n\nSteps:\n1. Keep API logging\n2. Keep the config");
    expect(f.prompts[2]).not.toContain("4. Add a dashboard");
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
    expect(f.prompts).toHaveLength(3);
    expect(f.screen.output).not.toContain("Built.");
  } finally { await f.close(); }
}, 60_000);

test("a failed rewrite prints the failure and never offers the old plan for building", async () => {
  const f = await fixture(true, { rewriteFails: true });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("3");
    await f.screen.until(waiting("What should change?"));
    const from = f.screen.output.length;
    f.input.write("also test X\r");
    await f.screen.until(idleAfter("[plan] The model failed while planning; nothing was built."));
    expect(f.prompts).toHaveLength(2);
    expect(f.screen.output.slice(from)).not.toContain("Build this plan?");
    expect(f.screen.output).not.toContain("Built.");
  } finally { await f.close(); }
}, 60_000);

test("a rewrite without numbered steps stops rather than building the old plan", async () => {
  const f = await fixture(true, { rewrites: ["No steps remain."] });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("3");
    await f.screen.until(waiting("What should change?"));
    const from = f.screen.output.length;
    f.input.write("drop all steps\r");
    await f.screen.until(idleAfter("nothing was built. Ask again, or send the request without /plan."));
    expect(f.screen.output.slice(from)).toContain("No steps remain.");
    expect(f.screen.output.slice(from)).not.toContain("Build this plan?");
    expect(f.prompts).toHaveLength(2);
  } finally { await f.close(); }
}, 60_000);

test("a change made during a rewrite is reported and kept in the build receipt", async () => {
  const f = await fixture(true, { rewriteWrites: true });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("3");
    await f.screen.until(waiting("What should change?"));
    const from = f.screen.output.length;
    f.input.write("also test X\r");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.screen.output.slice(from)).toContain("– Changed while planning: notes.txt");
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.app.getLastTaskResult()?.changedWhilePlanning).toEqual(["notes.txt"]);
  } finally { await f.close(); }
}, 60_000);

/** The newer answer, with the current header art quoted before the plan the way a model reading src/tui/banner.ts
 * might: it must not appear on screen a second time under the /plan line. */
const NEW_PLAN = [
  "Now:",
  "```",
  " ██████  █████  ███████ ██████  ███████ ██████ ",
  "```",
  "Title: A cleaner, animated header",
  "",
  "What you'll see:",
  "The ghost and the name in one colour, with a short fade-in.",
  "",
  "Steps:",
  "1. Write the tests first, then the change.",
  "2. Draw the header in the accent colour.",
  "",
  "Tests:",
  "- the header is drawn once",
  "",
  "Details:",
  "- src/tui/banner.ts: wordmarkHeader() takes a frame number",
].join("\n");

test("the plan screen hides only details until Ctrl+T and Build gets the rewritten whole plan", async () => {
  const rewrite = NEW_PLAN.replace("Draw the header in the accent colour.", "Draw a clearer header in the accent colour.");
  const f = await fixture(true, { answer: NEW_PLAN, rewrites: [rewrite] });
  try {
    const art = " ██████  █████  ███████ ██████  ███████ ██████ ";
    expect(f.screen.output.split(art).length - 1).toBe(1);
    f.input.write(`/plan how would I change the Casper at the top to look cleaner and animated\r`);
    await f.screen.until(waiting("Build this plan?"));
    const screen = f.screen.output;
    expect(screen).toContain("── Plan · A cleaner, animated header");
    expect(screen).toContain("What you'll see");
    expect(screen).toContain("  The ghost and the name in one colour, with a short fade-in.");
    expect(screen).toContain("  2. Draw the header in the accent colour.");
    expect(screen).toContain("Done means");
    expect(screen).toContain("1. the header is drawn once");
    expect(screen).toContain("Ctrl+T details · Ctrl+G edit");
    expect(screen).not.toContain("wordmarkHeader");
    expect(screen.split(art).length - 1).toBe(1);
    f.input.write("\x14");
    await f.screen.until((output) => output.includes("wordmarkHeader() takes a frame number"));
    expect(f.screen.output).toContain("Plan: details");
    f.input.write("3");
    await f.screen.until((output) => output.includes("Esc stops without building"));
    const from = f.screen.output.length;
    f.input.write("make the header clearer\r");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.screen.output.slice(from)).toContain("  2. Draw a clearer header in the accent colour.");
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).toContain("Building the plan (2 steps, 1 case).");
    expect(f.prompts[2]).toContain("1. Write the tests first, then the change.\n2. Draw a clearer header in the accent colour.");
    expect(f.prompts[2]).toContain("wordmarkHeader() takes a frame number");
    expect(f.prompts[2]).toContain("- the header is drawn once");
    expect(f.app.getLastTaskResult()?.checklist).toEqual(["the header is drawn once"]);
  } finally { await f.close(); }
}, 60_000);

test("a plan turn the model fails part way shows what it wrote before the failure, not nothing", async () => {
  const f = await fixture(true, { answer: "Plan:\n1. Add a Limiter class in limiter.py\n2. Call it fr", planFails: true });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(idleAfter("[plan] The model failed while planning; nothing was built."));
    const failed = f.screen.output.lastIndexOf("[plan] The model failed while planning");
    expect(f.screen.output.slice(0, failed)).toContain("Call it fr");
    expect(f.prompts).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);

test("a plan whose words say the build serves pages on this machine brings the service tool to the build; a plan that doesn't, doesn't", async () => {
  for (const [answer, offered] of [
    [`${PLAN}\nWhat you'll see: the card list page at http://localhost:8000, sortable by any column.\n`, true],
    [PLAN, false],
  ] as const) {
    const toolsSeen: string[][] = [];
    const f = await fixture(true, { answer, toolsSeen });
    try {
      // The request names no server: only the accepted plan does.
      f.input.write("/plan make my card tracker\r");
      await f.screen.until(waiting("Build this plan?"));
      f.input.write("2");
      await f.screen.until(idleAfter("Built."));
      expect({ answer, offered: toolsSeen.at(-1)?.includes("service") }).toEqual({ answer, offered });
    } finally { await f.close(); }
  }
}, 90_000);

test("the task after a build hears which accepted steps are still open and where the plan is; the one after that doesn't", async () => {
  const f = await fixture(true, { reportSteps: true });
  try {
    f.input.write("/plan Add a Limiter and call it from app.py\r");
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    const built = f.prompts.length;
    f.input.write("finish the rest\r");
    await f.screen.until(() => f.prompts.length === built + 1);
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts[built]).toMatch(/Open from the plan built earlier in this conversation \(\.casper\/plans\/[\w.-]+\.md\): 2\. Call it from app\.py \(not done: Needs an API decision\)\. They are part of the work when the person asks to finish it\./);
    f.input.write("and add a docstring\r");
    await f.screen.until(() => f.prompts.length === built + 2);
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts[built + 1]).not.toContain("Open from the plan");
  } finally { await f.close(); }
}, 90_000);

test("clear requests go directly to a plan; saves Markdown and keeps incomplete progress honest", async () => {
  const f = await fixture(true, { reportSteps: true });
  try {
    f.input.write("/plan Add a Limiter and call it from app.py\r");
    await f.screen.until(waiting("Build this plan?"));
    expect(f.prompts).toHaveLength(1);
    const files = (await readdir(path.join(f.project, ".casper/plans"))).filter(file => file.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d\d-\d\d-.+\.md$/);
    expect(await readFile(path.join(f.project, ".casper/plans", files[0]!), "utf8")).toContain("1. Add a Limiter class in limiter.py");
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).toContain("Step 2 of 2 · Call it from app.py");
    // The screen says the plan in one line, with the reason a step stopped, on the receipt card's row of what needs you;
    // /receipt lists every step.
    expect(f.screen.output).toMatch(/Open\s+Plan: 1 of 2 steps done \(model report\) — Needs an API decision; \/receipt lists them/);
    expect(f.screen.output).not.toContain("Plan checklist (model report, not verification)");
    f.input.write("/receipt\r");
    await f.screen.until(output => output.includes("2. Call it from app.py — not done: Needs an API decision"));
    expect(f.screen.output).toContain("Plan checklist (model report, not verification)");
    expect(f.screen.output).toContain("1. Add a Limiter class in limiter.py — done");
    expect(f.app.getLastTaskResult()?.planSteps?.map(step => step.status)).toEqual(["done", "not-done"]);
    expect(f.prompts[1]).toContain("Use plan_step to keep this accepted checklist current");
  } finally { await f.close(); }
}, 60_000);

const QUESTIONS = JSON.stringify({ questions: [
  { question: "Which screens?", options: [{ label: "Board" }, { label: "Board and calendar" }] },
  { question: "Sign-in?", options: [{ label: "None" }, { label: "Accounts" }] },
  { question: "Which look?", options: [{ label: "Quiet" }, { label: "Playful" }] },
] });
const SPEC = "Title: A task board\nGoal: Find tasks\nScreens: Board and calendar\nData: Tasks on this device, no accounts\nLook: Like Linear: dark, quiet\nFirst version:\n- Add and move tasks\nLater: Shared accounts\nDone means:\n- Tasks survive reload\n";

test("unclear requests ask 1–3 normal questions once, accept a typed answer, and use answers in the spec", async () => {
  const f = await fixture(true, { answer: QUESTIONS, rewrites: [SPEC] });
  try {
    f.input.write("/plan make an app for tasks\r");
    await f.screen.until(waiting("Which screens?"));
    expect(f.screen.output).toContain("Other — type your own answer");
    expect(f.screen.output).not.toContain("Build this plan?");
    f.input.write("2");
    await f.screen.until(waiting("Sign-in?"));
    f.input.write("1");
    await f.screen.until(waiting("Which look?"));
    f.input.write("3");
    await f.screen.until((output) => output.slice(output.lastIndexOf("Which look?")).includes("Other — type your own answer —"));
    f.input.write("like Linear, dark and quiet\r");
    await f.screen.until(waiting("Build this plan?"));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("Which screens?: Board and calendar");
    expect(f.prompts[1]).toContain("Sign-in?: None");
    expect(f.prompts[1]).toContain("Which look?: like Linear, dark and quiet");
    expect(f.screen.output).toContain("Board and calendar");
    expect(f.screen.output).toContain("Like Linear: dark, quiet");
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts[2]).toContain("Tasks on this device, no accounts");
    expect(f.prompts[2]).toContain("Board and calendar");
  } finally { await f.close(); }
}, 60_000);

test("a second question round is refused, and skipping a question never builds", async () => {
  for (const skip of [false, true]) {
    const one = JSON.stringify({ questions: [{ question: "Which screen?", options: [{ label: "Board" }, { label: "List" }] }] });
    const f = await fixture(true, { answer: one, rewrites: [one] });
    try {
      f.input.write("/plan improve the app\r");
      await f.screen.until(waiting("Which screen?"));
      f.input.write(skip ? "\x1b" : "1");
      await f.screen.until(skip ? idleAfter("Stopped without building.") : idleAfter("The answer had no numbered steps"));
      expect(f.prompts).toHaveLength(skip ? 1 : 2);
      expect(f.screen.output).not.toContain("Built.");
    } finally { await f.close(); }
  }
}, 60_000);

test("an empty project gets a spec without forced steps and nothing is created before Build", async () => {
  const f = await fixture(true, { empty: true, answer: SPEC });
  try {
    f.input.write("/plan a task board\r");
    await f.screen.until(waiting("Build this plan?"));
    expect(f.prompts[0]).toContain("This is a new-project/spec request");
    for (const heading of ["Goal", "Screens", "Data", "Look", "First version", "Later", "Done means"]) expect(f.screen.output).toContain(heading);
    expect(f.screen.output).not.toContain("no numbered steps");
    expect((await readdir(f.project)).filter(name => name !== ".casper")).toEqual([]);
    f.input.write("\r");
    await f.screen.until(idleAfter("Stopped without building."));
    expect(f.prompts).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);

test("a spec plan's build line counts its First version items as steps, as the build's checklist does", async () => {
  const spec = SPEC.replace("First version:\n- Add and move tasks\n", "First version:\n- Add and move tasks\n- Show a calendar\n");
  const f = await fixture(true, { empty: true, answer: spec });
  try {
    f.input.write("/plan a task board\r");
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).toContain("Building the plan (2 steps, 1 case).");
    expect(f.screen.output).not.toContain("(0 steps");
  } finally { await f.close(); }
}, 60_000);

test("Ctrl+G edits the saved Markdown, rereads it, shows it again, and Build uses the edit", async () => {
  const f = await fixture();
  let edited = "";
  f.app.terminal.editPlan = async file => { edited = file; await writeFile(file, "Title: Edited locally\nSteps:\n1. Use the new limit\nDone means:\n- limit is 42\n"); };
  try {
    f.input.write("/plan add a limiter\r");
    await f.screen.until(waiting("Build this plan?"));
    const from = f.screen.output.length;
    f.input.write("\x07");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)) && output.includes("Edited locally"));
    expect(edited).toContain(`${path.sep}.casper${path.sep}plans${path.sep}`);
    expect(f.prompts).toHaveLength(1);
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts[1]).toContain("Use the new limit");
    expect(f.prompts[1]).toContain("limit is 42");
  } finally { await f.close(); }
}, 60_000);

test("/plan lists recent saved plans and reopens without another model plan turn", async () => {
  const f = await fixture();
  try {
    f.input.write("/plan add a limiter\r");
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("\r");
    await f.screen.until(idleAfter("Stopped without building."));
    f.input.write("/plan\r");
    await f.screen.until(waiting("Reopen a plan?"));
    const from = f.screen.output.length;
    f.input.write("2");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.prompts).toHaveLength(1);
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("Add a Limiter class");
  } finally { await f.close(); }
}, 60_000);

test("NO_COLOR keeps the same plan sections without a frame", async () => {
  const old = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  const f = await fixture(true, { answer: SPEC });
  try {
    f.input.write("/plan make an app for tasks\r");
    await f.screen.until(waiting("Build this plan?"));
    expect(f.screen.output).toContain("Casper plan · A task board");
    expect(f.screen.output).toContain("Done means");
    expect(f.screen.output).not.toContain("── Plan");
    f.input.write("\r");
    await f.screen.until(idleAfter("Stopped without building."));
  } finally { await f.close(); if (old === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = old; }
}, 60_000);

test("reopening rereads edits made while the recent-plan picker is open; invalid files cannot build", async () => {
  const f = await fixture();
  try {
    f.input.write("/plan add a limiter\r");
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("\r"); await f.screen.until(idleAfter("Stopped without building."));
    const dir = path.join(f.project, ".casper/plans"), file = path.join(dir, (await readdir(dir)).find(file => file.endsWith(".md"))!);
    f.input.write("/plan\r"); await f.screen.until(waiting("Reopen a plan?"));
    await writeFile(file, "Title: External change\nSteps:\n1. Keep my external edit\nDone means: external case\n");
    let from = f.screen.output.length;
    f.input.write("2"); await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.screen.output.slice(from)).toContain("External change");
    expect(await readFile(file, "utf8")).toContain("Keep my external edit");
    f.input.write("\r"); await f.screen.until(output => idleAfter("Stopped without building.")(output.slice(from)));
    from = f.screen.output.length;
    f.input.write("/plan\r"); await f.screen.until(output => waiting("Reopen a plan?")(output.slice(from)));
    await writeFile(file, "Goal: undecided\n");
    from = f.screen.output.length;
    f.input.write("2"); await f.screen.until(output => idleAfter("Saved plan needs numbered Steps")(output.slice(from)));
    expect(f.screen.output.slice(from)).not.toContain("Build this plan?");
    expect(await readFile(file, "utf8")).toBe("Goal: undecided\n");
    expect(f.prompts).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);

test("an external edit at the Build picker requires review and a new explicit Build", async () => {
  const f = await fixture();
  try {
    f.input.write("/plan add a limiter\r"); await f.screen.until(waiting("Build this plan?"));
    const dir = path.join(f.project, ".casper/plans"), file = path.join(dir, (await readdir(dir)).find(file => file.endsWith(".md"))!);
    await writeFile(file, "Title: External change\nSteps:\n1. Keep my external edit\nDone means: external case\n");
    const from = f.screen.output.length;
    f.input.write("2"); await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.screen.output.slice(from)).toContain("review it before choosing Build again");
    expect(f.screen.output.slice(from)).toContain("External change");
    expect(f.prompts).toHaveLength(1);
    f.input.write("2"); await f.screen.until(idleAfter("Built."));
    expect(f.prompts[1]).toContain("Keep my external edit");
  } finally { await f.close(); }
}, 60_000);

const COLOR_PLAN = "Title: Colour regression\nGoal: Keep the rendered plan readable.\nWhat you'll see:\nA header above the notes.\n```text\n[Notes]  [All tags v]\n```\nSteps:\n1. Draw the header — src/tui/banner.ts\nDone means:\n- The header is visible\n";

/** Capture actual rich-terminal output, not a renderer with substitute styling callbacks. */
async function capturedPlan(noColor = false): Promise<string[]> {
  const previous = process.env.NO_COLOR;
  if (noColor) process.env.NO_COLOR = "1"; else delete process.env.NO_COLOR;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(true, { answer: COLOR_PLAN, columns: 202, homeConfig: "theme: high-contrast\n" });
    f.input.write("/plan add tags to notes, with a filter\r");
    await f.screen.until(waiting("Build this plan?"));
    const rows = f.screen.raw.replace(/\r\n?/g, "\n").split("\n");
    const start = rows.findIndex(row => Bun.stripANSI(row).startsWith(noColor ? "Casper plan · Colour regression" : "── Plan · Colour regression"));
    expect(start).toBeGreaterThanOrEqual(0);
    // The open box ends at its closing rule (which may carry the Ctrl+T footer).
    const end = rows.findIndex((row, index) => index > start && (noColor ? Bun.stripANSI(row).trimStart().startsWith("Build this plan?")
      : /^─+(?: Ctrl\+T details · Ctrl\+G edit ─)?$/.test(Bun.stripANSI(row).trim())));
    expect(end).toBeGreaterThan(start);
    return rows.slice(start, noColor ? end : end + 1);
  } finally {
    try { await f?.close(); }
    finally { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
  }
}


test("rendered rich plan rules use accent SGR 96, and nothing sits beside the plan", async () => {
  const rows = await capturedPlan();
  for (const row of [rows[0]!, rows.at(-1)!]) {
    const rule = ansiCells([row])[0]!.filter(cell => cell.char === "─");
    expect(rule.length).toBeGreaterThan(0);
    for (const cell of rule) expect(cell.foreground).toBe("96");
  }
  // An open box: a mouse copy of the plan takes no border (a mock-up keeps its own inner box).
  expect(rows.slice(1, -1).map(row => Bun.stripANSI(row)).join("\n")).not.toMatch(/^[│╭╰]/m);
}, 60_000);

test("rendered rich plan file paths after the step are dim even with the high-contrast theme", async () => {
  const rows = await capturedPlan();
  const row = rows.find(row => row.includes("Draw the header"))!;
  const paths = cellsFor(ansiCells([row]), "src/tui/banner.ts");
  expect(paths.every(cell => cell.dim)).toBe(true);
  expect(cellSnapshot([paths])).toBe('[dim]"src/tui/banner.ts"');
  expect(Bun.stripANSI(row).trimEnd()).toMatch(/1\. Draw the header  src\/tui\/banner.ts$/);
  // The rules are as wide as the 202-column window.
  expect(Bun.stringWidth(Bun.stripANSI(rows[0]!).trimEnd())).toBe(202);
}, 60_000);

test("rendered rich plan mock-up inner box borders and contents are dim", async () => {
  const rows = await capturedPlan();
  const art = rows.slice(rows.findIndex(row => row.includes("┌")), rows.findIndex(row => row.includes("└")) + 1);
  expect(art).toHaveLength(3);
  for (const row of art) {
    const inner = ansiCells([row])[0]!.filter(cell => cell.char.trim());
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.every(cell => cell.dim)).toBe(true);
  }
}, 60_000);

test("NO_COLOR keeps the actually rendered plan plain with no accent or dim escapes", async () => {
  const rows = await capturedPlan(true);
  const raw = rows.join("\n");
  // The terminal may reset SGR at row boundaries, but the plan must set no text attributes.
  for (const cell of ansiCells(rows).flat()) expect(cell).toMatchObject({ foreground: "default", background: "default", dim: false, bold: false });
  expect(Bun.stripANSI(raw)).not.toMatch(/^[╭│╰]/m);
  for (const text of ["Casper plan · Colour regression", "Goal", "What you'll see", "[Notes]  [All tags v]", "Steps", "src/tui/banner.ts", "Done means"]) expect(raw).toContain(text);
}, 60_000);

test("the rich plan regression captures real SGR escapes rather than only ANSI-stripped text", async () => {
  const raw = (await capturedPlan()).join("\n");
  expect(raw).not.toBe(Bun.stripANSI(raw));
  const cells = ansiCells(raw.split("\n"));
  for (const text of ["Plan · Colour regression", "Steps"]) expect(cellsFor(cells, text).every(cell => cell.foreground === "96")).toBe(true);
  expect(cellsFor(cells, "src/tui/banner.ts").every(cell => cell.dim)).toBe(true);
}, 60_000);

test("/plan with no saved plans says what to type, with an example", async () => {
  const f = await fixture(false);
  try {
    await f.app.runOnce("/plan", f.project);
    expect(f.plain()).toContain("Type /plan and then what you want, for example /plan add a --verbose flag to the CLI; the model plans first and nothing is built until you choose Build.");
    expect(f.prompts).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);

test("a plan's open question is a choice: 2 asks it, the answer revises the plan, and Esc there goes back to the plan", async () => {
  const asking = `${PLAN}\nOpen questions:\n- Where are the limits kept?\n`;
  const f = await fixture(true, { answer: asking, rewrites: [PLAN] });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    expect(f.screen.output).toMatch(/2\. Answer the question +type the answer; the model rewrites the plan/);
    expect(f.screen.output).toContain("3. Build");
    expect(f.screen.output).toContain("4. Change the plan");
    // Esc at the question returns to the plan's choices; nothing stops or rewrites.
    f.input.write("2");
    await f.screen.until(waiting("Esc goes back to the plan"));
    let from = f.screen.output.length;
    f.input.write("\x1b");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.prompts).toHaveLength(1);
    f.input.write("2");
    await f.screen.until(output => output.slice(from).includes("Esc goes back to the plan"));
    f.input.write("in config.yaml\r");
    from = f.screen.output.length;
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain('Answer to the open question "Where are the limits kept?": in config.yaml');
    // The rewritten plan has no open question, so the choices are back to Stop · Build · Change the plan.
    expect(f.screen.output.slice(from)).toContain("3. Change the plan");
    expect(f.screen.output.slice(from)).not.toContain("Answer the question");
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
  } finally { await f.close(); }
}, 60_000);

test("several open questions are asked one after another and the plan is rewritten once with every answer; empty leaves one open, Esc goes back", async () => {
  const asking = `${PLAN}\nOpen questions:\n- Where are the limits kept?\n- Should a blocked call wait or fail?\n- Who can change the limits?\n`;
  const f = await fixture(true, { answer: asking, rewrites: [PLAN] });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    expect(f.screen.output).toMatch(/2\. Answer the questions +type each of the 3 answers; the model rewrites the plan once/);
    // Esc at the second question: back to the plan's choices, nothing sent.
    f.input.write("2");
    await f.screen.until(waiting("Question 1 of 3"));
    f.input.write("in config.yaml\r");
    await f.screen.until(waiting("Question 2 of 3"));
    let from = f.screen.output.length;
    f.input.write("\x1b");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.prompts).toHaveLength(1);
    // All three, the second left empty: one rewrite with the two answers.
    f.input.write("2");
    await f.screen.until(output => waiting("Question 1 of 3")(output.slice(from)));
    f.input.write("in config.yaml\r");
    await f.screen.until(output => waiting("Question 2 of 3")(output.slice(from)));
    f.input.write("\r");
    await f.screen.until(output => waiting("Question 3 of 3")(output.slice(from)));
    from = f.screen.output.length;
    f.input.write("only admins\r");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain('Answers to the open questions:\n- "Where are the limits kept?": in config.yaml\n- "Who can change the limits?": only admins');
    expect(f.prompts[1]).not.toContain('"Should a blocked call wait or fail?":');
    expect(f.screen.output.slice(from)).toContain("3. Change the plan");
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
  } finally { await f.close(); }
}, 60_000);

test("a rewrite of a plan longer than the screen shows what changed and where the whole plan is, not every step again", async () => {
  const steps = Array.from({ length: 60 }, (_, index) => `${index + 1}. Build part ${index + 1} of the tracker`);
  const long = `Steps:\n${steps.join("\n")}\n\nTests:\n- the tracker opens\n`;
  const revised = `Steps:\n${[...steps.slice(0, 29), "30. Build part 30 with a date column", ...steps.slice(30), "61. Export every tab to Excel"].join("\n")}\n\nTests:\n- the tracker opens\n`;
  const f = await fixture(true, { answer: long, rewrites: [revised] });
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    expect(f.screen.output).toContain("Build part 1 of the tracker");
    f.input.write("3");
    await f.screen.until(waiting("What should change?"));
    const from = f.screen.output.length;
    f.input.write("add dates and the Excel export\r");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    const shown = f.screen.output.slice(from);
    expect(shown).toMatch(/Plan rewritten: 2 lines added, 1 removed · the whole plan:\s+\.casper\/plans\/[\w.-]+\.md/);
    expect(shown).toContain("Steps");
    expect(shown).toContain("+ 30. Build part 30 with a date column");
    expect(shown).toContain("- 30. Build part 30 of the tracker");
    expect(shown).toContain("+ 61. Export every tab to Excel");
    // A step that only moved down a number is not a change, and the rest is not printed again.
    expect(shown).not.toContain("Build part 31 of the tracker");
    expect(shown).not.toContain("Build part 1 of the tracker");
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
  } finally { await f.close(); }
}, 60_000);

test("a question at Change the plan is answered and the same plan's choices come back, with no rewrite", async () => {
  const f = await fixture();
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("3");
    await f.screen.until(waiting("What should change?"));
    expect(f.screen.output).toContain('Type a change ("drop step 2") or ask ("why step 3?")');
    const from = f.screen.output.length;
    f.input.write("why step 2?\r");
    await f.screen.until(output => waiting("Build this plan?")(output.slice(from)));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("asks a question about it");
    expect(f.prompts[1]).toContain("Question: why step 2?");
    expect(f.prompts[1]).toContain("1. Add a Limiter class in limiter.py");
    expect(f.prompts[1]).not.toContain("Rewrite the current plan");
    // The plan was not redrawn: the same choices follow the answer.
    expect(f.screen.output.slice(from)).not.toContain("── Plan");
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
  } finally { await f.close(); }
}, 60_000);

test("/plan on plans every request until /plan off, and the footer says PLAN while it is on", async () => {
  const f = await fixture();
  try {
    f.input.write("/plan on\r");
    await f.screen.until(output => output.includes("[plan] Plan mode on: every request gets a plan first. /plan off ends it."));
    await f.screen.until(output => output.includes("PLAN · /plan off"));
    f.input.write(`${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    expect(f.prompts[0]).toContain("The user asked you to plan before building");
    f.input.write("\r");
    await f.screen.until(idleAfter("[plan] Stopped without building."));
    f.input.write("/plan off\r");
    await f.screen.until(output => output.includes("[plan] Plan mode off."));
  } finally { await f.close(); }
}, 60_000);

/** An agent session copied off the screen: its own asks ("add…", "fix…") are what that session did, not this request. */
const TRANSCRIPT = [
  "● I'll add a rate limiter to the API, then add a /health endpoint, then add request logging.",
  "  ╭─ ◆ Changed in api: add_route ─────────────╮",
  "  │ { \"path\": \"/health\" }                    │",
  "  ╰───────────────────────────────────────────╯",
  "● Next I'll fix the failing test and also add a config file for the limits.",
  "  ⎿ 3 files changed",
  "❯ ran",
].join("\n");

test("a pasted terminal transcript doesn't make a checklist or the Big job line; the model still gets it", async () => {
  for (const typed of ["", "here is the handoff note: "]) {
    const f = await fixture();
    try {
      if (typed) f.input.write(typed);
      f.input.write(`\x1b[200~${TRANSCRIPT}\x1b[201~`);
      await f.screen.until((output) => output.includes("❯ ran"));
      f.input.write("\r");
      await f.screen.until(idleAfter("Built."));
      // This project turns the checklist on for every request: then it is asked about the typed words only.
      expect({ typed, bigJob: f.screen.output.includes("Big job"), asked: f.checklistAsked }).toEqual({ typed, bigJob: false, asked: typed ? [expect.stringContaining("here is the handoff note:")] : [] });
      expect(f.checklistAsked.join("")).not.toContain("add_route");
      expect(f.prompts[0]).toContain("Changed in api: add_route");
    } finally { await f.close(); }
  }
}, 120_000);

test("asked to build what a pasted transcript describes, the cases come from what was typed, not the transcript", async () => {
  const f = await fixture();
  try {
    f.input.write(`${REQUEST}: `);
    f.input.write(`\x1b[200~${TRANSCRIPT}\x1b[201~`);
    await f.screen.until((output) => output.includes("❯ ran"));
    f.input.write("\r");
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).toContain(HINT);
    expect(f.checklistAsked).toEqual([expect.stringContaining(REQUEST)]);
    expect(f.checklistAsked[0]).not.toContain("add_route");
  } finally { await f.close(); }
}, 60_000);

test("a terminal transcript is told from a pasted spec, list or snippet", () => {
  expect(isScreenTranscript(TRANSCRIPT)).toBe(true);
  expect(isScreenTranscript(DETAILED)).toBe(false);
  expect(isScreenTranscript("- add a cart\n- add plans\n- add reviews\n- keep it fast")).toBe(false);
  expect(isScreenTranscript("● one\n● two")).toBe(false);
  // A table in a long spec: a few bordered lines among many plain ones.
  expect(isScreenTranscript([DETAILED, "┌───┐", "│ a │", "└───┘", DETAILED, DETAILED].join("\n"))).toBe(false);
});

test("the docs say a pasted transcript makes no checklist and its asks don't count toward Big job", async () => {
  const read = async (file: string) => (await readFile(path.join(import.meta.dir, "..", "docs", file), "utf8")).replace(/\s+/g, " ");
  expect(await read("VERIFICATION.md")).toContain("so a pasted transcript alone makes no checklist, and the cases come only from what you typed around it.");
  expect(await read("TERMINAL_UX.md")).toContain("gets no line, and the asks in a pasted terminal transcript don't count.");
});
