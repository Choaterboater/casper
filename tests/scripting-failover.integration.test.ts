import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanUpAfterEach, fixture, type Step } from "./support/scripting";

/**
 * Failover through the real CLI and engine: a scripted provider fails one model as providers do (a 429, a usage limit, a
 * key it rejects), and the run goes on with the next model you listed, or doesn't. src/runtime/failover.ts.
 */
cleanUpAfterEach();

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fail = (status: number, error: string): Step => ({ status, error });
const RATE = fail(429, "Rate limit exceeded: too many requests");
/** The run's settings: Casper's (the fixture's default model and your failover list) and the engine's (one quick retry of
 * its own, unless said otherwise). */
async function settings(f: Fixture, extra: Record<string, unknown> = {}, engineRetry: Record<string, unknown> = { enabled: true, maxRetries: 1, baseDelayMs: 1 }) {
  await writeFile(f.settings, JSON.stringify({ defaultProvider: "fixture", defaultModel: "first", ...extra }));
  await writeFile(path.join(f.home, ".casper/agent/settings.json"), JSON.stringify({ retry: { ...engineRetry } }));
}
const models = (f: Fixture) => f.payloads.map((payload) => payload.model);

test("a rate limit, after Pi's own try, moves this task to the next model you listed; it says so once, and the next task goes back", async () => {
  let limited = true;
  const f = await fixture((_, payload) => limited && payload.model === "first" ? RATE : { text: `ANSWER_FROM_${payload.model.toUpperCase()}` });
  await settings(f, { modelFailover: ["fixture/second"] });
  const run = await f.run(["--json", "Say hello."]);
  expect(models(f)).toEqual(["first", "first", "second"]);
  expect(run.exit).toBe(0);
  expect(run.stdout).toContain("ANSWER_FROM_SECOND");
  expect(run.stderr).toContain("Switched to fixture/second because fixture/first hit its rate limit. Your next request tries fixture/first again.");
  expect(run.stderr.match(/Switched to/g)).toHaveLength(1);
  // The next task, in the same conversation, starts on your model again.
  limited = false;
  f.payloads.length = 0;
  const next = await f.run(["--json", "--continue", "And again."]);
  expect(next.exit).toBe(0);
  expect(models(f)).toEqual(["first"]);
}, 60_000);

