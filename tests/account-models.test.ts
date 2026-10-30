import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime, VERSION as ENGINE_VERSION } from "@earendil-works/pi-coding-agent";
import { applyLatestAccountModels, CODEX_MODELS_URL, forgetAccountModels, parseCodexModels, startAccountModels } from "../src/runtime/account-models";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
const lifetimes: AbortController[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
  forgetAccountModels();
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A ChatGPT sign-in's token as the engine stores it: a JWT naming the account (placeholder values, not a secret). */
const CODEX_TOKEN = `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" } })}.fixture-signature`;
const COPILOT_TOKEN = "tid=fixture;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;fixture-not-a-secret";

/** A real engine catalog with a ChatGPT and a Copilot plan sign-in that don't need renewing. */
async function engine(signIns: { codex?: boolean; copilot?: boolean } = { codex: true, copilot: true }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-account-models-")); dirs.push(dir);
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  await writeFile(path.join(dir, "auth.json"), JSON.stringify({
    ...signIns.codex ? { "openai-codex": { type: "oauth", access: CODEX_TOKEN, refresh: "fixture-refresh", expires, accountId: "acct-fixture" } } : {},
    ...signIns.copilot ? { "github-copilot": { type: "oauth", access: COPILOT_TOKEN, refresh: "fixture-github", expires, availableModelIds: ["gpt-6.1-sol", "gpt-6-luna"] } } : {},
  }), { mode: 0o600 });
  const catalog = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), refreshOnCreate: false });
  await catalog.refresh({ allowNetwork: false });
  return catalog;
}

const codexBody = (slugs: Array<[string, string]>) => ({ models: slugs.map(([slug, visibility]) => ({ slug, visibility, display_name: slug })) });

/** The account endpoints as fakes, and what was sent to them. */
function accounts(codex: () => Response, copilot: () => Response = () => Response.json({ data: [] })) {
  const sent: Array<{ url: string; headers: Headers }> = [];
  return { sent, fetch: async (url: string, init?: RequestInit) => {
    sent.push({ url, headers: new Headers(init?.headers) });
    return url.startsWith(CODEX_MODELS_URL) ? codex() : copilot();
  } };
}

function lifetime() { const controller = new AbortController(); lifetimes.push(controller); return controller.signal; }
const codexIds = (catalog: ModelRuntime) => catalog.getAvailableSnapshot().filter((model) => model.provider === "openai-codex").map((model) => model.id).sort();

test("the ChatGPT account's own list decides which Codex models show; ones it offers that the engine doesn't know are named", async () => {
  const catalog = await engine({ codex: true });
  const before = codexIds(catalog);
  expect(before).toContain("gpt-5.6-luna");
  const host = accounts(() => Response.json(codexBody([["gpt-6.1-sol", "list"], ["gpt-6-luna", "list"], ["gpt-reserve", "hide"], ["gpt-9-fixture", "list"]])));
  const live = startAccountModels(catalog, lifetime(), { fetch: host.fetch, env: {} });
  await live.ready;
  expect(codexIds(catalog)).toEqual(["gpt-6-luna", "gpt-6.1-sol"]);
  expect(live.lists().get("openai-codex")).toMatchObject({ ids: ["gpt-6.1-sol", "gpt-6-luna", "gpt-9-fixture"], unknown: ["gpt-9-fixture"] });
  // The engine's own identity and version, the account named, and the token only to OpenAI.
  const [request] = host.sent;
  expect(request!.url).toBe(`${CODEX_MODELS_URL}?client_version=${ENGINE_VERSION}`);
  expect(request!.headers.get("originator")).toBe("pi");
  expect(request!.headers.get("chatgpt-account-id")).toBe("acct-fixture");
  expect(request!.headers.get("authorization")).toBe(`Bearer ${CODEX_TOKEN}`);
  // A model chosen by name that the account doesn't offer isn't there to pick.
  expect(catalog.getModel("openai-codex", "gpt-5.6-luna")).toBeUndefined();
  expect(catalog.getModel("openai-codex", "gpt-6.1-sol")?.api).toBe("openai-codex-responses");
});

test("a read that fails keeps the list read before, says why in plain words, and never repeats the token", async () => {
  const catalog = await engine({ codex: true });
  let answer = () => Response.json(codexBody([["gpt-6.1-sol", "list"]]));
  const host = accounts(() => answer());
  const live = startAccountModels(catalog, lifetime(), { fetch: host.fetch, env: {}, freshMs: 0 });
  await live.ready;
  answer = () => new Response(`upstream said ${CODEX_TOKEN}`, { status: 500 });
  await live.refresh();
  expect(codexIds(catalog)).toEqual(["gpt-6.1-sol"]);
  const list = live.lists().get("openai-codex")!;
  expect(list.problem).toBe("OpenAI answered HTTP 500");
  expect(JSON.stringify(list)).not.toContain("fixture-signature");
  answer = () => new Response("not json", { status: 200 });
  await live.refresh();
  expect(live.lists().get("openai-codex")!.problem).toBe("OpenAI sent a list Casper can't read");
  expect(codexIds(catalog)).toEqual(["gpt-6.1-sol"]);
});

