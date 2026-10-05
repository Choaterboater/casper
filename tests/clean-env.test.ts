import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./support/env";

const env = process.env as Record<string, string | undefined>;
const planted = ["PI_CODING_AGENT_DIR", "PI_MODEL", "CASPER_PROFILE", "CASPER_AGENT_DIR", "OPENROUTER_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "COPILOT_GITHUB_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "CLEAN_ENV_UNRELATED"];
const saved = Object.fromEntries(planted.map(name => [name, env[name]]));
afterEach(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete env[name]; else env[name] = value; });

test("cleanEnv drops ambient Pi, Casper and provider credential state but keeps the rest of the environment", () => {
  for (const name of planted) env[name] = "ambient";
  const clean = cleanEnv();
  for (const name of planted.filter(name => name !== "CLEAN_ENV_UNRELATED")) expect(clean[name]).toBeUndefined();
  expect(clean.CLEAN_ENV_UNRELATED).toBe("ambient");
  expect(clean.PATH).toBe(process.env.PATH);
});

test("cleanEnv keeps what a test sets explicitly, even in the stripped namespaces", () => {
  env.PI_MODEL = "ambient";
  const clean = cleanEnv({ HOME: "/tmp/home", CASPER_PROFILE: "default", PI_OFFLINE: "1", OPENAI_API_KEY: "fixture" });
  expect(clean).toMatchObject({ HOME: "/tmp/home", CASPER_PROFILE: "default", PI_OFFLINE: "1", OPENAI_API_KEY: "fixture" });
  expect(clean.PI_MODEL).toBeUndefined();
});

test("an undefined value in extra removes that variable rather than passing it through", () => {
  env.CLEAN_ENV_UNRELATED = "ambient";
  expect("CLEAN_ENV_UNRELATED" in cleanEnv({ CLEAN_ENV_UNRELATED: undefined })).toBe(false);
});

test("a fake HOME is the child's home folder on every OS, so a spawned Casper never reads the real profile", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-clean-env-home-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", "process.stdout.write(require('node:os').homedir())"], {
      env: cleanEnv({ HOME: home }), stdout: "pipe", stderr: "pipe",
    });
    const [out, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect({ exit, home: out }).toEqual({ exit: 0, home });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the search path has one key, PATH, whatever case the host or the test uses", () => {
  const pathKeys = (env: Record<string, string | undefined>) => Object.keys(env).filter(name => name.toUpperCase() === "PATH");
  expect(pathKeys(cleanEnv())).toEqual(["PATH"]);
  expect(cleanEnv().PATH).toBe(process.env.PATH);
  if (process.platform !== "win32") return; // names are case-sensitive elsewhere: Path and PATH are two variables
  const set = cleanEnv({ Path: "C:\\fixture-bin" });
  expect(pathKeys(set)).toEqual(["PATH"]);
  expect(set.PATH).toBe("C:\\fixture-bin");
});
