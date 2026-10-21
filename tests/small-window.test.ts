import { afterEach, expect, test } from "bun:test";
import type { AgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiModels } from "../src/runtime/pi-models";
import { compactionReserveFor, fixedRequestTokens, MIN_TURN, smallWindowWarning, windowTooSmall } from "../src/runtime/small-window";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir))); });

const windows = { tiny: 4096, small: 8192, mid: 24000, large: 128000 };
const entries = Object.entries(windows).map(([id, contextWindow]) => ({ provider: "local", id, contextWindow }));

test("the warning names the window and appears only below 16,000", () => {
  expect(smallWindowWarning(4096)).toBe("This model's window is only 4,096 tokens; Casper's own instructions take about 4,600 of them. Expect short tasks only, or pick a model with 16k or more (see docs/CONFIGURATION.md, Local models).");
  expect(smallWindowWarning(8192)).toContain("8,192");
  expect(smallWindowWarning(16000)).toBeUndefined();
  expect(smallWindowWarning(128000)).toBeUndefined();
  expect(smallWindowWarning(undefined)).toBeUndefined();
});

test("the reserve is a quarter of a small window, at least 2,000, and absent from 32k up", () => {
  expect(compactionReserveFor(4096)).toBe(2000);
  expect(compactionReserveFor(8192)).toBe(2048);
  expect(compactionReserveFor(24000)).toBe(6000);
  expect(compactionReserveFor(32000)).toBeUndefined();
  expect(compactionReserveFor(128000)).toBeUndefined();
  expect(compactionReserveFor(undefined)).toBeUndefined();
});

test("a window that can't hold Casper's own part and one short turn is named with its fix; one that can is not", () => {
  const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
  const fixed = fixedRequestTokens("x".repeat(14_000), tools);
  expect(fixed).toBe(Math.ceil((14_000 + JSON.stringify(tools[0]).length) / 4));
  expect(windowTooSmall(4096, fixed, { id: "qwen3:8b", ollama: true })).toBe(`Ollama serves qwen3:8b a 4,096-token window, and Casper's own instructions and tools need about ${fixed.toLocaleString("en-US")}, leaving no room for your request and the reply. `
    + "Start Ollama with OLLAMA_CONTEXT_LENGTH=32768 ollama serve, or set PARAMETER num_ctx 32768 in a Modelfile, then try again; or /model to pick another.");
  expect(windowTooSmall(4096, fixed, { id: "tiny" })).toContain("Pick a model with 16k or more (/model)");
  expect(windowTooSmall(fixed + MIN_TURN, fixed, { id: "tiny" })).toBeUndefined();
  expect(windowTooSmall(8192, fixed, { id: "tiny" })).toBeUndefined();
  expect(windowTooSmall(undefined, fixed, { id: "tiny" })).toBeUndefined();
});

async function build() {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-small-")); dirs.push(home);
  const catalog = { getModels: () => entries, getModel: () => undefined } as unknown as ModelRuntime;
  const models = new PiModels(catalog, path.join(home, ".casper", "agent"), home);
  const session = {} as AgentSession;
  const made = await models.create(home, {
    buildSessionContext: () => ({}),
  } as unknown as SessionManager, async options => ({ session, options }));
  return { models, settings: made.options.settingsManager as SettingsManager };
}

test("small windows get a smaller compaction reserve; large windows keep Pi's default", async () => {
  const { settings } = await build();
  const reserve = (id: string) => settings.getCompactionReserveTokens({ provider: "local", id });
  expect(reserve("tiny")).toBe(2000);
  expect(reserve("small")).toBe(2048);
  expect(reserve("mid")).toBe(6000);
  expect(reserve("large")).toBe(16384);
  expect(settings.getCompactionReserveTokens({ provider: "openrouter", id: "x" })).toBe(16384);
});

test("the reserve follows the model's window as it is now", async () => {
  const { settings } = await build();
  const model = { provider: "local", id: "large", contextWindow: 128000 };
  expect(settings.getCompactionReserveTokens(model)).toBe(16384);
  model.contextWindow = 8192;
  expect(settings.getCompactionReserveTokens(model)).toBe(2048);
});

test("the warning comes once per session, for small windows only", async () => {
  const { models } = await build();
  const sessionWith = (contextWindow: number) => ({ model: { contextWindow } }) as unknown as AgentSession;
  for (const size of [4096, 8192]) {
    const session = sessionWith(size);
    expect(models.smallWindowNotice(session)).toContain(size.toLocaleString("en-US"));
    expect(models.smallWindowNotice(session)).toBeUndefined();
  }
  expect(models.smallWindowNotice(sessionWith(128000))).toBeUndefined();
});
