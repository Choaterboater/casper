import { expect, test } from "bun:test";
import { loginClaudeCode } from "../src/runtime/claude-login";
import { signInWays } from "../src/runtime/pi-auth";
import { loginProvider, runLogin, type CommandHost } from "../src/app/commands";
import type { RuntimeAuthenticationResult } from "../src/runtime/types";
import type { LoginDisplay } from "../src/tui/login";

function display(signal = new AbortController().signal) {
  const notes: string[] = [];
  const urls: string[] = [];
  const io = { signal, setNote: (text: string) => notes.push(text), wait: (_title: string, text: string) => notes.push(text),
    browser: (url: string) => urls.push(url), privateInput: async () => "fixture-code" } as unknown as LoginDisplay;
  return { io, notes, urls };
}
const plan = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
const empty = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });

function host(result: RuntimeAuthenticationResult) {
  let output = "";
  let modelPicks = 0;
  const app = { interactive: true, terminal: { exclusiveHost: () => ({}) }, subagents: { isBusy: false },
    acquireRuntime: async () => ({ authenticate: async () => result }),
    session: { selectDefaultModel: async () => { modelPicks++; } }, output: { write: (text: string) => { output += text; } },
    updateFooter() {}, loginProvider: undefined, signedIn: false } as unknown as CommandHost;
  return { app, output: () => output, picks: () => modelPicks };
}

test("login offers a distinct Claude Code plan option and an explicit command alias", () => {
  expect(signInWays("claude-subscription")).toEqual([{ id: "claude-subscription:claude_code", provider: "claude-subscription",
    method: "claude_code", label: "Claude Code plan · sign in with your browser" }]);
  expect(signInWays("anthropic").every(way => way.label.startsWith("Anthropic API"))).toBe(true);
  expect(loginProvider("claude-subscription")).toBe("claude-subscription");
  expect(loginProvider("claude")).toBe("claude-subscription");
});

test("missing native Claude Code gives installation instructions without launching anything", async () => {
  const ui = display();
  expect(await loginClaudeCode(ui.io, { executable: () => undefined })).toMatchObject({ claudeCode: true, status: "failed", effect: "none",
    detail: expect.stringContaining("https://code.claude.com/docs/en/setup") });
});

test("an already cancelled login does not discover or launch Claude Code", async () => {
  const controller = new AbortController(); controller.abort();
  expect(await loginClaudeCode(display(controller.signal).io, { executable: () => { throw new Error("must not run"); } }))
    .toMatchObject({ status: "cancelled", effect: "none" });
});

test("an existing subscription is verified without repeating browser login or copying credentials", async () => {
  const ui = display();
  expect(await loginClaudeCode(ui.io, { executable: () => "synthetic-claude", status: async () => plan,
    launch: () => { throw new Error("must not launch"); } })).toEqual({ status: "saved", claudeCode: true });
  expect(ui.notes.join("\n")).toContain("No credentials are copied");
});

test("signed-out login verifies the plan after native login completes", async () => {
  let checks = 0;
  let launched = 0;
  const ui = display();
  expect(await loginClaudeCode(ui.io, { executable: () => "synthetic-claude",
    status: async () => ++checks === 1 ? { loggedIn: false } : plan,
    launch: (executable, env) => {
      expect(executable).toBe("synthetic-claude");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      launched++;
      return { stdout: empty(), stderr: empty(), exited: Promise.resolve(0), write() {}, kill() {} };
    } })).toEqual({ status: "saved", claudeCode: true });
  expect(checks).toBe(2); expect(launched).toBe(1);
});

test("a zero-exit native login with API-key or unsupported-plan status is not a subscription success", async () => {
  for (const state of [{ ...plan, authMethod: "api_key" }, { ...plan, subscriptionType: "free" }, { loggedIn: false }]) {
    expect(await loginClaudeCode(display().io, { executable: () => "synthetic-claude", status: async () => state,
      launch: () => ({ stdout: empty(), stderr: empty(), exited: Promise.resolve(0), write() {}, kill() {} }) }))
      .toMatchObject({ status: "failed", effect: "unknown", reason: "provider", claudeCode: true });
  }
});

test("cancellation terminates the native process and reports that its own login may have changed", async () => {
  const controller = new AbortController();
  let killed = 0;
  const result = await loginClaudeCode(display(controller.signal).io, { executable: () => "synthetic-claude", status: async () => ({ loggedIn: false }),
    launch: () => {
      queueMicrotask(() => controller.abort());
      return { stdout: empty(), stderr: empty(), exited: new Promise<number>(() => {}), write() {}, kill() { killed++; } };
    } });
  expect(result).toMatchObject({ status: "cancelled", effect: "unknown", claudeCode: true });
  expect(killed).toBe(1);
});

test("a stalled native flow times out, terminates and never exposes its diagnostics", async () => {
  let killed = 0;
  const ui = display();
  const result = await loginClaudeCode(ui.io, { executable: () => "synthetic-claude", status: async () => ({ loggedIn: false }), timeoutMs: 10,
    launch: () => ({ stdout: empty(), stderr: empty(), exited: new Promise<number>(() => {}), write() {}, kill() { killed++; } }) });
  expect(result).toMatchObject({ status: "failed", effect: "unknown", detail: "Claude Code sign-in timed out or stopped." });
  expect(killed).toBe(1);
});

test("successful plan login marks its provider but does not change the conversation model or default", async () => {
  const fixture = host({ status: "saved", claudeCode: true });
  expect(await runLogin(fixture.app)).toBe(true);
  expect(fixture.app.loginProvider).toBe("claude-subscription");
  expect(fixture.picks()).toBe(0);
  expect(fixture.output()).toContain("No credentials were copied to Casper");
  expect(fixture.output()).toContain("Model and defaults unchanged");
});

test("cancelled, failed and refresh-pending plan logins never select or save a model", async () => {
  for (const result of [{ status: "cancelled", effect: "unknown", claudeCode: true },
    { status: "failed", effect: "unknown", reason: "provider", claudeCode: true },
    { status: "saved-needs-refresh", claudeCode: true }] as RuntimeAuthenticationResult[]) {
    const fixture = host(result);
    expect(await runLogin(fixture.app)).toBe(false);
    expect(fixture.picks()).toBe(0);
    expect(fixture.app.loginProvider).toBeUndefined();
    expect(fixture.output()).toContain("Model and defaults unchanged");
    expect(fixture.output()).not.toContain("no credential saved");
  }
});
