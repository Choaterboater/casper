import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startAcp, until, type AcpClient } from "./support/acp-client";
import { childTestLimit } from "./support/limits";
import { posixOnly } from "./support/platform";
import { cleanUpAfterEach, fixture, type Payload } from "./support/scripting";

// The app's model and effort picker (decision 81), against a real `casper acp` router, its session children and the
// scripted provider (fixture/first: no effort levels; fixture/second: reasoning).
const clients: AcpClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close().catch(() => {}); });
cleanUpAfterEach();
const open = (...args: Parameters<typeof startAcp>) => { const client = startAcp(...args); clients.push(client); return client; };

const INIT = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "fake-acp-client", version: "1" } };
const text = (words: string) => [{ type: "text", text: words }];
type Option = { id: string; currentValue: string; options: Array<Record<string, any>> };
/** Every value a select option lists, through its groups. */
const values = (option: Option | undefined) => (option?.options ?? []).flatMap((entry) => entry.options ? entry.options.map((item: { value: string }) => item.value) : [entry.value]);
const optionOf = (options: Option[], id: string) => options.find((option) => option.id === id);
/** The values the list marks as the default for new conversations. */
const defaults = (option: Option | undefined) => (option?.options ?? []).flatMap((entry) => entry.options ?? [entry]).filter((item: Record<string, any>) => item._meta?.casper?.default === true).map((item: Record<string, any>) => item.value as string);
const messages = (client: AcpClient) => client.lines.map((line) => JSON.parse(line) as Record<string, any>);
const configUpdates = (client: AcpClient, sessionId: string) => client.updates.filter((update) => update.sessionId === sessionId && update.update.sessionUpdate === "config_option_update");
/** The error a request was refused with. */
const refusal = (reply: Promise<unknown>) => reply.then(() => undefined, (error: { code: number; message: string }) => ({ code: error.code, message: error.message }));
/** The model call that carries `marker` in its last user words. */
const askedWith = (payloads: Payload[], marker: string) => payloads.find((payload) => JSON.stringify([...payload.messages].reverse().find((message) => message.role === "user")?.content ?? "").includes(marker));

test("new and load return the model and effort; a set switches the next request's model and effort for this session, leaves the default alone, and is not echoed", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const sessionId = created.sessionId as string;
  let options = created.configOptions as Option[];
  // fixture/first has no effort levels to choose, so there is no effort option yet; plan first, then the access mode last.
  expect(options.map((option) => option.id)).toEqual(["model", "plan", "mode"]);
  expect(optionOf(options, "model")).toMatchObject({ name: "Model", category: "model", type: "select", currentValue: "fixture/first" });
  expect(values(optionOf(options, "model"))).toEqual(expect.arrayContaining(["fixture/first", "fixture/second", "fixture/sparse"]));
  // A provider you are not signed in to is never offered.
  expect(values(optionOf(options, "model"))).not.toContain("missing/no-auth");

  options = (await client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/second" })).configOptions;
  expect(optionOf(options, "model")!.currentValue).toBe("fixture/second");
  expect(values(optionOf(options, "effort"))).toEqual(expect.arrayContaining(["auto", "low", "high"]));
  options = (await client.request("session/set_config_option", { sessionId, configId: "effort", value: "high" })).configOptions;
  expect(optionOf(options, "effort")!.currentValue).toBe("high");
  // This session only (decision 104): the default for new conversations is as it was.
  expect(JSON.parse(await readFile(f.settings, "utf8"))).toEqual({ defaultProvider: "fixture", defaultModel: "first", retry: { enabled: false } });

  expect((await client.request("session/prompt", { sessionId, prompt: text("Say PICKED") })).stopReason).toBe("end_turn");
  const asked = askedWith(f.payloads, "Say PICKED");
  expect(asked).toMatchObject({ model: "second", reasoning_effort: "high" });
  // What the client set is not sent back as an update.
  expect(configUpdates(client, sessionId)).toEqual([]);
  expect(await client.close()).toBe(0);

  const again = open(f);
  await again.request("initialize", INIT);
  const loaded = await again.request("session/load", { sessionId, cwd: f.project, mcpServers: [] });
  expect(optionOf(loaded.configOptions, "model")!.currentValue).toBe("fixture/second");
  expect(optionOf(loaded.configOptions, "effort")!.currentValue).toBe("high");
}, childTestLimit(2));

