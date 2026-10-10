/**
 * Environment for a spawned adapter, browser or development server: the OS
 * variables a process needs to start at all, never inherited provider
 * credentials. `home` becomes the isolated user directory for that process.
 */
export function isolatedEnvironment(home: string, additions: Record<string, string> = {}): Record<string, string> {
  if (process.platform !== "win32") return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, ...additions };
  // Windows programs resolve the user directory from USERPROFILE and the
  // loader/console paths from SystemRoot, so those cannot be dropped the way
  // POSIX tools tolerate a HOME-only environment.
  const env: Record<string, string> = {};
  for (const name of ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "ProgramData", "ProgramFiles", "ProgramFiles(x86)"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.PATH = process.env.PATH ?? "";
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = home;
  env.LOCALAPPDATA = home;
  env.TEMP = home;
  env.TMP = home;
  return { ...env, ...additions };
}

/**
 * The AI provider keys Pi reads from the environment, copied from pi-ai's env-api-keys.js
 * (getApiKeyEnvVars and its *_ENV names, Anthropic federation sign-in included) and pinned by tests/shell-env.test.ts
 * so a Pi update can't drift silently.
 */
export const PROVIDER_KEY_NAMES: readonly string[] = [
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_WORKSPACE_ID", "COPILOT_GITHUB_TOKEN",
  "ANT_LING_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY",
  "NVIDIA_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "TYPESAFE_API_KEY",
  "RADIUS_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "HF_TOKEN", "FIREWORKS_API_KEY", "TOGETHER_API_KEY",
  "BASETEN_API_KEY", "OPENCODE_API_KEY", "KIMI_API_KEY", "META_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
];
/** Provider logins Pi reads outside that list (Amazon Bedrock's own bearer token). */
const EXTRA_PROVIDER_NAMES = ["AWS_BEARER_TOKEN_BEDROCK"];
/** Casper's and Pi's own variables that hold a secret. */
const OWN_SECRET = /^(?:CASPER|PI)_.*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i;

/** True when `name` is a variable Pi reads a model provider's key or login from (not Casper's own secrets). */
export function isModelProviderKeyName(name: string): boolean {
  return PROVIDER_KEY_NAMES.includes(name) || EXTRA_PROVIDER_NAMES.includes(name);
}

/** True when `name` is an AI provider key or one of Casper's own secrets. */
export function isProviderKeyName(name: string): boolean {
  const upper = name.toUpperCase();
  return PROVIDER_KEY_NAMES.includes(upper) || EXTRA_PROVIDER_NAMES.includes(upper) || OWN_SECRET.test(name);
}

/**
 * `env` without AI provider keys (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ...) and Casper's own secrets.
 * Network product tokens (MIST_API_TOKEN, CENTRAL_*) and everything else stay, so a project's own
 * tests keep working. `keep` names survive on purpose.
 */
export function withoutProviderKeys(env: NodeJS.ProcessEnv, keep: readonly string[] = []): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  // The private ssh login's pointer (src/ssh/askpass.ts) is for the one ssh command Casper starts it for. Where it turns up
  // anywhere else it goes, with the SSH_ASKPASS that points at Casper; your own SSH_ASKPASS is left alone.
  const ourAskpass = Boolean(env.CASPER_ASKPASS_ENDPOINT || env.CASPER_ASKPASS_TOKEN);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ourAskpass && /^(?:CASPER_ASKPASS_(?:ENDPOINT|TOKEN)|SSH_ASKPASS(?:_REQUIRE)?)$/.test(name)) continue;
    if (isProviderKeyName(name) && !keep.includes(name)) continue;
    clean[name] = value;
  }
  return clean;
}
