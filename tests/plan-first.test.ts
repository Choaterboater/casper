import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { bundledFlows, findFlow } from "../src/flows/catalog";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeStartOptions } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

// The rich-surface path is gated on `TERM !== "dumb"`.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

const REQUEST = "add a rate limiter to the API, then add a /health endpoint, then add request logging, and also add a config file for the limits";
const CASES = ["limit(0) throws", "the 6th call is rejected"];
const PLAN = "Plan:\n1. Add a Limiter class in limiter.py\n2. Call it from app.py\n\nTests:\n- limit(0) throws\n- a /health request answers 200\n";

/** A fake TTY that keeps the text without escape codes as it arrives. */
function plainScreen() {
  let output = "";
  const waiters: Array<{ test: (output: string) => boolean; resolve: () => void }> = [];
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 40, write(text: string) {
    output += Bun.stripANSI(text).replaceAll("\r\n", "\n");
    for (const waiter of [...waiters]) if (waiter.test(output)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  return { writer, get output() { return output; }, until(test: (output: string) => boolean): Promise<void> {
    if (test(output)) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error(`screen did not match; it ends with:\n${output.slice(-2500)}`)), 25_000);
    waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
    return promise;
  } };
}

/** The fake model: on a plan turn it tries an edit and two shell commands through Casper's gate, then answers
 * with PLAN; otherwise it writes a file. */
async function fixture(tty = true, setup: { planWrites?: boolean; planCode?: boolean; answer?: string; rewrites?: string[]; rewriteFails?: boolean; rewriteWrites?: boolean; planFails?: boolean; homeConfig?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-plan-first-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "app.py"), "print('app')\n");
  if (setup.homeConfig) { await mkdir(path.join(home, ".casper"), { recursive: true }); await writeFile(path.join(home, ".casper/config.yaml"), setup.homeConfig); }
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  checklist: true\n"
    + (setup.planCode ? `  mode: auto\nverify:\n  test: ${JSON.stringify(`"${process.execPath}" -e "process.exit(0)"`)}\n` : ""));
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const prompts: string[] = [];
  const gate: Array<{ tool: string; reason: string | undefined }> = [];
  let checklistCalls = 0;
  let planCalls = 0;
  let options: RuntimeStartOptions | undefined;
  const runtime: AgentRuntime = {
    start: async (started) => {
      options = started;
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        setTools: () => {}, abort: async () => {},
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        complete: async () => { checklistCalls++; return { text: JSON.stringify(CASES), usage: { tokens: 10, estimatedCost: 0 } }; },
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
          else { await writeFile(path.join(project, "limiter.py"), `# ${prompts.length}\n`); emit({ type: "assistant_text_delta", delta: "Built.\n" }); }
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    dispose: async () => {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode() {} });
  const screen = plainScreen();
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
  return { app, input, screen, prompts, gate, project, plain: () => plain, checklistCalls: () => checklistCalls, close: async () => {
    await app.close(); input.destroy();
    if (interactive) await interactive;
    await removeTempDir(root);
  } };
}

const waiting = (question: string) => (output: string) => output.includes(question) && output.slice(output.lastIndexOf(question)).includes("? waiting for you");
const idleAfter = (marker: string) => (output: string) => output.includes(marker) && /idle\s*$/.test(output.slice(output.lastIndexOf(marker)));

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
    expect(f.screen.output).toContain("Casper plan");
    expect(f.screen.output).toContain("  1. Add a Limiter class in limiter.py");
    expect(f.screen.output).toContain("Tests: 2 cases\n  1. limit(0) throws\n  2. a /health request answers 200");
    expect(f.screen.output).not.toContain("Esc stops without building");
    expect(f.screen.output.split("Add a Limiter class in limiter.py").length - 1).toBe(1);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain(findFlow(bundledFlows(), "plan-first")!.body.trim());
    const reasons = Object.fromEntries(f.gate.map(({ tool, reason }) => [tool.split(" ")[0] + (tool.includes("rm ") ? " rm" : tool.includes("ls ") ? " ls" : ""), reason]));
    expect(reasons.edit).toStartWith("Not run: Planning only: Casper blocks file changes until you choose Build");
    expect(reasons["bash rm"]).toStartWith("Not run: Planning only");
    expect(reasons["bash ls"]).toBeUndefined();
    expect(reasons.mcp).toStartWith("Not run: Planning only");
    expect(reasons.read).toBeUndefined();
    expect(f.screen.output).toContain("1 Stop");
    expect(f.screen.output).toContain("2 Build");
    expect(f.screen.output).toContain("3 Change the plan");
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
    await f.screen.until((output) => output.split("Built.").length - 1 === count && /idle\s*$/.test(output));
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
    await f.screen.until((output) => /idle\s*$/.test(output) && output.includes("plan-first"));
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
    expect(f.plain()).toContain("  1. Add a Limiter class in limiter.py");
    expect(f.plain()).toContain("Tests: 2 cases\n  1. limit(0) throws\n  2. a /health request answers 200");
    // The answer is shown once, as Casper's plan, not also as the model streamed it.
    expect(f.plain().split("Add a Limiter class in limiter.py").length - 1).toBe(1);
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
    expect(f.screen.output.slice(f.screen.output.lastIndexOf("Built."))).toContain("– Changed while planning: notes.txt");
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
        expect(f.screen.output).toContain("  1. Add a Limiter class in limiter.py");
        expect(f.screen.output).toContain("Tests: 2 cases\n  1. limit(0) throws\n  2. a /health request answers 200");
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
    expect(f.screen.output.slice(from)).toContain("  1. Add a Limiter class in limiter.py");
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
    expect(shown).toContain("1 Stop");
    expect(shown).toContain("2 Build");
    expect(shown).toContain("3 Change the plan");
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
    expect(screen).toContain("Casper plan · A cleaner, animated header");
    expect(screen).toContain("What you'll see");
    expect(screen).toContain("  The ghost and the name in one colour, with a short fade-in.");
    expect(screen).toContain("  2. Draw the header in the accent colour.");
    expect(screen).toContain("Tests: 1 case\n  1. the header is drawn once");
    expect(screen).toContain("Ctrl+T shows the details");
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

test("/plan with no request says in one sentence what to type, with an example", async () => {
  const f = await fixture(false);
  try {
    await f.app.runOnce("/plan", f.project);
    expect(f.plain()).toContain("Type /plan and then what you want, for example /plan add a --verbose flag to the CLI; the model plans first and nothing is built until you choose Build.");
    expect(f.prompts).toHaveLength(0);
  } finally { await f.close(); }
}, 60_000);
