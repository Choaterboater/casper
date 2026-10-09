import { expect, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { errorText, explainModelError, refreshFailure, signInExpired } from "../src/runtime/model-errors";
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

test("a sign-in that can't be renewed is an expired sign-in with /login as the next step; other refresh failures get a few words", () => {
  const expired = 'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://example.invalid/v1/oauth/token; details=Error: HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}; stack=Error\n    at post (file:///example/x.js:1:1)';
  expect(signInExpired(expired)).toBe(true);
  expect(signInExpired("Refresh token not found or invalid")).toBe(true);
  expect(signInExpired("500 Internal server error")).toBe(false);
  expect(explainModelError(expired)).toEqual({ cause: "key", line: "Your sign-in expired and could not be renewed. Next: /login to sign in again." });
  expect(explainModelError("OAuth refresh failed for anthropic")?.cause).toBe("key");
  expect(errorText(new Error("OAuth refresh failed for anthropic", { cause: new Error("invalid_grant") }))).toBe("OAuth refresh failed for anthropic: invalid_grant");
  expect(errorText("plain")).toBe("plain");
  const cases: Array<[string, string]> = [
    [expired, "login"], ["401 Unauthorized", "login"], ["fetch failed", "can't reach it"], ["getaddrinfo ENOTFOUND example.invalid", "can't reach it"],
    ["Request timed out", "timed out"], ["The operation was aborted due to timeout", "timed out"], ["429 Too Many Requests", "busy, try later"],
    ["HTTP request failed. status=502; url=https://example.invalid/x?token=abc", "HTTP 502"], ["500 Internal server error", "HTTP 500"],
    ["catalog file is not JSON\n    at parse (file:///example/x.js:1:1)", "catalog file is not JSON"], ["bad reply url=https://example.invalid/?k=1", "bad reply"],
    ["x".repeat(100), `${"x".repeat(59)}…`], ["", "unknown error"],
  ];
  expect(cases.map(([message]) => refreshFailure(message))).toEqual(cases.map(([, words]) => words));
});

test("Pi wraps every refresh failure in the same words: offline, a timeout or a 5xx is not an expired sign-in", () => {
  const wrap = (details: string) => errorText(new Error("OAuth refresh failed for anthropic",
    { cause: new Error(`Anthropic token refresh request failed. url=https://example.invalid/v1/oauth/token; details=${details}`) }));
  const offline = wrap("TypeError: fetch failed; cause=Error: getaddrinfo ENOTFOUND example.invalid");
  const timeout = wrap("TimeoutError: The operation was aborted due to timeout");
  const down = wrap("Error: HTTP request failed. status=503; url=https://example.invalid/v1/oauth/token; body=busy");
  const rejected = wrap('Error: HTTP request failed. status=401; body={"error":"unauthorized"}');
  for (const message of [offline, timeout, down]) expect(signInExpired(message)).toBe(false);
  expect([offline, timeout, down, rejected].map(refreshFailure)).toEqual(["can't reach it", "timed out", "HTTP 503", "login"]);
  expect(explainModelError(offline)?.cause).toBe("offline");
  expect(explainModelError(timeout)?.cause).toBe("offline");
  expect(explainModelError(down)).toBeUndefined();
  expect(explainModelError(rejected)?.line).toBe("Your sign-in expired and could not be renewed. Next: /login to sign in again.");
  expect(refreshFailure("OAuth refresh failed for kimi-coding: Kimi Code token refresh failed with status 500")).toBe("HTTP 500");
  expect(refreshFailure("OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (400): bad")).toBe("login");
  expect(refreshFailure("OAuth refresh failed for xai: xAI OAuth token refresh failed (HTTP 401)")).toBe("login");
  expect(refreshFailure("OAuth refresh failed for openai-codex: OpenAI Codex token refresh error: fetch failed")).toBe("can't reach it");
  // A wrapper with no cause anyone can read still has only one fix.
  expect(explainModelError("OAuth refresh failed for anthropic: Anthropic token refresh returned invalid JSON")?.line)
    .toBe("Your sign-in could not be renewed. Next: /login to sign in again.");
});

test("each cause has one plain next step", () => {
  expect(explainModelError("401 Unauthorized")?.line).toBe("The provider rejected the sign-in (the key is wrong or expired). Next: /login to sign in again.");
  expect(explainModelError("402 Payment Required")?.line).toBe("The provider says the account is out of credits. Next: add credits on the provider's site, or /model to pick another model.");
  expect(explainModelError("429 Too Many Requests")?.line).toBe("The provider is limiting requests right now. Next: wait a minute, then ask again.");
  expect(explainModelError("fetch failed")?.line).toBe("Can't reach the provider. Next: check your internet connection, then ask again.");
  expect(explainModelError("403 Forbidden")?.line).toBe("The provider refused the request. Next: check the key with /login, or /model to pick a model your account can use.");
  expect(explainModelError("prompt is too long")?.line).toBe("The conversation is too long for this model. Next: /compact, then ask again.");
});

test("a Claude sign-in out of extra usage says where to add more, or to pick another model", () => {
  const message = `400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_0"}`;
  expect(explainModelError(message)).toEqual({ cause: "credits",
    line: "Your Claude sign-in is out of extra usage (Casper's Claude use is billed as extra usage, not your plan's included use). Next: add more at claude.ai/settings/usage, or /model to pick another model." });
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
  expect(next("key", "interactive")).toBe("– Next: /login to sign in again");
  expect(next("key", "one-shot")).toBe("– Next: run casper and type /login");
  expect(next("credits", "interactive")).toBe("– Next: add credits on the provider's site, or /model to pick another model");
  expect(next("rate", "interactive")).toBe("– Next: wait a minute, then ask again");
  expect(next("rate", "one-shot")).toBe("– Next: wait a minute, then run it again");
  expect(next("offline", "interactive")).toBe("– Next: check your internet connection, then ask again");
  expect(next("refused", "interactive")).toBe("– Next: check the key with /login, or /model to pick a model your account can use");
  expect(next("refused", "one-shot")).toBe("– Next: run casper and type /login to check the key, or casper --model <provider/id> \"…\" to use another model");
  expect(next("context", "interactive")).toBe("– Next: /compact, then ask again");
  expect(next("model", "interactive")).toBe("– Next: /model to try another model, then ask again");
  expect(next(undefined, "interactive")).toBe("– Next: /model to try another model, then ask again");
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

test("a provider that rejects tools is said plainly, without the raw text in the first line", () => {
  const plain = "can't use tools, so it can't edit files or run commands here. Pick another model with /model, or use it for questions only.";
  expect(explainModelError('400 {"error":{"message":"registry.ollama.ai/library/gemma:2b does not support tools"}}')).toEqual({ cause: "tools", line: `gemma:2b ${plain}` });
  expect(explainModelError("400 tools are not supported")?.line).toBe(`This model ${plain}`);
  expect(explainModelError("Tool use is not supported by this model")?.cause).toBe("tools");
  expect(explainModelError("400 llama3 does not support tools")?.line).toBe(`llama3 ${plain}`);
  expect(explainModelError("400 llama3 does not support tools")?.line).not.toContain("400");
});
