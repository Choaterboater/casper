import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeModelSelectionOptions, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";
import { EventEmitter } from "node:events";

// The rich-surface path is gated on `TERM !== "dumb"`.
const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

/** A fake TTY that keeps the text without escape codes as it arrives, so waiting on it stays cheap while the
 * footer redraws during long check runs. `until` tests only the text written since the last wait began. */
function plainScreen() {
  let output = "";
  const waiters: Array<{ test: (output: string) => boolean; resolve: () => void }> = [];
  const writer = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(text: string) {
    output += Bun.stripANSI(text);
    for (const waiter of [...waiters]) if (waiter.test(output)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  } });
  return {
    writer,
    get output() { return output; },
    until(test: (output: string) => boolean): Promise<void> {
      if (test(output)) return Promise.resolve();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      // A wait that never ends fails with the screen, so a failure says what Casper showed instead.
      const timer = setTimeout(() => reject(new Error(`screen did not match; it ends with:\n${output.slice(-2500)}`)), 45_000);
      waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
      return promise;
    },
  };
}

interface Options {
  /** The model the conversation starts on. */
  start?: string;
  /** The reason role ("your big model"); unset when undefined. */
  reason?: string;
  /** Lines of ~/.casper/config.yaml. */
  homeConfig?: string;
  /** Context tokens the conversation holds, and the big model's window and input price. */
  tokens?: number;
  contextWindow?: number;
  price?: number;
  /** repair.maxAttempts in the project. */
  repairs?: number;
  /** A provider error on these prompt numbers (1-based). */
  failOn?: number[];
  /** What the model picker returns when Casper opens it. */
  pick?: string;
  /** Switching to the big model fails (its sign-in expired, say). */
  switchFails?: boolean;
}

/**
 * A project whose test check passes only once a prompt ran on fixture/big: every prompt writes the model it ran on
 * into model.txt, and the check requires the line "fixture/big".
 */