test("a set during a prompt is refused and the prompt goes on; a typed /model moves the picker before the reply; refusals change nothing", async () => {
  const release = Promise.withResolvers<void>();
  let held = false;
  const f = await fixture(async (_request, payload) => {
    if (!held && JSON.stringify(payload.messages).includes("Wait here")) { held = true; await release.promise; }
    return { text: "Done." };
  });
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });

  const running = client.request("session/prompt", { sessionId, prompt: text("Wait here") });
  await until(() => held, 30_000, "the model call");
  expect(await refusal(client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/second" })))
    .toEqual({ code: -32600, message: "Casper is working on a prompt; change the model or effort when it ends" });
  release.resolve();
  expect((await running).stopReason).toBe("end_turn");
  expect(askedWith(f.payloads, "Wait here")!.model).toBe("first");

  expect(await refusal(client.request("session/set_config_option", { sessionId: "nope", configId: "model", value: "fixture/second" }))).toEqual({ code: -32002, message: "Unknown session" });
  expect(await refusal(client.request("session/set_config_option", { sessionId, configId: "colour", value: "red" }))).toEqual({ code: -32602, message: "Unknown option: colour" });
  expect(await refusal(client.request("session/set_config_option", { sessionId, configId: "model", value: "missing/no-auth" }))).toEqual({ code: -32602,
    message: "Casper can't use missing/no-auth: it is not one of your signed-in models. Pick one from the list." });
  expect(JSON.parse(await readFile(f.settings, "utf8")).defaultModel).toBe("first");

  // A /model typed into Casper: the picker follows before the prompt's reply.
  const id = client.lines.length;
  const typed = await client.request("session/prompt", { sessionId, prompt: text("/model fixture/second") });
  expect(typed.stopReason).toBe("end_turn");
  const after = messages(client).slice(id);
  const update = after.findIndex((message) => message.params?.update?.sessionUpdate === "config_option_update");
  const reply = after.findIndex((message) => message.id !== undefined && message.method === undefined && message.result?.stopReason);
  expect(update).toBeGreaterThanOrEqual(0);
  expect(update).toBeLessThan(reply);
  expect(optionOf(after[update]!.params.update.configOptions, "model")!.currentValue).toBe("fixture/second");
  expect(configUpdates(client, sessionId)).toHaveLength(1);
}, childTestLimit(1));

test("a prompt that comes while a model change is applied is refused; the one after the change runs on the new model", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  // The change and a prompt are written together. Casper refuses the prompt only if it reads it while the change is
  // still being applied, and a busy runner can hand it the change first and finish it: then the prompt runs, on the new
  // model. Each round checks whichever happened, until one refusal is seen.
  let refused = 0;
  let model = "first";
  for (let round = 0; round < 10 && !refused; round++) {
    model = round % 2 ? "first" : "second";
    const [set, early] = client.requestTogether([["session/set_config_option", { sessionId, configId: "model", value: `fixture/${model}` }],
      ["session/prompt", { sessionId, prompt: text(`Round ${round} EARLY`) }]]);
    const refusedWith = await refusal(early!);
    expect(optionOf((await set!).configOptions, "model")!.currentValue).toBe(`fixture/${model}`);
    if (refusedWith) {
      expect(refusedWith).toEqual({ code: -32600, message: "Casper is changing its model or effort; send the prompt again when it is done" });
      expect(askedWith(f.payloads, `Round ${round} EARLY`)).toBeUndefined();
      refused++;
    } else {
      expect(askedWith(f.payloads, `Round ${round} EARLY`)!.model).toBe(model);
    }
  }
  expect(refused).toBe(1);
  expect((await client.request("session/prompt", { sessionId, prompt: text("In TIME") })).stopReason).toBe("end_turn");
  expect(askedWith(f.payloads, "In TIME")!.model).toBe(model);
}, childTestLimit(2));

