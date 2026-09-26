import { afterEach, expect, test } from "bun:test";
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