async function fixture(options: Options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-big-model-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  if (options.homeConfig) await writeFile(path.join(home, ".casper/config.yaml"), options.homeConfig);
  await writeFile(path.join(project, "calc.py"), "def add(a, b):\n    return a - b\n");
  // The check passes before the change, so its failures are the change's to repair.
  await writeFile(path.join(project, "model.txt"), "fixture/big\n");
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand("require-line:model.txt=fixture/big"))}\n`
    + "verification:\n  mode: auto\n  checklist: false\n" + (options.repairs !== undefined ? `repair:\n  maxAttempts: ${options.repairs}\n` : ""));
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  let current = options.start ?? "fixture/demo";
  const selections: RuntimeModelSelectionOptions[] = [];
  const promptModels: string[] = [];
  const roles: Record<string, string> = options.reason ? { reason: options.reason } : {};
  const session: RuntimeSession = {
    getStatus: () => ({ provider: current.split("/")[0], model: current.split("/")[1], auth: "configured" }),
    getState: () => ({ cwd: project, isStreaming: false }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    abort: async () => {}, setTools: () => {},
    getModelRoles: () => ({ ...roles }),
    setModelRole: async (role, selector) => { if (selector) roles[role] = selector; else delete roles[role]; return { ...roles }; },
    describeModel: (query) => {
      const target = query === "@reason" ? roles.reason : query;
      if (!target) return undefined;
      const [provider, id] = target.split("/");
      return { provider: provider!, id: id!, ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
        ...(options.price ? { inputCostPerMillion: options.price } : {}) };
    },
    getUsage: () => ({ context: { tokens: options.tokens ?? null, contextWindow: 128_000, percent: null },
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, messages: 1 }),
    selectModel: async (selection) => {
      selections.push({ ...(selection.picker ? { picker: "opened" } : { query: selection.query }), persist: selection.persist } as RuntimeModelSelectionOptions);
      const target = selection.picker ? options.pick! : selection.query === "@reason" ? roles.reason! : selection.query!;
      if (options.switchFails && selection.query === "@reason") throw new Error("no credentials for fixture");
      current = target;
      return { status: session.getStatus!(), selected: true, savedDefault: false };
    },
    prompt: async () => {
      promptModels.push(current);
      emit({ type: "assistant_response_start", provider: "fixture", model: current });
      if (options.failOn?.includes(promptModels.length)) { emit({ type: "error", message: "Provider returned an empty response" }); return; }
      await writeFile(path.join(project, "model.txt"), `${current}\n`);
      await writeFile(path.join(project, "calc.py"), `def add(a, b):\n    return a + b  # prompt ${promptModels.length}\n`);
      emit({ type: "assistant_text_delta", delta: "Done.\n" });
      emit({ type: "assistant_response_end", stopReason: "stop" });
    },
  };
  const runtime: AgentRuntime = { start: async () => session, dispose: async () => {} };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = plainScreen();
  const make = (tty: boolean) => new CasperApp({
    ...(tty ? { input, output: screen.writer } : { output: { write: (text: string) => { plainOutput += text; } } }),
    runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  let plainOutput = "";
  const text = (from = 0) => screen.output.slice(from).replaceAll("\r\n", "\n");
  const cleanup = async () => { input.destroy(); await removeTempDir(root); };
  return { project, home, selections, promptModels, roles, input, screen, text, make, plain: () => plainOutput, cleanup };
}

/** The question is on screen and ready for a key (the footer says so after the panel is drawn). */
const waiting = (question: string) => (output: string) => output.includes(question) && output.slice(output.lastIndexOf(question)).includes("? waiting for you");
const idle = (text: string) => /(?:↻ Casper tried|✓ Verified|– Checks passed|✗ Failed|– Not verified|– No files changed)[\s\S]*idle/.test(text);

test("at the repair limit Casper offers one more try on the big model; choosing it repairs there and switches back", async () => {
  const f = await fixture({ reason: "fixture/big", tokens: 48_000, price: 15 });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("fix the add function in calc.py\r");
    await f.screen.until(waiting("What now?"));
    const asked = f.text();
    expect(asked).toContain("test still fails after 3 repairs. What now?");
    expect(asked).toContain("Stop here");
    expect(asked).toContain("Retry with your big model");
    expect(asked).toContain("fixture/big reads this conversation (about 48k tokens, at least ≈ $0.72), then tries 1 more fix");
    expect(f.selections).toEqual([]);
    f.input.write("2");
    await f.screen.until((output) => /Back on fixture\/demo[\s\S]*idle/.test(output) && idle(output));
    const shown = f.text();
    expect(shown).toContain("↻ repair 4/4 on your big model fixture/big");
    expect(shown).toContain("[model] Back on fixture/demo for your next request.");
    expect(shown).toContain("↻ Casper tried 4 repairs (the last on your big model fixture/big)");
    expect(f.selections).toEqual([{ query: "@reason", persist: false }, { query: "fixture/demo", persist: false }]);
    expect(f.promptModels).toEqual(["fixture/demo", "fixture/demo", "fixture/demo", "fixture/demo", "fixture/big"]);
    expect(app.getLastTaskResult()?.bigModel).toEqual({ model: "fixture/big", attempts: 1 });
    expect(app.getLastTaskResult()?.verification?.repairModels).toEqual(["fixture/big"]);
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
}, 60_000);

test("Esc or Stop at the repair limit spends nothing more and keeps the receipt as it was", async () => {
  const f = await fixture({ reason: "fixture/big" });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("fix the add function in calc.py\r");
    await f.screen.until(waiting("What now?"));
    // Without a known size the offer names no price, only that it uses tokens.
    expect(f.text()).toContain("fixture/big reads this conversation (uses tokens), then tries 1 more fix");
    f.input.write("\x1b");
    await f.screen.until(idle);
    expect(f.text()).toContain("↻ Casper tried 3 repairs");
    expect(f.text()).not.toContain("big model fixture/big)");
    expect(f.selections).toEqual([]);
    expect(f.promptModels).toHaveLength(4);
    expect(app.getLastTaskResult()?.bigModel).toBeUndefined();
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
}, 60_000);

test("no offer when the conversation is already on the big model, or when it would not fit", async () => {
  for (const options of [{ start: "fixture/big", reason: "fixture/big" }, { reason: "fixture/big", tokens: 150_000, contextWindow: 100_000 }]) {
    const f = await fixture(options);
    const app = f.make(true);
    const interactive = app.runInteractive(f.project);
    try {
      await f.screen.until((output) => output.includes("idle"));
      f.input.write("fix the add function in calc.py\r");
      await f.screen.until((output) => /↻ Casper tried|✓ Verified|– Checks passed/.test(output));
      await f.screen.until(idle);
      expect(f.text()).not.toContain("What now?");
      if (options.tokens) expect(f.text()).toContain("– Your big model fixture/big can't hold this conversation (about 150k tokens), so it was not offered");
      expect(f.selections).toEqual([]);
    } finally {
      f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
    }
  }
}, 60_000);

test("a one-shot run never asks and never switches models on its own", async () => {
  const f = await fixture({ reason: "fixture/big", tokens: 48_000, price: 15 });
  const app = f.make(false);
  try {
    await app.runOnce("fix the add function in calc.py", f.project);
    expect(f.plain()).toContain("↻ Casper tried 3 repairs\n");
    expect(f.plain()).not.toContain("What now?");
    expect(f.plain()).not.toContain("big model");
    expect(f.selections).toEqual([]);
  } finally { await app.close(); await f.cleanup(); }
}, 60_000);

test("repair.bigModelLastTry runs only the last repair on the big model, without asking, and switches back", async () => {
  const f = await fixture({ reason: "fixture/big", homeConfig: "repair:\n  bigModelLastTry: true\n" });
  const app = f.make(false);
  try {
    await app.runOnce("fix the add function in calc.py", f.project);
    expect(f.plain()).toContain("↻ repair 3/3 on your big model fixture/big");
    expect(f.plain()).not.toContain("↻ repair 2/3 on your big model");
    expect(f.plain()).toContain("[model] Back on fixture/demo for your next request.");
    expect(f.plain()).toContain("↻ Casper tried 3 repairs (the last on your big model fixture/big)");
    expect(f.plain()).not.toContain("What now?");
    expect(f.selections).toEqual([{ query: "@reason", persist: false }, { query: "fixture/demo", persist: false }]);
    expect(f.promptModels).toEqual(["fixture/demo", "fixture/demo", "fixture/demo", "fixture/big"]);
  } finally { await app.close(); await f.cleanup(); }
}, 60_000);

test("repair.bigModelLastTry with no big model set says so once", async () => {
  const f = await fixture({ homeConfig: "repair:\n  bigModelLastTry: true\n" });
  const app = f.make(false);
  try {
    await app.runOnce("fix the add function in calc.py", f.project);
    const notice = "[model] repair.bigModelLastTry is on but no big model is set. Use /model big <provider/model>.";
    expect(f.plain()).toContain(notice);
    expect(f.plain()).toContain("↻ repair 3/3\n");
    expect(f.selections).toEqual([]);
  } finally { await app.close(); await f.cleanup(); }
}, 60_000);

test("/model big sets and clears the reason role, and /model roles names it your big model", async () => {
  const f = await fixture();
  const app = f.make(false);
  try {
    await app.runOnce("/model big fixture/huge", f.project);
    expect(f.roles).toEqual({ reason: "fixture/huge" });
    expect(f.plain()).toContain(" reason    fixture/huge (your big model)");
    await app.runOnce("/model big clear", f.project);
    expect(f.roles).toEqual({});
    expect(f.plain()).toContain(" reason    not configured (your big model)");
    expect(f.selections).toEqual([]);
  } finally { await app.close(); await f.cleanup(); }
});

test("\"The model failed again\" offers the big model, which goes on there and then switches back", async () => {
  // No repairs: the proof would otherwise ask the model for a test and meet the repair limit's own question.
  const f = await fixture({ reason: "fixture/big", failOn: [1, 2], repairs: 0 });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("fix the add function in calc.py\r");
    await f.screen.until(waiting("The model failed again. What now?"));
    // The label and its words say the model does it; no "(uses tokens)" tag repeats that.
    expect(f.text()).toContain("go on from where it stopped on fixture/big");
    expect(f.text()).not.toContain("on fixture/big (uses tokens)");
    f.input.write("3");
    await f.screen.until((output) => /Back on fixture\/demo[\s\S]*idle/.test(output) && idle(output));
    expect(f.text()).toContain("[model] Trying again on your big model fixture/big.");
    expect(f.promptModels.slice(0, 3)).toEqual(["fixture/demo", "fixture/demo", "fixture/big"]);
    expect(f.selections.slice(0, 2)).toEqual([{ query: "@reason", persist: false }, { query: "fixture/demo", persist: false }]);
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
}, 60_000);

test("with no big model set, Retry opens the picker for this repair only; No keeps it unsaved and never calls it your big model", async () => {
  const f = await fixture({ pick: "fixture/big" });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("fix the add function in calc.py\r");
    await f.screen.until(waiting("What now?"));
    expect(f.text()).toContain("Retry with a bigger model");
    f.input.write("2");
    await f.screen.until(waiting("Use fixture/big as your big model from now on?"));
    f.input.write("1");
    await f.screen.until((output) => /Back on fixture\/demo[\s\S]*idle/.test(output) && idle(output));
    const shown = f.text();
    expect(shown).toContain("↻ repair 4/4 on fixture/big\n");
    expect(shown).toContain("↻ Casper tried 4 repairs (the last on fixture/big)");
    expect(shown).not.toContain("your big model fixture/big");
    expect(f.roles).toEqual({});
    expect(f.selections).toEqual([{ picker: "opened", persist: false }, { query: "fixture/demo", persist: false },
      { query: "fixture/big", persist: false }, { query: "fixture/demo", persist: false }] as never);
    expect(app.getLastTaskResult()?.bigModel).toEqual({ model: "fixture/big", attempts: 1, oneOff: true });
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
}, 60_000);

test("a model picked at the repair limit is saved as your big model on Yes, and is not tried when it can't hold the conversation", async () => {
  const saved = await fixture({ pick: "fixture/big" });
  const app = saved.make(true);
  const interactive = app.runInteractive(saved.project);
  try {
    await saved.screen.until((output) => output.includes("idle"));
    saved.input.write("fix the add function in calc.py\r");
    await saved.screen.until(waiting("What now?"));
    saved.input.write("2");
    await saved.screen.until(waiting("Use fixture/big as your big model from now on?"));
    saved.input.write("2");
    await saved.screen.until((output) => /Back on fixture\/demo[\s\S]*idle/.test(output) && idle(output));
    expect(saved.roles).toEqual({ reason: "fixture/big" });
    expect(saved.text()).toContain("[model] Saved fixture/big as your big model.");
    expect(saved.text()).toContain("↻ repair 4/4 on your big model fixture/big");
  } finally {
    saved.input.write("/exit\r"); await interactive; await app.close(); await saved.cleanup();
  }
  const small = await fixture({ pick: "fixture/big", tokens: 150_000, contextWindow: 100_000 });
  const second = small.make(true);
  const running = second.runInteractive(small.project);
  try {
    await small.screen.until((output) => output.includes("idle"));
    small.input.write("fix the add function in calc.py\r");
    await small.screen.until(waiting("What now?"));
    small.input.write("2");
    await small.screen.until(idle);
    expect(small.text()).not.toContain("from now on?");
    expect(small.text()).toContain("– fixture/big can't hold this conversation (about 150k tokens), so Casper stopped here");
    expect(small.promptModels).not.toContain("fixture/big");
    expect(second.getLastTaskResult()?.bigModel).toBeUndefined();
  } finally {
    small.input.write("/exit\r"); await running; await second.close(); await small.cleanup();
  }
}, 90_000);

test("when the switch to the big model fails, Casper says so instead of quietly trying on the same model", async () => {
  const f = await fixture({ reason: "fixture/big", failOn: [1, 2], repairs: 0, switchFails: true });
  const app = f.make(true);
  const interactive = app.runInteractive(f.project);
  try {
    await f.screen.until((output) => output.includes("idle"));
    f.input.write("fix the add function in calc.py\r");
    await f.screen.until(waiting("The model failed again. What now?"));
    f.input.write("3");
    await f.screen.until((output) => output.includes("trying again on the current model"));
    expect(f.text()).toContain("[model] Casper could not switch to your big model fixture/big; trying again on the current model.");
    await f.screen.until(idle);
    expect(f.promptModels.slice(0, 3)).toEqual(["fixture/demo", "fixture/demo", "fixture/demo"]);
  } finally {
    f.input.write("/exit\r"); await interactive; await app.close(); await f.cleanup();
  }
}, 60_000);
