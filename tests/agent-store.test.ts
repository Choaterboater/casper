import { afterAll, afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_DIR_ENV, agentStoreWarnings, casperAgentDir, importLegacyEngineState, useCasperAgentStore } from "../src/runtime/agent-store";
import { needsSymlinks, posixModes } from "./support/platform";

const env = process.env as Record<string, string | undefined>;

const cleanup: Array<() => Promise<unknown>> = [];
const tracked = [AGENT_DIR_ENV, "CASPER_AGENT_DIR", "HOME", "PI_OFFLINE", "PI_OAUTH_CALLBACK_HOST", "PI_TUI_WRITE_LOG"];
const startEnv = Object.fromEntries(tracked.map(name => [name, env[name]]));
/** Assigning `undefined` would store the string "undefined": an unset variable is deleted. */
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete env[name];
  else env[name] = value;
}
// Every later test file in the same `bun test` process inherits this file's environment.
afterEach(() => { for (const name of tracked) restore(name, startEnv[name]); });
afterAll(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-agent-store-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("the agent store defaults to Casper's own directory and respects an explicit override", () => {
  delete env[AGENT_DIR_ENV];
  delete env.CASPER_AGENT_DIR;
  process.env.HOME = "/tmp/agent-store-default-home";
  expect(useCasperAgentStore()).toBe(true);
  expect(env[AGENT_DIR_ENV]).toBe(path.join("/tmp/agent-store-default-home", ".casper/agent"));
  expect(casperAgentDir()).toBe(path.join(process.env.HOME!, ".casper/agent"));
  env.CASPER_AGENT_DIR = "~/custom-casper-dir";
  expect(useCasperAgentStore()).toBe(false);
  // "~/" expands to an absolute path: on Windows "/tmp/..." resolves onto the current drive.
  expect(env[AGENT_DIR_ENV]).toBe(path.resolve(process.env.HOME!, "custom-casper-dir"));
  delete env.CASPER_AGENT_DIR;
  // `env.X = undefined` stores the string "undefined" in Bun; it is never a real directory,
  // and trusting it would put the store in `<cwd>/undefined/`.
  for (const unset of ["undefined", ""]) {
    env[AGENT_DIR_ENV] = unset;
    expect(useCasperAgentStore()).toBe(true);
    expect(env[AGENT_DIR_ENV]).toBe(casperAgentDir());
  }
});

test("an inherited PI_CODING_AGENT_DIR is ignored with a warning for the app's output, never written straight to stderr", () => {
  delete env.CASPER_AGENT_DIR;
  process.env.HOME = "/tmp/agent-store-warning-home";
  env[AGENT_DIR_ENV] = "/tmp/some-pi-agent";
  expect(agentStoreWarnings()).toEqual(["Ignoring PI_CODING_AGENT_DIR; use CASPER_AGENT_DIR to choose Casper's state directory."]);
  const write = process.stderr.write;
  const written: unknown[] = [];
  process.stderr.write = ((chunk: unknown) => { written.push(chunk); return true; }) as typeof process.stderr.write;
  try { useCasperAgentStore(); } finally { process.stderr.write = write; }
  expect(written).toEqual([]);
  expect(env[AGENT_DIR_ENV]).toBe(casperAgentDir());
  // Casper's own value (set by an earlier start, or by a parent Casper) and an unset one warn about nothing.
  expect(agentStoreWarnings()).toEqual([]);
  delete env[AGENT_DIR_ENV];
  expect(agentStoreWarnings()).toEqual([]);
});

test("legacy engine state is imported once by copy", async () => {
  const home = await tempHome();
  const legacy = path.join(home, ".pi/agent");
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  const legacyAuth = JSON.stringify({
    anthropic: { type: "api_key", key: "synthetic-legacy" },
    "openai-codex": { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 1 },
  });
  await writeFile(path.join(legacy, "auth.json"), legacyAuth, { mode: 0o600 });
  await writeFile(path.join(legacy, "models.json"), JSON.stringify({ providers: {} }), { mode: 0o600 });
  process.env.HOME = home;
  delete env[AGENT_DIR_ENV];
  expect(useCasperAgentStore()).toBe(true);
  // A rotating OAuth refresh token must have one owner: copying it would let Pi and Casper
  // log each other out. Only API keys are imported; OAuth providers are named for /login.
  expect(await importLegacyEngineState()).toEqual({ imported: true, signIn: ["openai-codex"] });
  const imported = path.join(home, ".casper/agent/auth.json");
  expect(await Bun.file(imported).json()).toEqual({ anthropic: { type: "api_key", key: "synthetic-legacy" } });
  expect(await Bun.file(imported).text()).not.toContain("synthetic-refresh");
  // Windows makes up mode bits rather than storing them; the probe in support/platform says which host this is.
  if (posixModes) {
    expect(((await stat(imported)).mode & 0o777)).toBe(0o600);
    expect(((await stat(path.join(home, ".casper/agent"))).mode & 0o777)).toBe(0o700);
  }
  // A second run imports nothing: the target already exists.
  expect(await importLegacyEngineState()).toEqual({ imported: false, signIn: [] });
  // Existing Pi installations keep their originals.
  expect(await Bun.file(path.join(legacy, "auth.json")).text()).toBe(legacyAuth);
});

needsSymlinks("a symlinked legacy credential is never followed into the store", async () => {
  const home2 = await tempHome();
  const legacy2 = path.join(home2, ".pi/agent");
  await mkdir(legacy2, { recursive: true, mode: 0o700 });
  const outside = path.join(home2, "outside-auth.json");
  await writeFile(outside, JSON.stringify({ x: 1 }), { mode: 0o600 });
  await symlink(outside, path.join(legacy2, "auth.json"));
  process.env.HOME = home2;
  delete env[AGENT_DIR_ENV];
  useCasperAgentStore();
  expect(await importLegacyEngineState()).toEqual({ imported: false, signIn: [] });
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
  expect(await importLegacyEngineState()).toEqual({ imported: false, signIn: [] });
  expect(await stat(path.join(home, ".casper/agent")).then(() => true, () => false)).toBe(true);
});

test("OAuth-only legacy credentials import nothing but are named once for /login", async () => {
  const home = await tempHome();
  const legacy = path.join(home, ".pi/agent");
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  await writeFile(path.join(legacy, "auth.json"), JSON.stringify({
    anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 }, "bad\u001b[2Jname": { type: "oauth" },
  }), { mode: 0o600 });
  process.env.HOME = home;
  delete env[AGENT_DIR_ENV];
  useCasperAgentStore();
  expect(await importLegacyEngineState()).toEqual({ imported: false, signIn: ["anthropic"] });
  expect(await Bun.file(path.join(home, ".casper/agent/auth.json")).json()).toEqual({});
  expect(await importLegacyEngineState()).toEqual({ imported: false, signIn: [] });
});

test("this file leaves the environment exactly as it found it", () => {
  expect(Object.fromEntries(tracked.map(name => [name, env[name]]))).toEqual(startEnv);
  expect(Object.values(env)).not.toContain("undefined");
});