// A read-only settings file: Windows keeps letting its owner replace it, and root writes it anyway.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a model the runtime took but could not save as the default is refused, and the app is told it first", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const { sessionId } = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  await chmod(f.settings, 0o444);
  const from = client.lines.length;
  try {
    expect(await refusal(client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/second", _meta: { casper: { makeDefault: true } } })))
      .toEqual({ code: -32603, message: "Model selected for this conversation, but the Casper default could not be saved." });
  } finally { await chmod(f.settings, 0o644); }
  // The conversation is on the new model, so the app hears that before the refusal; the prompt's end says nothing again.
  const after = messages(client).slice(from);
  const update = after.findIndex((message) => message.params?.update?.sessionUpdate === "config_option_update");
  const reply = after.findIndex((message) => message.id !== undefined && message.method === undefined && message.error);
  expect(update).toBeGreaterThanOrEqual(0);
  expect(update).toBeLessThan(reply);
  expect(optionOf(after[update]!.params.update.configOptions, "model")!.currentValue).toBe("fixture/second");
  expect((await client.request("session/prompt", { sessionId, prompt: text("After FAIL") })).stopReason).toBe("end_turn");
  expect(askedWith(f.payloads, "After FAIL")!.model).toBe("second");
  expect(configUpdates(client, sessionId)).toHaveLength(1);
}, childTestLimit(1));

test("with two sessions, a set reaches only the session it names", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const one = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
  const two = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
  await client.request("session/set_config_option", { sessionId: one, configId: "model", value: "fixture/second" });
  await Promise.all([client.request("session/prompt", { sessionId: one, prompt: text("From ONE") }), client.request("session/prompt", { sessionId: two, prompt: text("From TWO") })]);
  expect(askedWith(f.payloads, "From ONE")!.model).toBe("second");
  expect(askedWith(f.payloads, "From TWO")!.model).toBe("first");
  // The other session keeps its model, and so does the default: nothing is sent to it.
  expect(configUpdates(client, two)).toEqual([]);
  expect(JSON.parse(await readFile(f.settings, "utf8"))).toMatchObject({ defaultProvider: "fixture", defaultModel: "first" });
  // A session opened now starts on the default, not on the other session's pick.
  const three = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect(optionOf(three.configOptions, "model")!.currentValue).toBe("fixture/first");
  expect(defaults(optionOf(three.configOptions, "model"))).toEqual(["fixture/first"]);
}, childTestLimit(1));

test("make default is its own request: it saves the model and effort for new conversations, and the list marks the default", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  const client = open(f);
  await client.request("initialize", INIT);
  const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const sessionId = created.sessionId as string;
  expect(defaults(optionOf(created.configOptions, "model"))).toEqual(["fixture/first"]);
  // Only `true` asks for it: anything else is a pick for this session.
  await client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/second", _meta: { casper: { makeDefault: "yes" } } });
  expect(JSON.parse(await readFile(f.settings, "utf8"))).toMatchObject({ defaultProvider: "fixture", defaultModel: "first" });

  // The model the session is already on, sent again with makeDefault: the app's "make default" button.
  let options = (await client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/second", _meta: { casper: { makeDefault: true } } })).configOptions as Option[];
  expect(optionOf(options, "model")!.currentValue).toBe("fixture/second");
  expect(defaults(optionOf(options, "model"))).toEqual(["fixture/second"]);
  expect(JSON.parse(await readFile(f.settings, "utf8"))).toMatchObject({ defaultProvider: "fixture", defaultModel: "second" });
  await client.request("session/set_config_option", { sessionId, configId: "effort", value: "high" });
  expect(JSON.parse(await readFile(f.settings, "utf8")).defaultThinkingLevel).not.toBe("high");
  options = (await client.request("session/set_config_option", { sessionId, configId: "effort", value: "high", _meta: { casper: { makeDefault: true } } })).configOptions;
  expect(optionOf(options, "effort")!.currentValue).toBe("high");
  expect(JSON.parse(await readFile(f.settings, "utf8"))).toMatchObject({ defaultProvider: "fixture", defaultModel: "second", defaultThinkingLevel: "high" });

  const next = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect(optionOf(next.configOptions, "model")!.currentValue).toBe("fixture/second");
  expect(optionOf(next.configOptions, "effort")!.currentValue).toBe("high");
  expect(f.payloads).toEqual([]);
}, childTestLimit(1));

