import { expect, test } from "bun:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { offerOf, offeredEfforts, setOption, type OfferRuntime } from "../src/acp/config-options";
import { hider } from "../src/acp/updates";
import type { RuntimeModelSelectionOptions, RuntimeOfferedModel, RuntimeStatus } from "../src/runtime/types";

// The model and effort an ACP app's picker shows and sets (decision 81), against a fake runtime session.
const REASONING = ["off", "minimal", "low", "medium", "high"];
const plainHide = hider(() => []);

function fakeRuntime(status: Partial<RuntimeStatus>, models: RuntimeOfferedModel[]) {
  const calls: Array<{ select?: RuntimeModelSelectionOptions; effort?: [string, boolean] }> = [];
  const full: RuntimeStatus = { auth: "configured", ...status };
  const runtime: OfferRuntime = {
    getStatus: () => full,
    offeredModels: () => models,
    selectModel: async (options) => { calls.push({ select: options }); return { status: { ...full, provider: options.exact!.provider, model: options.exact!.id }, selected: true, savedDefault: true }; },
    setEffort: async (level, persist) => { calls.push({ effort: [level, persist] }); return { ...full, configuredEffort: level }; },
  };
  return { runtime, calls };
}

const models: RuntimeOfferedModel[] = [
  { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", levels: REASONING },
  { provider: "claude-subscription", id: "claude-opus-5-5", name: "Claude Opus 5.5", levels: [...REASONING, "xhigh"] },
  { provider: "openai-codex", id: "gpt-6.1-mini", name: "GPT-6.1 mini", levels: ["off"] },
];

test("the model list keeps the runtime's order, grouped by provider in order of first appearance, with each model's efforts", () => {
  const { runtime } = fakeRuntime({ provider: "openai-codex", model: "gpt-6.1-sol", configuredEffort: "auto", thinkingLevel: "high", availableThinkingLevels: REASONING }, models);
  const offer = offerOf(runtime, plainHide);
  expect(offer.wire.map((option) => option.id)).toEqual(["model", "effort"]);
  expect(offer.wire[0]).toEqual({ id: "model", name: "Model", category: "model", type: "select", currentValue: "openai-codex/gpt-6.1-sol", options: [
    { group: "openai-codex", name: "OpenAI Codex", options: [
      { value: "openai-codex/gpt-6.1-sol", name: "GPT-6.1 Sol", _meta: { casper: { efforts: ["auto", ...REASONING] } } },
      // A model with one level has nothing to choose: no efforts.
      { value: "openai-codex/gpt-6.1-mini", name: "GPT-6.1 mini", _meta: { casper: { efforts: [] } } }] },
    { group: "claude-subscription", name: "Claude Code plan", options: [
      { value: "claude-subscription/claude-opus-5-5", name: "Claude Opus 5.5", _meta: { casper: { efforts: ["auto", ...REASONING, "xhigh"] } } }] }] });
  expect(offer.wire[1]).toMatchObject({ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "auto" });
  expect((offer.wire[1]!.options as Array<Record<string, unknown>>)[0]).toEqual({ value: "auto", name: "Auto", description: "classify each request" });
  expect(offer.efforts).toEqual(["auto", ...REASONING]);
  expect([...offer.models.keys()]).toEqual(["openai-codex/gpt-6.1-sol", "claude-subscription/claude-opus-5-5", "openai-codex/gpt-6.1-mini"]);
});

test("every built-in provider's group in the picker has a name, never its raw id: Casper's own names first, then the catalog's", () => {
  // As PiModels.offered gives them: each provider's catalog name with its models, and the Claude Code plan, which has none.
  const providers = [...builtinProviders().map((provider) => ({ id: provider.id, name: provider.name })), { id: "claude-subscription", name: undefined }];
  const offered: RuntimeOfferedModel[] = providers.map((provider) => ({ provider: provider.id, id: "m", name: "M", levels: [], ...provider.name ? { providerName: provider.name } : {} }));
  const groups = offerOf(fakeRuntime({ provider: providers[0]!.id, model: "m" }, offered).runtime, plainHide).wire[0]!.options as Array<{ group: string; name: string }>;
  expect(groups.map((group) => group.group)).toEqual(providers.map((provider) => provider.id));
  for (const group of groups) expect(group.name).not.toBe(group.group);
  const named = Object.fromEntries(groups.map((group) => [group.group, group.name]));
  // /login's and /model's words, not the catalog's "OpenAI Codex (legacy)".
  expect(named).toMatchObject({ "openai-codex": "OpenAI Codex", "claude-subscription": "Claude Code plan", anthropic: "Anthropic API", openrouter: "OpenRouter", "github-copilot": "GitHub Copilot", openai: "OpenAI" });
});

test("effort is offered only with at least three choices; a current value that is not among them goes first", () => {
  expect(offeredEfforts(["off"])).toEqual([]);
  expect(offeredEfforts(undefined)).toEqual([]);
  expect(offeredEfforts(["off", "high"])).toEqual(["auto", "off", "high"]);
  const few = offerOf(fakeRuntime({ provider: "openai-codex", model: "gpt-6.1-mini", thinkingLevel: "off", availableThinkingLevels: ["off"] }, models).runtime, plainHide);
  expect(few.wire.map((option) => option.id)).toEqual(["model"]);
  expect(few.efforts).toEqual([]);
  const odd = offerOf(fakeRuntime({ provider: "openai-codex", model: "gpt-6.1-sol", configuredEffort: "turbo", availableThinkingLevels: REASONING }, models).runtime, plainHide);
  expect(odd.wire[1]!.currentValue).toBe("turbo");
  expect((odd.wire[1]!.options as Array<{ value: string }>).map((option) => option.value)).toEqual(["turbo", "auto", ...REASONING]);
});

test("a value the hiding would change is left out; names and descriptions are hidden", () => {
  // One of your own secrets, by its value (the --json redaction would not know it).
  const secret = "PLUMPLUMPLUM42";
  const hide = hider(() => [secret]);
  const { runtime } = fakeRuntime({ provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "off", availableThinkingLevels: ["off"] }, [
    ...models.slice(0, 1),
    { provider: "openai-codex", id: `leak-${secret}`, name: "Leak", levels: [] },
    { provider: "local", id: "named", name: `token ${secret}`, levels: [] }]);
  const offer = offerOf(runtime, hide);
  const json = JSON.stringify(offer.wire);
  expect(json).not.toContain(secret);
  expect([...offer.models.keys()]).toEqual(["openai-codex/gpt-6.1-sol", "local/named"]);
  expect(json).toContain("token <secret hidden>");
});

test("no model at all offers nothing; a signed-out current model stays listed, saying why", () => {
  expect(offerOf(undefined, plainHide).wire).toEqual([]);
  expect(offerOf(fakeRuntime({ blocked: "No Casper model selected." }, models).runtime, plainHide).wire).toEqual([]);
  const blocked = "Sign in to anthropic again with /login. Model unchanged.";
  const gone = offerOf(fakeRuntime({ provider: "anthropic", model: "claude-opus-5-5", blocked, availableThinkingLevels: [] }, models).runtime, plainHide);
  expect(gone.wire.map((option) => option.id)).toEqual(["model"]);
  expect(gone.wire[0]!.currentValue).toBe("anthropic/claude-opus-5-5");
  const groups = gone.wire[0]!.options as Array<{ group: string; name: string; options: Array<Record<string, unknown>> }>;
  expect(groups[0]).toEqual({ group: "anthropic", name: "Anthropic API", options: [{ value: "anthropic/claude-opus-5-5", name: "claude-opus-5-5", description: blocked, _meta: { casper: { efforts: [] } } }] });
  expect(groups.map((group) => group.group)).toEqual(["anthropic", "openai-codex", "claude-subscription"]);
});

test("a listed model or effort is set as /model and /effort set it, saved; each refusal changes nothing", async () => {
  const { runtime, calls } = fakeRuntime({ provider: "openai-codex", model: "gpt-6.1-sol", configuredEffort: "auto", availableThinkingLevels: REASONING }, models);
  const offer = offerOf(runtime, plainHide);
  const written: string[] = [];
  const write = (text: string) => { written.push(text); };
  const refused = async (configId: unknown, value: unknown) => {
    const error = await setOption(runtime, offer, configId, value, write).then(() => undefined, (caught: { code: number; message: string }) => caught);
    return error && { code: error.code, message: error.message };
  };
  expect(await refused("colour", "red")).toEqual({ code: -32602, message: "Unknown option: colour" });
  expect(await refused("model", true)).toEqual({ code: -32602, message: "model takes one of its listed values" });
  expect(await refused("model", "openai-codex/gpt-9")).toEqual({ code: -32602,
    message: "Casper can't use openai-codex/gpt-9: it is not one of your signed-in models. Pick one from the list." });
  expect(await refused("effort", "xhigh")).toEqual({ code: -32602, message: "openai-codex/gpt-6.1-sol has no effort xhigh. Choose: auto, off, minimal, low, medium, high" });
  expect(calls).toEqual([]);
  expect(written).toEqual([]);

  await setOption(runtime, offer, "model", "claude-subscription/claude-opus-5-5", write);
  await setOption(runtime, offer, "effort", "high", write);
  expect(calls).toEqual([{ select: { exact: { provider: "claude-subscription", id: "claude-opus-5-5" }, persist: true } }, { effort: ["high", true] }]);
  expect(written.join("")).toContain("[model] Selected and saved as the Casper default for new conversations.\n");

  // The runtime's own refusal is its words, as an internal error.
  const busy: OfferRuntime = { ...runtime, setEffort: async () => { throw new Error("Wait for active work before changing effort."); } };
  const error = await setOption(busy, offer, "effort", "low", write).catch((caught: { code: number; message: string }) => caught);
  expect(error).toMatchObject({ code: -32603, message: "Wait for active work before changing effort." });
});

test("The plan option comes before mode", () => {
  const { runtime } = fakeRuntime({ provider: "openai-codex", model: "gpt-6.1-sol", configuredEffort: "auto", availableThinkingLevels: REASONING }, models);
  const app = { readOnlyAccess: false, stopAsking: false, clientAccess: undefined, projectContext: undefined, planMode: false };
  const wire = offerOf(runtime, plainHide, app).wire;
  expect(wire.map((option) => option.id)).toEqual(["model", "effort", "plan", "mode"]);
  // No category: it is not the access mode, and the app's own mode picker leaves it alone.
  expect(wire[2]).toEqual({ id: "plan", name: "Plan first", type: "select", currentValue: "off", options: [{ value: "off", name: "Off" },
    { value: "on", name: "Plan first", description: "every request gets a plan first; nothing is built until you choose Build" }] });
  expect(offerOf(runtime, plainHide, { ...app, planMode: true }).wire[2]!.currentValue).toBe("on");
  expect(offerOf(undefined, plainHide, app).wire.map((option) => option.id)).toEqual(["plan", "mode"]);
});

test("An unknown plan value is refused", async () => {
  const { runtime, calls } = fakeRuntime({ provider: "openai-codex", model: "gpt-6.1-sol" }, models);
  const app = { readOnlyAccess: false, stopAsking: false, clientAccess: undefined, projectContext: undefined, planMode: false, footer: 0, updateFooter() { app.footer++; } };
  const offer = offerOf(runtime, plainHide, app);
  const written: string[] = [];
  const write = (text: string) => { written.push(text); };
  for (const value of ["maybe", true, undefined]) {
    const error = await setOption(runtime, offer, "plan", value, write, app).then(() => undefined, (caught: { code: number; message: string }) => ({ code: caught.code, message: caught.message }));
    expect(error).toEqual({ code: -32602, message: "plan takes off or on" });
  }
  expect(app.planMode).toBe(false);
  expect(written).toEqual([]);
  // on and off set /plan on's switch, with /plan on's words on Casper's transcript; the footer follows.
  await setOption(runtime, offer, "plan", "on", write, app);
  expect(app.planMode).toBe(true);
  expect(app.footer).toBe(1);
  await setOption(runtime, offer, "plan", "on", write, app);
  await setOption(runtime, offer, "plan", "off", write, app);
  expect(app.planMode).toBe(false);
  expect(written).toEqual(["[plan] The app set Plan first: every request gets a plan first. /plan off ends it.\n", "[plan] The app set Plan first off.\n"]);
  expect(calls).toEqual([]);
});
