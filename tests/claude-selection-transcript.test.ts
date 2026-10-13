import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { CasperApp } from "../src/app";
import { runSlashCommand, type CommandHost } from "../src/app/commands";
import { updateFooter } from "../src/app/footer";
import { RuntimeEventView } from "../src/app/events";
import { explainModelError } from "../src/runtime/model-errors";
import type { RuntimeModelSelectionOptions, RuntimeStatus } from "../src/runtime/types";
import { asksBeforeShell, describeSandbox } from "../src/sandbox/manager";
import { formatReceipt, type TaskResult } from "../src/task/result";
import { renderBanner } from "../src/tui/banner";
import { formatRuntimeStatus } from "../src/tui/format";
import { TerminalSurface } from "../src/tui/surface";
import { InteractiveTerminal } from "../src/tui/terminal";
import type { ProjectContext } from "../src/project/context";

// Synthetic reproduction of the reported selection/error transcript; no account or API calls.
const initial: RuntimeStatus = { provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "xhigh", auth: "configured" };
const selected: RuntimeStatus = { provider: "anthropic", model: "claude-sonnet-5-5", thinkingLevel: "high", auth: "configured",
  selectionSource: "conversation", defaultModel: { provider: "anthropic", id: "claude-sonnet-5-5" } };
const extraUsage = `400 {"error":{"message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}`;
const sandboxReason = "off unless you turn it on: /sandbox on, or sandbox: on in ~/.casper/config.yaml";
const failed: TaskResult = { execution: "failed", changedPaths: [], modelError: "credits", sandbox: { held: false, reason: sandboxReason } };

async function select(query?: string) {
  let status = initial;
  let output = "";
  const calls: RuntimeModelSelectionOptions[] = [];
  const session = { getStatus: () => status, selectModel: async (options: RuntimeModelSelectionOptions) => {
    calls.push(options);
    status = query?.startsWith("claude-subscription/")
      ? { ...selected, provider: "claude-subscription", defaultModel: { provider: "claude-subscription", id: selected.model! } }
      : selected;
    return { status, selected: true, savedDefault: options.persist !== false };
  } };
  const host = { closing: false, interactive: false, subagents: { isBusy: false }, output: { write: (text: string) => { output += text; } },
    ensureRuntime: async () => session } as unknown as CommandHost;
  await runSlashCommand(host, `/model${query ? ` ${query}` : ""}`);
  return { output, status: session.getStatus(), calls };
}

function providerError() {
  let output = "";
  const terminal = { rich: true, write() {}, endAssistant() {}, setWork() {}, setSteps() {}, writeFold() {} } as never;
  const events = new RuntimeEventView(terminal, { write: (text: string) => { output += text; } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
  });
  events.handle({ type: "assistant_response_end", stopReason: "error", errorMessage: extraUsage });
  return { output, step: events.lastStep() };
}

function receipt() {
  let output = "";
  const terminal = Object.assign(Object.create(InteractiveTerminal.prototype), {
    color: false, surface: { write: (text: string) => { output += text; } },
  }) as InteractiveTerminal;
  terminal.writeResult(formatReceipt(failed, { surface: "interactive" }));
  return output.split("\n");
}

test("reported case: shell is off by default unless /sandbox on is used", () => {
  expect(describeSandbox({ kind: "default" }).split(" · ")[0]).toBe("not sandboxed (off unless you turn it on: /sandbox on)");
});

test("reported case: Casper asks before AI shell commands that change things", () => {
  expect(asksBeforeShell({ kind: "default" })).toBe(true);
  expect(describeSandbox({ kind: "default" }).split(" · ")[1]).toBe("Casper asks before AI shell commands that change things");
});

test("reported case: the initial Codex model and xhigh effort start on the first request", () => {
  expect(formatRuntimeStatus(undefined, `${initial.provider}/${initial.model} · effort ${initial.thinkingLevel}`))
    .toBe(" model     openai-codex/gpt-6.1-sol · effort xhigh (starts on your first request; /model to change)");
});

test("reported case: /model changes the model and the banner lists the four commands", async () => {
  const result = await select();
  expect(result.calls).toHaveLength(1);
  expect(result.status).not.toEqual(initial);
  const context = { info: { root: "fixture" }, model: { project: { name: "fixture" } }, profileName: "default" } as ProjectContext;
  expect(renderBanner(context, { interactive: true })).toContain("\n /help · /status · /login · /model\n");
});

