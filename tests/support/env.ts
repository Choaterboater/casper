import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Provider credentials Pi resolves from the environment (pi-ai `env-api-keys`): every `*_API_KEY`,
 * the Anthropic/Copilot/Hugging Face tokens, and ambient AWS/Google cloud credentials.
 */
const CREDENTIAL = /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$|^(COPILOT_GITHUB_TOKEN|HF_TOKEN|AWS_.*|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|GOOGLE_CLOUD_LOCATION)$/;

/** Windows variable names ignore case: `Path` (PowerShell) and `PATH` (Git Bash) are one variable. */
const WINDOWS = process.platform === "win32";

/** Remove every case variant of `name`, so the value set next is the only one the child sees. */
function unset(env: Record<string, string | undefined>, name: string): void {
  if (!WINDOWS) { delete env[name]; return; }
  for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
}

/** The key a test reads back: `PATH` stays `PATH` on Windows too, whatever case the host used. */
function canonical(name: string): string {
  return WINDOWS && name.toUpperCase() === "PATH" ? "PATH" : name;
}

/**
 * The environment for a spawned Casper, Pi or fixture CLI: the caller's `process.env` without
 * ambient agent state, plus `extra`. A developer's own `PI_CODING_AGENT_DIR`, `PI_MODEL`,
 * `CASPER_PROFILE` or provider key would otherwise redirect the child's store, model or auth
 * and make the suite depend on the machine it runs on. Anything a test needs goes in `extra`,
 * which is applied after stripping, so explicit `PI_*`/`CASPER_*` settings survive; an
 * `undefined` there removes that variable too (e.g. `NO_COLOR`).
 *
 * On Windows `os.homedir()` reads `USERPROFILE`, not `HOME`, and per-user tool folders come from
 * `APPDATA`/`LOCALAPPDATA`. A fake `HOME` alone would leave the child reading the real profile,
 * so it moves those too unless the test sets them itself.
 */
export function cleanEnv(extra: Record<string, string | undefined> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (!/^(PI_|CASPER_|GIT_)/.test(upper) && !CREDENTIAL.test(upper)
      && !/^(CI|NO_COLOR|FORCE_COLOR|TMUX|TMUX_PANE|ITERM_SESSION_ID|TERM_PROGRAM|COLORTERM)$/.test(upper)) env[canonical(name)] = value;
  }
  // Keep only the empty git config files installed by the preload, never ambient git configuration.
  if (isolatedGitConfig) Object.assign(env, { GIT_CONFIG_GLOBAL: isolatedGitConfig, GIT_CONFIG_SYSTEM: isolatedGitConfig });
  // A model server on the developer's computer (Ollama and the like) never answers a test's Casper; `extra` may undo it.
  const changes: Record<string, string | undefined> = { CASPER_LOCAL_MODELS: "off", ...extra };
  const given = (name: string) => Object.keys(extra).some(key => key.toUpperCase() === name);
  if (extra.HOME !== undefined) {
    if (!given("XDG_CONFIG_HOME")) changes.XDG_CONFIG_HOME = path.join(extra.HOME, ".config");
    if (!given("XDG_CACHE_HOME")) changes.XDG_CACHE_HOME = path.join(extra.HOME, ".cache");
    if (!given("XDG_DATA_HOME")) changes.XDG_DATA_HOME = path.join(extra.HOME, ".local", "share");
    if (!given("XDG_STATE_HOME")) changes.XDG_STATE_HOME = path.join(extra.HOME, ".local", "state");
  }
  if (WINDOWS && extra.HOME !== undefined) {
    if (!given("USERPROFILE")) changes.USERPROFILE = extra.HOME;
    if (!given("APPDATA")) changes.APPDATA = path.join(extra.HOME, "AppData", "Roaming");
    if (!given("LOCALAPPDATA")) changes.LOCALAPPDATA = path.join(extra.HOME, "AppData", "Local");
  }
  for (const [name, value] of Object.entries(changes)) {
    unset(env, name);
    if (value !== undefined) env[canonical(name)] = value;
  }
  return env;
}

let isolatedGitConfig: string | undefined;

/** One disposable home per test worker/file, including an ordinary empty file Git can open on Windows. */
export function isolatedEnvironment(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(path.join(os.tmpdir(), "casper-test-home-"));
  isolatedGitConfig = path.join(home, "empty-gitconfig");
  writeFileSync(isolatedGitConfig, "");
  return { home, env: cleanEnv({ HOME: home, TERM: "dumb" }) };
}

/** In-process environment fixtures only: keep tests using this helper serial; pass cleanEnv to children instead. */
export async function withEnv<T>(extra: NodeJS.ProcessEnv, body: () => T | Promise<T>): Promise<T> {
  const saved = { ...process.env };
  try {
    for (const [name, value] of Object.entries(extra)) {
      unset(process.env, name);
      if (value !== undefined) process.env[canonical(name)] = value;
    }
    return await body();
  } finally {
    for (const name of Object.keys(process.env)) unset(process.env, name);
    Object.assign(process.env, saved);
  }
}