test("an account list naming none of the engine's models hides nothing", async () => {
  const catalog = await engine({ codex: true });
  const before = codexIds(catalog);
  const live = startAccountModels(catalog, lifetime(), { fetch: accounts(() => Response.json(codexBody([["gpt-9-fixture", "list"]]))).fetch, env: {} });
  await live.ready;
  expect(codexIds(catalog)).toEqual(before);
  expect(live.lists().get("openai-codex")).toMatchObject({ unknown: ["gpt-9-fixture"] });
});

test("Copilot: the account's usable models (picker on, tools, not disabled) the engine doesn't know are named; the engine filters the rest", async () => {
  const catalog = await engine({ copilot: true });
  const host = accounts(() => Response.json({ models: [] }), () => Response.json({ data: [
    { id: "gpt-6.1-sol", model_picker_enabled: true, policy: { state: "enabled" }, capabilities: { type: "chat", supports: { tool_calls: true } } },
    { id: "gpt-9-fixture", model_picker_enabled: true, capabilities: { type: "chat", supports: { tool_calls: true } } },
    { id: "gpt-4o-fixture", model_picker_enabled: false, capabilities: { type: "chat", supports: { tool_calls: true } } },
    { id: "embedding-fixture", model_picker_enabled: false, capabilities: { type: "embeddings", supports: {} } },
    { id: "gpt-8-off", model_picker_enabled: true, policy: { state: "disabled" }, capabilities: { type: "chat", supports: { tool_calls: true } } },
  ] }));
  const live = startAccountModels(catalog, lifetime(), { fetch: host.fetch, env: {} });
  await live.ready;
  expect(live.lists().get("github-copilot")).toMatchObject({ ids: ["gpt-6.1-sol", "gpt-9-fixture"], unknown: ["gpt-9-fixture"] });
  const copilot = host.sent.find((request) => !request.url.startsWith(CODEX_MODELS_URL))!;
  expect(copilot.url).toBe("https://api.individual.githubcopilot.com/models");
  expect(copilot.headers.get("authorization")).toBe(`Bearer ${COPILOT_TOKEN}`);
  expect(copilot.headers.get("copilot-integration-id")).toBe("vscode-chat");
});

test("offline, or without a plan sign-in, nothing is asked; /model reads again only once the list is old", async () => {
  const signedOut = await engine({});
  const host = accounts(() => Response.json(codexBody([["gpt-6.1-sol", "list"]])));
  await startAccountModels(signedOut, lifetime(), { fetch: host.fetch, env: {} }).ready;
  const catalog = await engine({ codex: true });
  await startAccountModels(catalog, lifetime(), { fetch: host.fetch, env: { CASPER_OFFLINE: "1" } }).ready;
  expect(host.sent).toEqual([]);
  const live = startAccountModels(catalog, lifetime(), { fetch: host.fetch, env: {} });
  await live.ready;
  await live.refresh();
  expect(host.sent).toHaveLength(1);
});

test("a helper's catalog takes the list the main session read; Codex's list is parsed by visibility", async () => {
  const main = await engine({ codex: true });
  await startAccountModels(main, lifetime(), { fetch: accounts(() => Response.json(codexBody([["gpt-6.1-sol", "list"]]))).fetch, env: {} }).ready;
  const helper = await engine({ codex: true });
  applyLatestAccountModels(helper);
  expect(codexIds(helper)).toEqual(["gpt-6.1-sol"]);
  expect(parseCodexModels({ models: [{ slug: "a", visibility: "list" }, { slug: "b", visibility: "hide" }, { id: "c" }, { slug: 3 }] })).toEqual(["a", "c"]);
  expect(parseCodexModels({ nope: true })).toBeUndefined();
});

test("a model the account offers stops being 'unknown' once the catalog learns it, without reading the account again", async () => {
  // At start the engine's saved copy of pi.dev's list may be old; /model's refresh brings the newer one, and the list
  // read minutes ago is checked against it again.
  const catalog = await engine({ copilot: true });
  const host = accounts(() => Response.json({ models: [] }), () => Response.json({ data: [
    { id: "gpt-6.1-sol", model_picker_enabled: true, capabilities: { type: "chat", supports: { tool_calls: true } } },
    { id: "gpt-9-fixture", model_picker_enabled: true, capabilities: { type: "chat", supports: { tool_calls: true } } },
  ] }));
  const live = startAccountModels(catalog, lifetime(), { fetch: host.fetch, env: {} });
  await live.ready;
  expect(live.lists().get("github-copilot")?.unknown).toEqual(["gpt-9-fixture"]);
  const known = catalog.getAllModels("github-copilot")[0]!;
  catalog.registerProvider("github-copilot", { models: [...catalog.getAllModels("github-copilot"), { ...known, id: "gpt-9-fixture", name: "GPT-9 Fixture" }] as never });
  await live.refresh();
  expect(host.sent.filter((request) => !request.url.startsWith(CODEX_MODELS_URL))).toHaveLength(1);
  expect(live.lists().get("github-copilot")?.unknown).toEqual([]);
});