test("a usage limit, or a model that can't run, switches at once, without Pi's tries on the same model", async () => {
  for (const failure of [fail(429, "Rate limit exceeded: free-models-per-day. Add credits to unlock more requests per day"), fail(402, "Insufficient credits"),
    fail(404, "No endpoints found for vendor/first.")]) {
    const f = await fixture((_, payload) => payload.model === "first" ? failure : { text: "ANSWER" });
    await settings(f, { modelFailover: ["fixture/second"] });
    const run = await f.run(["--json", "Say hello."]);
    expect([failure, models(f)]).toEqual([failure, ["first", "second"]]);
    expect(run.exit).toBe(0);
    expect(run.stderr).toMatch(/Switched to fixture\/second because fixture\/first (?:hit its usage limit|can't run right now)\./);
  }
}, 90_000);

test.each([[401, "Unauthorized: invalid api key"], [403, "Forbidden: this key can't use the model"], [400, "Bad Request: unsupported parameter"]] as const)(
  "a %i (%s) never moves the conversation to another model", async (status, error) => {
    const f = await fixture((_, payload) => payload.model === "first" ? fail(status, error) : { text: "ANSWER" });
    await settings(f, { modelFailover: ["fixture/second"] });
    const run = await f.run(["--json", "Say hello."]);
    expect(models(f)).toEqual(["first"]);
    expect(run.exit).not.toBe(0);
    expect(run.stderr).not.toContain("Switched to");
  }, 60_000);

test("with no list, from a model that isn't a free OpenRouter one, nothing switches, and one line says how to list models", async () => {
  const f = await fixture(() => RATE);
  await settings(f);
  const run = await f.run(["--json", "Say hello."]);
  expect(models(f)).toEqual(["first", "first"]);
  expect(run.exit).not.toBe(0);
  expect(run.stderr).not.toContain("Switched to");
  expect(run.stderr).toContain("fixture/first hit its rate limit, and there's no model to switch to. To switch when that happens, list models: /model failover <provider/id> …");
}, 60_000);

/** A fixture with a "small" model (a 64k window, where the fixture's others have 128k) and a scripted summary. Once
 * `limited`, the first model answers with a rate limit. */
async function smallWindow() {
  const state = { limited: false };
  const f = await fixture((_, payload) => {
    if (JSON.stringify(payload.messages.at(-1)).includes("The messages above are a conversation to summarize")) return { text: "CHECKPOINT_SUMMARY" };
    return state.limited && payload.model === "first" ? RATE : { text: `ANSWER_FROM_${payload.model.toUpperCase()}` };
  });
  const catalog = path.join(f.home, ".casper/agent/models.json");
  const providers = JSON.parse(await readFile(catalog, "utf8")) as { providers: { fixture: { models: Array<Record<string, unknown>> } } };
  providers.providers.fixture.models.push({ id: "small", contextWindow: 65_536 });
  await writeFile(catalog, JSON.stringify(providers));
  return { f, state };
}
/** One request of the conversation so far, as stdin: `tokens` of notes marked `mark`, at about 4 characters a token. */
async function say(f: Fixture, mark: string, tokens: number, continued = true) {
  const run = await f.run(["--json", ...(continued ? ["--continue"] : []), "-"], f.project, {}, `${mark} `.repeat(Math.round(tokens * 4 / (mark.length + 1))));
  expect(run.exit).toBe(0);
}

test("a model with a smaller window gets the conversation compacted to fit first, by that model, and the notice says so", async () => {
  const { f, state } = await smallWindow();
  await settings(f, { modelFailover: ["fixture/small"] }, { enabled: false });
  // About 55k tokens with Casper's own part: more than the small model takes with room to answer (Casper compacts a 64k
  // window from about 49k), and as it compacts it keeps the newest 11k word for word, so the older notes get summarized.
  await say(f, "NOTES_A", 16_000, false);
  await say(f, "NOTES_B", 17_000);
  await say(f, "NOTES_C", 17_000);
  state.limited = true;
  f.payloads.length = 0;
  const run = await f.run(["--json", "--continue", "Next step."]);
  expect(models(f)).toEqual(["first", "small", "small"]);
  const [, summary, retry] = f.payloads.map((payload) => JSON.stringify(payload.messages));
  expect(summary).toContain("conversation to summarize");
  expect(summary).toContain("NOTES_A");
  expect(summary).toContain("NOTES_B");
  expect(summary).not.toContain("NOTES_C");
  expect(retry).toContain("CHECKPOINT_SUMMARY");
  expect(retry).toContain("NOTES_C");
  expect(retry).not.toContain("NOTES_A");
  expect(retry).not.toContain("NOTES_B");
  expect(run.exit).toBe(0);
  expect(run.stdout).toContain("ANSWER_FROM_SMALL");
  expect(run.stderr).toContain("Switched to fixture/small because fixture/first hit its rate limit; compacted the conversation to fit its window.");
}, 120_000);

test("a model whose window can't take the conversation, even compacted, is passed over; with none left, one line says so", async () => {
  const { f, state } = await smallWindow();
  await settings(f, { modelFailover: ["fixture/small", "fixture/second"] }, { enabled: false });
  // About 70k tokens with Casper's own part: the engine would summarize all but the newest 11k in one request to the
  // small model, which with its answer doesn't fit a 64k window. The 128k one takes it as it is.
  await say(f, "NOTES_A", 66_000, false);
  state.limited = true;
  f.payloads.length = 0;
  const run = await f.run(["--json", "--continue", "Next step."]);
  expect(models(f)).toEqual(["first", "second"]);
  expect(run.exit).toBe(0);
  expect(run.stderr).toContain("Switched to fixture/second because fixture/first hit its rate limit. Your next request tries fixture/first again.");

  await settings(f, { modelFailover: ["fixture/small"] }, { enabled: false });
  f.payloads.length = 0;
  const stuck = await f.run(["--json", "--continue", "Next step."]);
  expect(models(f)).toEqual(["first"]);
  expect(stuck.exit).not.toBe(0);
  expect(stuck.stderr).not.toContain("Switched to");
  expect(stuck.stderr).toContain("fixture/first hit its rate limit, and this conversation is too long for the models to switch to, even compacted. /compact shortens it once fixture/first is back.");
}, 120_000);

test("/model failover sets your list from models Casper knows, shows it in order and clears it", async () => {
  const f = await fixture(() => ({ text: "unused" }));
  await settings(f);
  const set = await f.run(["/model failover fixture/second fixture/sparse fixture/second"]);
  expect(set.exit).toBe(0);
  expect(set.stdout).toContain("[model] Failover, in order:\n  1. fixture/second\n  2. fixture/sparse\n");
  expect(JSON.parse(await readFile(f.settings, "utf8")).modelFailover).toEqual(["fixture/second", "fixture/sparse"]);
  const unknown = await f.run(["/model failover fixture/nope"]);
  expect(unknown.exit).not.toBe(0);
  expect(unknown.stderr).toContain("fixture/nope is not a model Casper knows: use exact ids from /model (provider/id).");
  expect((await f.run(["/model failover"])).stdout).toContain("  1. fixture/second\n  2. fixture/sparse\n");
  const cleared = await f.run(["/model failover clear"]);
  expect(cleared.stdout).toContain("[model] Failover: none listed. When a task's model hits a limit, the task stops there.");
  expect(JSON.parse(await readFile(f.settings, "utf8"))).not.toHaveProperty("modelFailover");
  expect(f.payloads).toEqual([]);
}, 120_000);
