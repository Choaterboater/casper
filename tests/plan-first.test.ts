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
    output += Bun.stripANSI(text);
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
async function fixture(tty = true, setup: { planWrites?: boolean; planCode?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-plan-first-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, "app.py"), "print('app')\n");
  await writeFile(path.join(project, ".casper/project.yaml"), "verification:\n  checklist: true\n"
    + (setup.planCode ? `  mode: auto\nverify:\n  test: ${JSON.stringify(`"${process.execPath}" -e "process.exit(0)"`)}\n` : ""));
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const prompts: string[] = [];
  const gate: Array<{ tool: string; reason: string | undefined }> = [];
  let checklistCalls = 0;
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
            // A change Casper's gate cannot see (a tool that says nothing about writing, say).
            if (setup.planWrites) await writeFile(path.join(project, "notes.txt"), "written while planning\n");
            if (setup.planCode) await writeFile(path.join(project, "app.py"), "print('broken while planning')\n");
            emit({ type: "assistant_text_delta", delta: PLAN });
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
  const plainTerminal = process.env.TERM === "dumb";
  const interactive = tty ? app.runInteractive(project) : undefined;
  if (tty) await screen.until((output) => output.includes(process.env.TERM === "dumb" ? "> " : "idle"));
  return { app, input, screen, prompts, gate, project, plain: () => plain, checklistCalls: () => checklistCalls, close: async () => {
    if (interactive) { if (plainTerminal) input.end(); else input.write("/exit\r"); await interactive; }
    await app.close(); input.destroy(); await removeTempDir(root);
  } };
}

const waiting = (question: string) => (output: string) => output.includes(question) && output.slice(output.lastIndexOf(question)).includes("? waiting for you");
const idleAfter = (marker: string) => (output: string) => output.includes(marker) && /idle\s*$/.test(output.slice(output.lastIndexOf(marker)));

test("plan first is one numbered choice folded into the checklist panel; the plan turn refuses changes; after the editor, 2 builds the plan", async () => {
  const f = await fixture();
  try {
    f.input.write(`${REQUEST}\r`);
    await f.screen.until(waiting("Suggested: plan first — this asks for 4 things"));
    const panel = f.screen.output;
    expect(panel).toContain("1 Plan first");
    expect(panel).toContain("2 Just build");
    expect(panel).toContain("with these 2 cases: limit(0) throws; the 6th call is rejected");
    expect(panel).toContain("3 Edit the cases first");
    // One panel before work: the checklist editor did not open first.
    expect(panel).not.toContain("Esc starts without a checklist");
    expect(f.prompts).toHaveLength(0);
    f.input.write("1");
    await f.screen.until(waiting("Build this plan?"));
    // One summary line and the choice: the plan is not printed a second time in an editor.
    expect(f.screen.output).toContain("Casper plan: 2 steps, 2 cases to test.");
    expect(f.screen.output).not.toContain("Esc stops without building");
    expect(f.screen.output.split("Add a Limiter class in limiter.py").length - 1).toBe(1);
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain(findFlow(bundledFlows(), "plan-first")!.body.trim());
    expect(f.prompts[0]).toContain("- limit(0) throws");
    const reasons = Object.fromEntries(f.gate.map(({ tool, reason }) => [tool.split(" ")[0] + (tool.includes("rm ") ? " rm" : tool.includes("ls ") ? " ls" : ""), reason]));
    expect(reasons.edit).toStartWith("Not run: Planning only: Casper blocks file changes until you choose Build");
    expect(reasons["bash rm"]).toStartWith("Not run: Planning only");
    expect(reasons["bash ls"]).toBeUndefined();
    expect(reasons.mcp).toStartWith("Not run: Planning only");
    expect(reasons.read).toBeUndefined();
    expect(f.screen.output).toContain("1 Stop");
    expect(f.screen.output).toContain("2 Build");
    expect(f.screen.output).toContain("3 Edit the plan");
    // A call blocked while planning reads "not run", never "failed".
    expect(f.screen.output).not.toMatch(/✗ (?:bash|edit|write)[^\n]*failed/);
    expect(f.prompts).toHaveLength(1);
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("Casper plan (the user read and accepted it). Follow these steps in order:\n1. Add a Limiter class in limiter.py\n2. Call it from app.py");
    expect(f.prompts[1]).toContain("- limit(0) throws\n- a /health request answers 200");
    expect(f.prompts[1]).not.toContain('Casper flow "plan-first"');
    // The build turn runs without the plan gate, and there was no second checklist call.
    expect(f.gate.slice(5).every(({ reason }) => reason === undefined)).toBe(true);
    expect(f.checklistCalls()).toBe(1);
    expect(f.app.getLastTaskResult()?.checklist).toEqual(["limit(0) throws", "a /health request answers 200"]);
  } finally { await f.close(); }
}, 60_000);

