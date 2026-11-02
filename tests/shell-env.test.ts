import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedProcess } from "../src/platform/managed-process";
import { PROVIDER_KEY_NAMES, rememberPersonEngineEnv, withoutProviderKeys } from "../src/platform/environment";
import { useCasperAgentStore } from "../src/runtime/agent-store";
import { casperBashOperations } from "../src/runtime/pi";
import { withEnv } from "./support/env";
import { runCommandCheck } from "../src/verify/command";
import { POSIX } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const saved = { ...process.env };
afterEach(() => { for (const name of ["OPENROUTER_API_KEY", "MIST_API_TOKEN", "CASPER_TEST_SECRET_TOKEN"]) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

// Only the names under test: a check keeps 8 KB of output, and a CI runner's whole environment is bigger, which
// cut MIST_API_TOKEN out of the middle (and would let a leaked key hide there too).
const PRINT = POSIX ? "printenv | grep -E '^(OPENROUTER|MIST|CASPER_TEST|ANTHROPIC)_'"
  : "set | findstr /B \"OPENROUTER_ MIST_ CASPER_TEST_ ANTHROPIC_\"";

test("a repo check runs without AI provider keys; product tokens stay", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-provider-fixture";
  process.env.MIST_API_TOKEN = "mist-product-fixture";
  process.env.CASPER_TEST_SECRET_TOKEN = "casper-own-fixture";
  // This takes ~0.3 s locally but about 30 s on macOS CI, cause unconfirmed: a slow step says so in the failure.
  const steps: string[] = [];
  const timed = async (label: string, run: () => ReturnType<typeof runCommandCheck>) => {
    const began = performance.now();
    const result = await run();
    const wall = Math.round(performance.now() - began);
    steps.push(`${label}: ${wall} ms wall, ${result.durationMs} ms in the check (${result.status})`);
    if (wall > 5000) throw new Error(`Slow repo check, unconfirmed cause. Steps so far: ${steps.join("; ")}`);
    return result;
  };
  // Casper's own environment (no env given), as registry checks run.
  const inherited = await timed("own environment", () => runCommandCheck({ name: "test", command: PRINT, cwd: os.tmpdir(), timeoutMs: 10_000 }));
  expect(inherited.stdout).toContain("mist-product-fixture");
  expect(inherited.stdout).not.toContain("sk-or-provider-fixture");
  expect(inherited.stdout).not.toContain("casper-own-fixture");
  // An explicit environment (proof and trace copies pass one) is cleaned too.
  const given = await timed("given environment", () => runCommandCheck({ name: "test", command: PRINT, cwd: os.tmpdir(), timeoutMs: 10_000,
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-fixture" } }));
  expect(given.stdout).not.toContain("sk-ant-fixture");
  expect(given.stdout).toContain("mist-product-fixture");
});

test("a dev server or service gets no provider key even when its config sets one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-shell-env-"));
  try {
    const out = path.join(dir, "env.txt");
    const managed = new ManagedProcess({
      command: POSIX ? `printenv > '${out}'; echo READY; sleep 30` : `set > "${out}" & echo READY & ping -n 30 127.0.0.1 > nul`,
      cwd: dir, env: { OPENAI_API_KEY: "sk-openai-fixture", APP_MODE: "dev" }, ready: { log: "READY" }, timeoutMs: 10_000,
    });
    try {
      await managed.start(new AbortController().signal);
      const text = await readFile(out, "utf8");
      expect(text).not.toContain("sk-openai-fixture");
      expect(text).toContain("APP_MODE=dev");
    } finally { await managed.close(); }
  } finally { await removeTempDir(dir); }
});

test("PROVIDER_KEY_NAMES matches the names Pi reads, so a Pi update can't drift", async () => {
  const source = await readFile(path.join(import.meta.dir, "../node_modules/@earendil-works/pi-ai/dist/env-api-keys.js"), "utf8");
  const start = source.indexOf("function getApiKeyEnvVars");
  const body = source.slice(start, source.indexOf("export function findEnvKeys"));
  const names = new Set([...body.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((match) => match[1]!));
  for (const match of source.matchAll(/export const \w+_ENV = "([A-Z0-9_]+)"/g)) names.add(match[1]!);
  expect([...PROVIDER_KEY_NAMES].sort()).toEqual([...names].sort());
});

test("withoutProviderKeys keeps everything else and honours keep", () => {
  const env = { OPENAI_API_KEY: "a", CENTRAL_CLIENT_SECRET: "b", PATH: "/bin", AWS_BEARER_TOKEN_BEDROCK: "c", PI_SECRET_TOKEN: "d" };
  expect(withoutProviderKeys(env)).toEqual({ CENTRAL_CLIENT_SECRET: "b", PATH: "/bin" });
  expect(withoutProviderKeys(env, ["OPENAI_API_KEY"])).toEqual({ OPENAI_API_KEY: "a", CENTRAL_CLIENT_SECRET: "b", PATH: "/bin" });
});

test("a command the AI runs never gets Casper's engine variables: a child omp, pi or casper uses its own config", () => {
  // As Casper's process has them after start-up: its state folder, offline and telemetry switches (src/runtime/agent-store.ts).
  const casper = { PATH: "/bin", HOME: "/home/someone", PI_CODING_AGENT_DIR: "/home/someone/.casper/agent", PI_OFFLINE: "1", PI_TELEMETRY: "0",
    PI_OAUTH_CALLBACK_HOST: "127.0.0.1", PI_TUI_WRITE_LOG: "/tmp/pi-tui.log", PI_CODING_AGENT_SESSION_DIR: "/home/someone/pi-sessions", CASPER_AGENT_DIR: "/home/someone/.casper/agent" };
  rememberPersonEngineEnv({});
  // omp read PI_CODING_AGENT_DIR and looked for its login in Casper's folder ("No API key found for anthropic").
  expect(withoutProviderKeys(casper)).toEqual({ PATH: "/bin", HOME: "/home/someone", PI_CODING_AGENT_SESSION_DIR: "/home/someone/pi-sessions", CASPER_AGENT_DIR: "/home/someone/.casper/agent" });
  // What the person's own shell set before Casper replaced it comes back as it was.
  rememberPersonEngineEnv({ PI_CODING_AGENT_DIR: "/home/someone/.omp/agent", PI_TELEMETRY: "0" });
  try {
    expect(withoutProviderKeys(casper)).toEqual({ PATH: "/bin", HOME: "/home/someone", PI_CODING_AGENT_DIR: "/home/someone/.omp/agent", PI_TELEMETRY: "0",
      PI_CODING_AGENT_SESSION_DIR: "/home/someone/pi-sessions", CASPER_AGENT_DIR: "/home/someone/.casper/agent" });
  } finally { rememberPersonEngineEnv({}); }
});

test("start-up remembers the person's own engine variables before Casper sets its own", async () => {
  await withEnv({ PI_CODING_AGENT_DIR: "/somewhere/.pi/agent", PI_OFFLINE: undefined, CASPER_OFFLINE: "1", PI_TELEMETRY: undefined, CASPER_AGENT_DIR: undefined }, () => {
    try {
      useCasperAgentStore();
      expect(process.env.PI_OFFLINE).toBe("1");
      const child = withoutProviderKeys(process.env);
      expect(child.PI_CODING_AGENT_DIR).toBe("/somewhere/.pi/agent");
      expect(child.PI_OFFLINE).toBeUndefined();
    } finally { rememberPersonEngineEnv({}); }
  });
});

test("the AI's bash, as omp would read it: no PI_CODING_AGENT_DIR of Casper's, the person's own one back", async () => {
  const run = async () => {
    let out = "";
    await casperBashOperations(undefined).exec('echo "dir=${PI_CODING_AGENT_DIR:-none} offline=${PI_OFFLINE:-none}"', process.cwd(), { onData: (data) => { out += data.toString(); }, timeout: 30 });
    return out.trim();
  };
  await withEnv({ PI_CODING_AGENT_DIR: "/casper-home/.casper/agent", PI_OFFLINE: "1" }, async () => {
    try {
      rememberPersonEngineEnv({});
      expect(await run()).toBe("dir=none offline=none");
      rememberPersonEngineEnv({ PI_CODING_AGENT_DIR: "/person/.omp/agent" });
      expect(await run()).toBe("dir=/person/.omp/agent offline=none");
    } finally { rememberPersonEngineEnv({}); }
  });
});
