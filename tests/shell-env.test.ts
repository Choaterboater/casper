import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedProcess } from "../src/platform/managed-process";
import { PROVIDER_KEY_NAMES, withoutProviderKeys } from "../src/platform/environment";
import { runCommandCheck } from "../src/verify/command";
import { POSIX } from "./support/platform";

const saved = { ...process.env };
afterEach(() => { for (const name of ["OPENROUTER_API_KEY", "MIST_API_TOKEN", "CASPER_TEST_SECRET_TOKEN"]) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

const PRINT = POSIX ? "printenv" : "set";

test("a repo check runs without AI provider keys; product tokens stay", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-provider-fixture";
  process.env.MIST_API_TOKEN = "mist-product-fixture";
  process.env.CASPER_TEST_SECRET_TOKEN = "casper-own-fixture";
  // Casper's own environment (no env given), as registry checks run.
  const inherited = await runCommandCheck({ name: "test", command: PRINT, cwd: os.tmpdir(), timeoutMs: 10_000 });
  expect(inherited.stdout).toContain("mist-product-fixture");
  expect(inherited.stdout).not.toContain("sk-or-provider-fixture");
  expect(inherited.stdout).not.toContain("casper-own-fixture");
  // An explicit environment (proof and trace copies pass one) is cleaned too.
  const given = await runCommandCheck({ name: "test", command: PRINT, cwd: os.tmpdir(), timeoutMs: 10_000,
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-fixture" } });
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
  } finally { await rm(dir, { recursive: true, force: true }); }
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
