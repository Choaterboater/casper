import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEnv, withEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";
import { run } from "./support/run";

const ambient = {
  PI_CODING_AGENT_DIR: "ambient", PI_MODEL: "ambient", CASPER_PROFILE: "ambient", CASPER_AGENT_DIR: "ambient",
  OPENROUTER_API_KEY: "fixture-key", ANTHROPIC_OAUTH_TOKEN: "fixture-token", COPILOT_GITHUB_TOKEN: "fixture-token",
  AWS_BEARER_TOKEN_BEDROCK: "fixture-token", CI: "1", GIT_DIR: "missing-git-dir", GIT_WORK_TREE: "wrong-tree",
  GIT_INDEX_FILE: "wrong-index", GIT_CONFIG_GLOBAL: "wrong-global", GIT_CONFIG_SYSTEM: "wrong-system",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "wrong-editor",
  GIT_AUTHOR_NAME: "ambient", GIT_COMMITTER_EMAIL: "ambient@example.invalid", NO_COLOR: "1", FORCE_COLOR: "3",
  TMUX: "ambient", TMUX_PANE: "%42", ITERM_SESSION_ID: "ambient", TERM_PROGRAM: "ambient", COLORTERM: "truecolor",
};

test("cleanEnv drops CI, all git overrides, colour, terminal, agent and credential state, keeping unrelated variables", () => {
  const clean = cleanEnv({}, { ...ambient, CLEAN_ENV_UNRELATED: "kept", PATH: process.env.PATH });
  for (const name of Object.keys(ambient)) {
    if (name === "GIT_CONFIG_GLOBAL" || name === "GIT_CONFIG_SYSTEM") expect(clean[name]).toBe(process.env.GIT_CONFIG_GLOBAL);
    else expect(clean[name], name).toBeUndefined();
  }
  expect(clean.CLEAN_ENV_UNRELATED).toBe("kept");
  expect(clean.PATH).toBe(process.env.PATH);
});

test("explicit fixture settings survive stripping; undefined removes a variable", () => {
  const clean = cleanEnv({ CI: "1", GIT_DIR: "fixture", CASPER_PROFILE: "default", PI_OFFLINE: "1", NO_COLOR: "1", KEEP: undefined }, { ...ambient, KEEP: "old" });
  expect(clean).toMatchObject({ CI: "1", GIT_DIR: "fixture", CASPER_PROFILE: "default", PI_OFFLINE: "1", NO_COLOR: "1" });
  expect(clean.PI_MODEL).toBeUndefined();
  expect("KEEP" in clean).toBe(false);
});

test("withEnv restores set, unset and newly created variables after success, rejection and nested fixtures", async () => {
  const before = { ...process.env };
  await withEnv({ CI: "fixture", NO_COLOR: undefined, ENV_FIXTURE_NEW: "yes" }, async () => {
    expect(process.env.CI).toBe("fixture");
    expect(process.env.NO_COLOR).toBeUndefined();
    await withEnv({ CI: "nested" }, () => expect(process.env.CI).toBe("nested"));
    expect(process.env.CI).toBe("fixture");
  });
  expect({ ...process.env }).toEqual(before);
  await expect(withEnv({ HOME: "fixture", ENV_FIXTURE_NEW: "yes" }, async () => { throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
  expect({ ...process.env }).toEqual(before);
});

test("a fake HOME moves home-derived state and is os.homedir in a child on every OS", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-clean-env-home-"));
  try {
    const env = cleanEnv({ HOME: home });
    expect(env.XDG_CONFIG_HOME).toBe(path.join(home, ".config"));
    expect(env.XDG_CACHE_HOME).toBe(path.join(home, ".cache"));
    expect(env.XDG_DATA_HOME).toBe(path.join(home, ".local", "share"));
    expect(env.XDG_STATE_HOME).toBe(path.join(home, ".local", "state"));
    if (process.platform === "win32") {
      expect(env.USERPROFILE).toBe(home);
      expect(env.APPDATA).toBe(path.join(home, "AppData", "Roaming"));
      expect(env.LOCALAPPDATA).toBe(path.join(home, "AppData", "Local"));
    }
    const child = await run([process.execPath, "-e", "process.stdout.write(require('node:os').homedir())"], { env, timeoutMs: 15_000 });
    expect({ exit: child.status, home: child.stdout }).toEqual({ exit: 0, home });
  } finally { await removeTempDir(home); }
});

test("the search path has one canonical PATH key on Windows", () => {
  const source = process.platform === "win32" ? { Path: "fixture-bin" } : { PATH: "fixture-bin" };
  expect(cleanEnv({}, source).PATH).toBe("fixture-bin");
  if (process.platform === "win32") {
    const set = cleanEnv({ Path: "fixture-replacement" }, source);
    expect(Object.keys(set).filter(name => name.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(set.PATH).toBe("fixture-replacement");
  }
});

test("a spawned Casper finds no ambient model server unless the fixture explicitly asks", () => {
  expect(cleanEnv().CASPER_LOCAL_MODELS).toBe("off");
  expect(cleanEnv({ CASPER_LOCAL_MODELS: undefined }).CASPER_LOCAL_MODELS).toBeUndefined();
});

test("preload isolates each real test file from a hostile parent environment and uses an empty portable git config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-preload-env-"));
  try {
    const preload = path.resolve(import.meta.dir, "support/preload.ts");
    const files = ["first", "second"].map(name => path.join(root, `${name}.test.ts`));
    const body = `import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
test('isolated file', async () => {
  const names = ${JSON.stringify(Object.keys(ambient).filter(name => !name.startsWith("GIT_CONFIG_")))};
  for (const name of names) expect(process.env[name], name).toBeUndefined();
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) expect(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']).toContain(name);
    if (name.startsWith('CASPER_')) expect(name).toBe('CASPER_LOCAL_MODELS');
  }
  expect(process.env.CASPER_LOCAL_MODELS).toBe('off');
  const home = process.env.HOME;
  expect(home).not.toBe(${JSON.stringify(root)});
  expect(existsSync(path.join(home, 'ambient-marker'))).toBe(false);
  const child = Bun.spawn([process.execPath, '-e', 'process.stdout.write(require("node:os").homedir())'], { env: process.env, stdout: 'pipe' });
  expect(await new Response(child.stdout).text()).toBe(home);
  expect(await child.exited).toBe(0);
  expect(readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
  expect(process.env.GIT_CONFIG_SYSTEM).toBe(process.env.GIT_CONFIG_GLOBAL);
  expect(process.env.XDG_CONFIG_HOME).toBe(path.join(home, '.config'));
});`;
    for (const file of files) await writeFile(file, body);
    await writeFile(path.join(root, "ambient-marker"), "developer state");
    const result = await run([process.execPath, "test", "--parallel=4", "--preload", preload, ...files], {
      env: cleanEnv({ ...ambient, HOME: root }), timeoutMs: 60_000,
    });
    expect(result.timedOut).toBe(false);
    expect({ status: result.status, errors: result.stderr }).toEqual({ status: 0, errors: expect.stringContaining("2 pass") });
    expect(await readFile(process.env.GIT_CONFIG_GLOBAL!, "utf8")).toBe("");
  } finally { await removeTempDir(root); }
}, 90_000);