test("reported case: selecting the direct Sonnet route reports anthropic and effort high", async () => {
  expect((await select()).output.split("\n")[0]).toBe(" model     anthropic/claude-sonnet-5-5 · effort high");
});

test("reported case: auth status says configured is not a connection test", async () => {
  expect((await select()).output.split("\n")[1]).toBe(" auth      credentials configured (not a connection test)");
});

test("reported case: selection reports the conversation and the saved Sonnet default", async () => {
  expect((await select()).output.split("\n")[2]).toBe(" selection conversation · Casper default anthropic/claude-sonnet-5-5");
});

test("reported case: a selected model is saved as the default for new conversations", async () => {
  const result = await select();
  expect(result.calls[0]!.persist).toBe(true);
  expect(result.output).toContain("[model] Selected and saved as the Casper default for new conversations.\n");
});

test("reported case: the next-request notice names the selected anthropic route", async () => {
  expect((await select()).output).toContain("[model] The next request sends this conversation's context to anthropic.\n");
});

test("reported case: an extra-usage error no longer claims every Casper Claude request is billed off-plan", () => {
  expect(providerError().output).toBe("[error] Your Claude sign-in is out of extra usage. Next: add more at claude.ai/settings/usage, or /model to pick another model. Ctrl+T shows the provider's message.\n");
  expect(providerError().output).not.toContain("Casper's Claude use is billed as extra usage, not your plan's included use");
  expect(explainModelError(extraUsage)?.cause).toBe("credits");
});

test("reported case: Ctrl+T retains the provider's original message", () => {
  expect(providerError().output).toContain("Ctrl+T shows the provider's message.");
  expect(providerError().step).toEqual({ title: "Provider error", body: extraUsage, diff: false });
});

test("reported case: failed summary says the model failed before changes and no files changed", () => {
  expect(receipt().slice(0, 2)).toEqual(["▌ ✗ Failed — the model run failed before changing any files", "▌ – No files changed"]);
});

test("reported case: the failed summary keeps the explicit unsandboxed-shell explanation", () => {
  expect(receipt()[2]).toBe("▌ – Shell commands and checks were not sandboxed (off unless you turn it on: /sandbox on, or sandbox: on in ~/.casper/config.yaml)");
});

test("reported case: a real credit failure keeps add credits or choose another model as its next step", () => {
  expect(receipt().at(-1)).toBe("▌ – Next: add credits on the provider's site, or /model to pick another model");
});

test("reported case: the idle status bar keeps folder, direct Sonnet route, effort and estimated context", () => {
  const surface = new TerminalSurface({ input: new PassThrough(), output: { write() {}, columns: 200, rows: 24 }, color: false, onEOF() {} }, () => {}, () => {});
  try {
    updateFooter({
      projectContext: { info: { name: "fixclaude", root: process.cwd() } }, homeDir: () => "fixture-home",
      terminal: { setTitle() {}, setBadge() {}, setUpdate() {}, setStatus: (text: string, cwd: string) => surface.setStatus(text, cwd) },
      session: { getStatus: () => selected, getUsage: () => ({ context: { percent: 1 } }) },
      observations: { spent: () => ({ tokens: 0, cost: 0 }) }, spentBefore: { tokens: 0, cost: 0 }, subagents: { runs: () => [] },
      commandActive: false,
    } as unknown as CasperApp);
    expect(surface.footerLine(200)).toBe("type / for commands │ fixclaude │ anthropic/claude-sonnet-5-5 · high │ ctx 1%~ │ idle");
  } finally { surface.close(); }
});

test("direct Anthropic selection points to the same model through Claude Code's plan login", async () => {
  expect((await select()).output).toContain("[model] anthropic is the direct API route; for your Claude Code plan login use /model claude-subscription/claude-sonnet-5-5.\n");
});

test("explicit subscription selection saves the subscription route and does not silently pick anthropic", async () => {
  const result = await select("claude-subscription/claude-sonnet-5-5");
  expect(result.calls[0]!.query).toBe("claude-subscription/claude-sonnet-5-5");
  expect(result.status).toMatchObject({ provider: "claude-subscription", model: "claude-sonnet-5-5", thinkingLevel: "high",
    defaultModel: { provider: "claude-subscription", id: "claude-sonnet-5-5" } });
  expect(result.output).toContain("[model] The next request sends this conversation's context to claude-subscription.");
  expect(result.output).not.toContain("anthropic is the direct API route");
});