test("With models and none chosen, a new session lists them before any message, and a pick is taken", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  // Your own model server is never picked for you: no default is saved, so no model is in use.
  await writeFile(f.settings, JSON.stringify({ retry: { enabled: false } }));
  const client = open(f);
  await client.request("initialize", INIT);
  const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const sessionId = created.sessionId as string;
  let options = created.configOptions as Option[];
  expect(options.map((option) => option.id)).toEqual(["model", "plan", "mode"]);
  expect(optionOf(options, "model")).toMatchObject({ name: "Model", category: "model", type: "select", currentValue: "" });
  expect(values(optionOf(options, "model"))).toEqual(expect.arrayContaining(["fixture/first", "fixture/second", "fixture/sparse"]));
  expect(values(optionOf(options, "model"))).not.toContain("missing/no-auth");
  expect(defaults(optionOf(options, "model"))).toEqual([]);

  options = (await client.request("session/set_config_option", { sessionId, configId: "model", value: "fixture/second" })).configOptions;
  expect(optionOf(options, "model")!.currentValue).toBe("fixture/second");
  expect(values(optionOf(options, "effort"))).toEqual(expect.arrayContaining(["auto", "low", "high"]));
  // No message was sent for any of it, and the pick saved no default.
  expect(f.payloads).toEqual([]);
  expect(JSON.parse(await readFile(f.settings, "utf8"))).toEqual({ retry: { enabled: false } });
  expect((await client.request("session/prompt", { sessionId, prompt: text("Say CHOSEN") })).stopReason).toBe("end_turn");
  expect(askedWith(f.payloads, "Say CHOSEN")!.model).toBe("second");
}, childTestLimit(1));

test("Signed in with no model chosen, a new session opens on that provider's default and lists its models", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  await writeFile(f.settings, JSON.stringify({ retry: { enabled: false } }));
  await writeFile(path.join(f.home, ".casper/agent/auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "synthetic" } }), { mode: 0o600 });
  const client = open(f);
  await client.request("initialize", INIT);
  const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  const model = optionOf(created.configOptions, "model")!;
  // What the first request did until now (it picks the provider's default and saves it) happens as the session opens.
  expect(model.currentValue).toBe("openrouter/deepseek/deepseek-v4.1-flash");
  expect(defaults(model)).toEqual(["openrouter/deepseek/deepseek-v4.1-flash"]);
  expect(values(model).filter((value) => value.startsWith("openrouter/")).length).toBeGreaterThan(1);
  expect(values(model)).toContain("fixture/first");
  expect(JSON.parse(await readFile(f.settings, "utf8"))).toMatchObject({ defaultProvider: "openrouter", defaultModel: "deepseek/deepseek-v4.1-flash" });
  expect(client.stderr()).toContain("[model] Casper picked openrouter/deepseek/deepseek-v4.1-flash for your signed-in provider and saved it as your default.");
  expect(f.payloads).toEqual([]);
}, childTestLimit(1));

posixOnly("A model server that answers after the session opened reaches the picker before any message, once", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  await writeFile(f.settings, JSON.stringify({ retry: { enabled: false } }));
  // Your own server, slow to list its models: it answers after the reply. "localhost." reaches this computer but is looked
  // at as another one would be (10 s, not this computer's 0.8 s), so it can be slower than the session's start.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/models") return new Response("not here", { status: 404 });
    await Bun.sleep(2_500);
    return Response.json({ data: [{ id: "late-model" }] });
  } });
  try {
    await writeFile(path.join(f.home, ".casper/config.yaml"), `localModels: false\nmodelServers:\n  - name: late-box\n    address: http://localhost.:${server.port}\n    kind: openai\n`);
    const client = open(f, [], { CASPER_LOCAL_MODELS: "on" });
    await client.request("initialize", INIT);
    const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
    const sessionId = created.sessionId as string;
    const listed = (options: Option[]) => values(optionOf(options, "model")).includes("late-box/late-model");
    expect(listed(created.configOptions)).toBe(false);
    const update = await until(() => configUpdates(client, sessionId).find((entry) => listed(entry.update.configOptions)), 15_000, "the late server's models");
    expect(optionOf(update.update.configOptions, "model")!.currentValue).toBe("");
    // Said once, and the reply came first.
    expect(configUpdates(client, sessionId)).toHaveLength(1);
    const lines = messages(client);
    expect(lines.findIndex((line) => line.result?.sessionId === sessionId)).toBeLessThan(lines.findIndex((line) => line.params?.update?.sessionUpdate === "config_option_update"));
    expect(f.payloads).toEqual([]);
    expect(JSON.parse(await readFile(f.settings, "utf8"))).toEqual({ retry: { enabled: false } });
  } finally { server.stop(true); }
}, childTestLimit(1));

