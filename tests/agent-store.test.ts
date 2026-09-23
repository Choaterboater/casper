import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_DIR_ENV, casperAgentDir, importLegacyEngineState, useCasperAgentStore } from "../src/runtime/agent-store";

const env = process.env as Record<string, string | undefined>;

const cleanup: Array<() => Promise<unknown>> = [];
const savedEnv = env[AGENT_DIR_ENV];
afterAll(async () => {
  env[AGENT_DIR_ENV] = savedEnv;
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-agent-store-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("the agent store defaults to Casper's own directory and respects an explicit override", () => {
  delete env[AGENT_DIR_ENV];
  const home = process.env.HOME;
  process.env.HOME = "/tmp/agent-store-default-home";
  try {
    expect(useCasperAgentStore()).toBe(true);
    expect(env[AGENT_DIR_ENV]).toBe(path.join("/tmp/agent-store-default-home", ".casper/agent"));
    expect(casperAgentDir()).toBe(path.join(process.env.HOME!, ".casper/agent"));
  } finally { process.env.HOME = home; }
  env[AGENT_DIR_ENV] = "/custom/pi-compatible-dir";
  expect(useCasperAgentStore()).toBe(false);
  expect(env[AGENT_DIR_ENV]).toBe("/custom/pi-compatible-dir");
});

test("legacy engine state is imported once by copy, and symlinks are refused", async () => {
  const home = await tempHome();
  const legacy = path.join(home, ".pi/agent");
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  await writeFile(path.join(legacy, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "synthetic-legacy" } }), { mode: 0o600 });
  await writeFile(path.join(legacy, "models.json"), JSON.stringify({ providers: {} }), { mode: 0o600 });
  process.env.HOME = home;
  delete env[AGENT_DIR_ENV];
  expect(useCasperAgentStore()).toBe(true);
  expect(await importLegacyEngineState()).toBe(true);
  const imported = path.join(home, ".casper/agent/auth.json");
  expect(await Bun.file(imported).json()).toEqual({ anthropic: { type: "api_key", key: "synthetic-legacy" } });
  expect(((await stat(imported)).mode & 0o777)).toBe(0o600);
  expect(((await stat(path.join(home, ".casper/agent"))).mode & 0o777)).toBe(0o700);
  // A second run imports nothing: the target already exists.
  expect(await importLegacyEngineState()).toBe(false);
  // Existing Pi installations keep their originals.
  expect(await Bun.file(path.join(legacy, "auth.json")).text()).toContain("synthetic-legacy");

  // A symlinked legacy credential is never followed into the store.
  const home2 = await tempHome();
  const legacy2 = path.join(home2, ".pi/agent");
  await mkdir(legacy2, { recursive: true, mode: 0o700 });
  const outside = path.join(home2, "outside-auth.json");
  await writeFile(outside, JSON.stringify({ x: 1 }), { mode: 0o600 });
  await symlink(outside, path.join(legacy2, "auth.json"));
  process.env.HOME = home2;
  delete env[AGENT_DIR_ENV];
  useCasperAgentStore();
  expect(await importLegacyEngineState()).toBe(false);
  expect(await Bun.file(path.join(home2, ".casper/agent/auth.json")).exists()).toBe(false);
});

test("a malformed legacy state is skipped without blocking startup", async () => {
  const home = await tempHome();
  const legacy = path.join(home, ".pi/agent");
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  await mkdir(path.join(legacy, "auth.json")); // a directory, not a regular file
  process.env.HOME = home;
  delete env[AGENT_DIR_ENV];
  useCasperAgentStore();
  expect(await importLegacyEngineState()).toBe(false);
  expect(await stat(path.join(home, ".casper/agent")).then(() => true, () => false)).toBe(true);
});
