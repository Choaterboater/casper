import { afterEach, expect, test } from "bun:test";
import type { AgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiModels } from "../src/runtime/pi-models";
import { compactionKeepFor, compactionReserveFor, fixedRequestTokens, MIN_TURN, OWN_PART, smallWindowWarning, windowTooSmall } from "../src/runtime/small-window";
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

test("the reserve is the reply's room plus the 4,096 Pi keeps spare, and Pi's own 16,384 from 48k up", () => {
  // The reply gets a quarter of the window, but never more than half of what Casper's own part (about 4,600) and the
  // spare leave: a 4k or 8k window has nothing left, a 16k one 7,688 (half of it 3,844).
  expect(compactionReserveFor(4096)).toBe(4096);
  expect(compactionReserveFor(8192)).toBe(4096);
  expect(compactionReserveFor(16384)).toBe(4096 + 3844);
  expect(compactionReserveFor(24000)).toBe(4096 + 6000);
  expect(compactionReserveFor(32768)).toBe(4096 + 8192);
  expect(compactionReserveFor(12000, 5000)).toBe(4096 + 1452);
  expect(compactionReserveFor(49151)).toBe(4096 + 12287);
  expect(compactionReserveFor(49152)).toBeUndefined();
  expect(compactionReserveFor(128000)).toBeUndefined();
  expect(compactionReserveFor(undefined)).toBeUndefined();
});

test("a compaction keeps a quarter of the conversation's room word for word, at least 1,024 and at most Pi's 20,000", () => {
  // 32k window, 12,288 reserved, 5,000 of Casper's own: 15,480 of room, 3,870 kept (Pi's 20,000 left nothing to summarise).
  expect(compactionKeepFor(32768, 12288, 5000)).toBe(3870);
  expect(compactionKeepFor(65536, 16384, 5000)).toBe(11038);
  expect(compactionKeepFor(128000, 16384, 5000)).toBe(20000);
  expect(compactionKeepFor(128000, 16384, 5000, 8000)).toBe(8000);
  expect(compactionKeepFor(16384, 8192, 6000)).toBe(1024);
  expect(compactionKeepFor(undefined, 16384, 5000)).toBeUndefined();
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

async function build(saved?: Record<string, unknown>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-small-")); dirs.push(home);
  const agent = path.join(home, ".casper", "agent");
  if (saved) { await mkdir(agent, { recursive: true }); await writeFile(path.join(agent, "settings.json"), JSON.stringify(saved)); }
  const catalog = { getModels: () => entries, getModel: () => undefined } as unknown as ModelRuntime;
  const models = new PiModels(catalog, agent, home);
  const session = {} as AgentSession;
  const made = await models.create(home, {
    buildSessionContext: () => ({}),
  } as unknown as SessionManager, async options => ({ session, options }));
  return { models, settings: made.options.settingsManager as SettingsManager };
}

test("small windows get a reserve and a keep sized to the window; large windows keep Pi's defaults", async () => {
  const { settings } = await build();
  const reserve = (id: string) => settings.getCompactionReserveTokens({ provider: "local", id });
  const keep = (id: string) => settings.getCompactionKeepRecentTokens({ provider: "local", id });
  expect(reserve("tiny")).toBe(4096);
  expect(reserve("small")).toBe(4096);
  expect(reserve("mid")).toBe(10096);
  expect(reserve("large")).toBe(16384);
  expect(settings.getCompactionReserveTokens({ provider: "openrouter", id: "x" })).toBe(16384);
  // Before the session can be measured, Casper's own part is taken as about 4,600 tokens.
  expect(keep("mid")).toBe(Math.floor((24000 - 10096 - OWN_PART) / 4));
  expect(keep("large")).toBe(20000);
  expect(settings.getCompactionKeepRecentTokens({ provider: "openrouter", id: "x" })).toBe(20000);
});

test("the reserve and the keep follow the model's window as it is now", async () => {
  const { settings } = await build();
  const model = { provider: "local", id: "large", contextWindow: 128000 };
  expect(settings.getCompactionReserveTokens(model)).toBe(16384);
  expect(settings.getCompactionKeepRecentTokens(model)).toBe(20000);
  model.contextWindow = 32768;
  expect(settings.getCompactionReserveTokens(model)).toBe(12288);
  expect(settings.getCompactionKeepRecentTokens(model)).toBe(Math.floor((32768 - 12288 - OWN_PART) / 4));
});

test("a reserve or a keep you set yourself is kept, each on its own", async () => {
  for (const own of [{ reserveTokens: 3000 }, { keepRecentTokens: 7000 }, { modelOverrides: { "local/mid": { keepRecentTokens: 7000 } } }]) {
    const { settings } = await build({ compaction: own });
    const model = { provider: "local", id: "mid", contextWindow: 24000 };
    const reserve = "reserveTokens" in own ? 3000 : 10096;
    expect(settings.getCompactionReserveTokens(model)).toBe(reserve);
    expect(settings.getCompactionKeepRecentTokens(model)).toBe("reserveTokens" in own ? Math.floor((24000 - 3000 - OWN_PART) / 4) : 7000);
  }
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
