/**
 * Provider credentials Pi resolves from the environment (pi-ai `env-api-keys`): every `*_API_KEY`,
 * the Anthropic/Copilot/Hugging Face tokens, and ambient AWS/Google cloud credentials.
 */
const CREDENTIAL = /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$|^(COPILOT_GITHUB_TOKEN|HF_TOKEN|AWS_.*|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|GOOGLE_CLOUD_LOCATION)$/;

/**
 * The environment for a spawned Casper, Pi or fixture CLI: the caller's `process.env` without
 * ambient agent state, plus `extra`. A developer's own `PI_CODING_AGENT_DIR`, `PI_MODEL`,
 * `CASPER_PROFILE` or provider key would otherwise redirect the child's store, model or auth
 * and make the suite depend on the machine it runs on. Anything a test needs goes in `extra`,
 * which is applied after stripping, so explicit `PI_*`/`CASPER_*` settings survive; an
 * `undefined` there removes that variable too (e.g. `NO_COLOR`).
 */
export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("PI_") && !name.startsWith("CASPER_") && !CREDENTIAL.test(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) if (value === undefined) delete env[name]; else env[name] = value;
  return env;
}