test("Just build sends the listed cases unedited, with no plan turn", async () => {
  const f = await fixture();
  try {
    f.input.write(`${REQUEST}\r`);
    await f.screen.until(waiting("Suggested: plan first"));
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain("- limit(0) throws\n- the 6th call is rejected");
    expect(f.prompts[0]).not.toContain("plan-first");
    expect(f.gate.every(({ reason }) => reason === undefined)).toBe(true);
  } finally { await f.close(); }
}, 60_000);

test("Esc in the plan editor stops without building", async () => {
  const f = await fixture();
  try {
    f.input.write(`${REQUEST}\r`);
    await f.screen.until(waiting("Suggested: plan first"));
    f.input.write("1");
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

test("/suggestions off plan-first stops the question for a big vague request", async () => {
  const f = await fixture();
  try {
    f.input.write("/suggestions off plan-first\r");
    await f.screen.until((output) => /idle\s*$/.test(output) && output.includes("plan-first"));
    f.input.write(`${REQUEST}\r`);
    await f.screen.until(idleAfter("Built."));
    expect(f.screen.output).not.toContain("Suggested: plan first");
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).not.toContain('Casper flow "plan-first"');
  } finally { await f.close(); }
}, 60_000);

test("/plan in a run that cannot ask shows the plan and builds nothing", async () => {
  const f = await fixture(false);
  try {
    await f.app.runOnce(`/plan ${REQUEST}`, f.project);
    expect(f.plain()).toContain("Casper plan: 2 steps, 2 cases to test.");
    expect(f.plain()).toContain("  Add a Limiter class in limiter.py");
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
        expect(f.screen.output).toContain("Casper plan: 2 steps, 2 cases to test.");
        expect(f.screen.output).toContain("  1 Stop · nothing is built");
        expect(f.screen.output).toContain("  2 Build · the model builds these steps and tests these cases\n");
        f.input.write(`${answer}\n`);
        if (builds) await f.screen.until((output) => output.includes("Built."));
        else await f.screen.until((output) => output.includes("[plan] Stopped without building."));
        expect(f.prompts).toHaveLength(builds ? 2 : 1);
      } finally { await f.close(); }
    }
  } finally { process.env.TERM = term; }
}, 90_000);

test("Edit the plan opens the plan's lines, Enter asks again, and a plan you changed is listed before it builds", async () => {
  const f = await fixture();
  try {
    f.input.write(`/plan ${REQUEST}\r`);
    await f.screen.until(waiting("Build this plan?"));
    f.input.write("3");
    await f.screen.until((output) => output.includes("Enter goes on to 1 Stop · 2 Build · edit lines · Esc stops without building"));
    f.input.write("\r");
    await f.screen.until((output) => output.split("Build this plan?").length > 2 && waiting("Build this plan?")(output));
    expect(f.prompts).toHaveLength(1);
    f.input.write("2");
    await f.screen.until(idleAfter("Built."));
    expect(f.prompts).toHaveLength(2);
    // Not edited here, so only the one-line "Building the plan" follows.
    expect(f.screen.output).toContain("Building the plan (2 steps, 2 cases).");
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
