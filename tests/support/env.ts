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
export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("PI_") && !name.startsWith("CASPER_") && !CREDENTIAL.test(name)) env[canonical(name)] = value;
  }
  const changes = { ...extra };
  const given = (name: string) => Object.keys(extra).some(key => key.toUpperCase() === name);
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
