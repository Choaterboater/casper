import { expect, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { explainModelError } from "../src/runtime/model-errors";
import { formatReceipt } from "../src/task/result";
import { removeTempDir } from "./support/temp-dir";

test("provider errors are sorted by cause", () => {
  const cases: Array<[string, string | undefined]> = [
    ['401 {"error":{"message":"No auth credentials found","code":401}}', "key"],
    ["Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com", "key"],
    ["authentication_error: invalid x-api-key", "key"],
    ['402 {"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402}}', "credits"],
    ["429 You exceeded your current quota, please check your plan and billing details.", "credits"],
    ["Your credit balance is too low to access the Anthropic API.", "credits"],
    ["429 Rate limit exceeded: free-models-per-min.", "rate"],
    ["529 overloaded_error: Overloaded", "rate"],
    ["fetch failed", "offline"],
    ["getaddrinfo ENOTFOUND openrouter.ai", "offline"],
    ["Connection error.", "offline"],
    ["This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.", "context"],
    ["prompt is too long: 210000 tokens > 200000 maximum", "context"],
    ['404 {"error":{"message":"No endpoints found for acme/gone-model.","code":404}}', "model"],
    ["The model `gpt-9` does not exist or you do not have access to it.", "model"],
    ["403 Forbidden", "refused"],
    ['403 {"error":{"message":"This model is not available in your region."}}', "refused"],
    ["500 Internal server error", undefined],
  ];
  expect(cases.map(([message]) => explainModelError(message)?.cause as string | undefined)).toEqual(cases.map(([, cause]) => cause));
});

test("each cause has one plain next step", () => {
  expect(explainModelError("401 Unauthorized")?.line).toBe("The provider rejected the sign-in (the key is wrong or expired). Next: /login to sign in again.");
  expect(explainModelError("402 Payment Required")?.line).toBe("The provider says the account is out of credits. Next: add credits on the provider's site, or /model to pick another model.");
  expect(explainModelError("429 Too Many Requests")?.line).toBe("The provider is limiting requests right now. Next: wait a minute, then ask again.");
  expect(explainModelError("fetch failed")?.line).toBe("Can't reach the provider. Next: check your internet connection, then ask again.");
  expect(explainModelError("403 Forbidden")?.line).toBe("The provider refused the request. Next: check the key with /login, or /model to pick a model your account can use.");
  expect(explainModelError("prompt is too long")?.line).toBe("The conversation is too long for this model. Next: /compact, then ask again.");
});

function view(rich: boolean) {
  let text = "";
  const terminal = { rich, write() {}, endAssistant() {}, setActivity() {}, setSteps() {} } as never;
  const events = new RuntimeEventView(terminal, { write: (chunk: string) => { text += chunk; } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
  });
  return { events, text: () => text };
}

test("the [error] line says the cause in plain words; Ctrl+T shows the provider's own words", () => {
  const rich = view(true);
  rich.events.handle({ type: "assistant_response_end", stopReason: "error", errorMessage: "401: rejected key sk-or-v1-0000000000000000" });
  expect(rich.text()).toBe("[error] The provider rejected the sign-in (the key is wrong or expired). Next: /login to sign in again. Ctrl+T shows the provider's message.\n");
  expect(rich.events.lastStep()).toEqual({ title: "Provider error", body: "401: rejected key <redacted>", diff: false });
  // A plain terminal has no Ctrl+T: the provider's words go on the next line.
  const plain = view(false);
  plain.events.handle({ type: "error", message: "429 Too Many Requests" });
  expect(plain.text()).toBe("[error] The provider is limiting requests right now. Next: wait a minute, then ask again.\n  provider: 429 Too Many Requests\n");
  // A cause Casper can't name keeps the provider's text.
  const other = view(true);
  other.events.handle({ type: "error", message: "500 Internal server error" });
  expect(other.text()).toBe("[error] 500 Internal server error\n");
});

test("the receipt's next step follows the cause, not always another model", () => {
  const next = (modelError: Parameters<typeof formatReceipt>[0]["modelError"], surface: "interactive" | "one-shot") =>
    formatReceipt({ execution: "failed", changedPaths: [], ...(modelError ? { modelError } : {}) }, { surface }).split("\n").at(-1);
  expect(next("key", "interactive")).toBe("• Next: /login to sign in again");
  expect(next("key", "one-shot")).toBe("• Next: run casper and type /login");
  expect(next("credits", "interactive")).toBe("• Next: add credits on the provider's site, or /model to pick another model");
  expect(next("rate", "interactive")).toBe("• Next: wait a minute, then ask again");
  expect(next("rate", "one-shot")).toBe("• Next: wait a minute, then run it again");
  expect(next("offline", "interactive")).toBe("• Next: check your internet connection, then ask again");
  expect(next("refused", "interactive")).toBe("• Next: check the key with /login, or /model to pick a model your account can use");
  expect(next("refused", "one-shot")).toBe("• Next: run casper and type /login to check the key, or casper --model <provider/id> \"…\" to use another model");
  expect(next("context", "interactive")).toBe("• Next: /compact, then ask again");
  expect(next("model", "interactive")).toBe("• Next: /model to try another model, then ask again");
  expect(next(undefined, "interactive")).toBe("• Next: /model to try another model, then ask again");
});

test("a run that fails on a rejected key ends with /login as the next step", async () => {
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { CasperApp } = await import("../src/app");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-error-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  const listeners = new Set<(event: never) => void>();
  const runtime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: (event: never) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => { for (const listener of listeners) listener({ type: "error", message: "401 Unauthorized" } as never); },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({ output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime as never, sessionHomeDir: home,
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  try {
    await app.runOnce("Fix the bug in add", project);
    expect(app.getLastTaskResult()?.modelError).toBe("key");
    expect(output).toContain("Next: /login to sign in again");
    expect(output).not.toContain("try another model");
  } finally { await app.close(); await removeTempDir(root); }
});

test("a model error thrown to the prompt loop gets the plain cause line too", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { PassThrough } = await import("node:stream");
  const { CasperApp } = await import("../src/app");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-model-throw-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project); await writeFile(path.join(project, "notes.txt"), "not empty\n");
  const runtime = {
    async start() {
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: () => () => {},
        abort: async () => {}, setTools: () => {},
        // No error event: the provider's error only arrives as the thrown error.
        prompt: async () => { throw new Error("401 Unauthorized"); },
      };
    },
    async dispose() {},
  };
  const input = new PassThrough();
  let output = "";
  const shown = Promise.withResolvers<void>();
  const app = new CasperApp({ input, output: { write: (text: string) => { output += text; if (output.includes("[error]")) shown.resolve(); } },
    runtimeFactory: () => runtime as never, sessionHomeDir: home,
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  const interactive = app.runInteractive(project);
  try {
    input.write("fix the bug\n");
    await shown.promise;
    await Bun.sleep(50);
    expect(output).toContain("[error] The provider rejected the sign-in (the key is wrong or expired). Next: /login to sign in again.");
    expect(output).not.toContain("[error] 401 Unauthorized");
    input.end();
    await interactive;
  } finally { await app.close(); await removeTempDir(root); }
});