test("--effort goes on the model a new session picks for a signed-in provider; with none to pick, the session still opens", async () => {
  const f = await fixture(() => ({ text: "Done." }));
  await writeFile(f.settings, JSON.stringify({ retry: { enabled: false } }));
  const own = open(f, ["--effort", "high"]);
  await own.request("initialize", INIT);
  // Your own model server, nothing chosen: no model to set it on, and stderr says so.
  const listed = await own.request("session/new", { cwd: f.project, mcpServers: [] });
  expect(optionOf(listed.configOptions, "model")!.currentValue).toBe("");
  expect(optionOf(listed.configOptions, "effort")).toBeUndefined();
  await until(() => own.stderr().includes("[acp] --effort high is not used: no model is chosen yet."), 5_000, "the effort note");
  expect(await own.close()).toBe(0);

  await writeFile(path.join(f.home, ".casper/agent/auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "synthetic" } }), { mode: 0o600 });
  const client = open(f, ["--effort", "high"]);
  await client.request("initialize", INIT);
  const created = await client.request("session/new", { cwd: f.project, mcpServers: [] });
  expect(optionOf(created.configOptions, "model")!.currentValue).toBe("openrouter/deepseek/deepseek-v4.1-flash");
  expect(optionOf(created.configOptions, "effort")!.currentValue).toBe("high");
  // The flag is this session's: the saved default has the model the session picked, and no effort.
  const saved = JSON.parse(await readFile(f.settings, "utf8"));
  expect(saved).toMatchObject({ defaultProvider: "openrouter", defaultModel: "deepseek/deepseek-v4.1-flash" });
  expect(JSON.stringify(saved)).not.toContain("high");
  expect(f.payloads).toEqual([]);
}, childTestLimit(2));

describe("a loaded conversation's model (decision 89)", () => {
  test("Loading a conversation puts back its own model and effort for this session without changing the saved default", async () => {
    const f = await fixture(() => ({ text: "Done." }));
    const client = open(f);
    await client.request("initialize", INIT);
    const first = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
    await client.request("session/set_config_option", { sessionId: first, configId: "model", value: "fixture/second" });
    await client.request("session/set_config_option", { sessionId: first, configId: "effort", value: "high" });
    expect((await client.request("session/prompt", { sessionId: first, prompt: text("Say FIRST") })).stopReason).toBe("end_turn");
    // Another conversation then saves low effort for fixture/second, and fixture/first as the default.
    const other = (await client.request("session/new", { cwd: f.project, mcpServers: [] })).sessionId as string;
    await client.request("session/set_config_option", { sessionId: other, configId: "model", value: "fixture/second" });
    await client.request("session/set_config_option", { sessionId: other, configId: "effort", value: "low", _meta: { casper: { makeDefault: true } } });
    await client.request("session/set_config_option", { sessionId: other, configId: "model", value: "fixture/first", _meta: { casper: { makeDefault: true } } });
    expect(JSON.parse(await readFile(f.settings, "utf8"))).toMatchObject({ defaultProvider: "fixture", defaultModel: "first" });
    const saved = await readFile(f.settings, "utf8");
    expect(await client.close()).toBe(0);

    // The app reopens Casper with its own start model, as it starts every Casper.
    const again = open(f, ["--model", "fixture/first"]);
    await again.request("initialize", INIT);
    const loaded = await again.request("session/load", { sessionId: first, cwd: f.project, mcpServers: [] });
    expect(optionOf(loaded.configOptions, "model")!.currentValue).toBe("fixture/second");
    expect(optionOf(loaded.configOptions, "effort")!.currentValue).toBe("high");
    expect((await again.request("session/prompt", { sessionId: first, prompt: text("Say LOADED") })).stopReason).toBe("end_turn");
    expect(askedWith(f.payloads, "Say LOADED")).toMatchObject({ model: "second", reasoning_effort: "high" });
    // The default is still the other conversation's pick: the load changed this session only.
    expect(await readFile(f.settings, "utf8")).toBe(saved);
    // A new session from the same process starts on the app's start model.
    const fresh = await again.request("session/new", { cwd: f.project, mcpServers: [] });
    expect(optionOf(fresh.configOptions, "model")!.currentValue).toBe("fixture/first");
  }, childTestLimit(2));
});
