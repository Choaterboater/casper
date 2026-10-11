import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Casper's startup default (`provider/model`) from the text of ~/.casper/settings.json, or undefined. */
export function defaultModelIn(settingsText: string): string | undefined {
  try {
    const value = JSON.parse(settingsText);
    if (typeof value?.defaultProvider !== "string" || typeof value?.defaultModel !== "string") return undefined;
    if (!value.defaultProvider || !value.defaultModel) return undefined;
    return `${value.defaultProvider}/${value.defaultModel}`;
  } catch { return undefined; }
}

export async function casperDefaultModel(home: string = os.homedir()): Promise<string | undefined> {
  try { return defaultModelIn(await readFile(path.join(home, ".casper", "settings.json"), "utf8")); } catch { return undefined; }
}

/** SkyN3t's model choices that could steer a stage to another model; each run sets them so only the picked model is used. */
const OPENROUTER_TIERS = ["SKYN3T_MODEL_CHEAP", "SKYN3T_MODEL_UI", "SKYN3T_MODEL_BACKEND", "SKYN3T_MODEL_STRONG", "SKYN3T_MODEL_DOCS"];
const CLI_BACKENDS: Record<string, string> = { anthropic: "claude_cli", "openai-codex": "codex_cli", "github-copilot": "copilot_cli" };

/**
 * The SkyN3t settings that make it use the same model as Casper's `provider/model`. They are passed as
 * environment variables, which beat SkyN3t's .env file and its saved tuning. SkyN3t reaches the model
 * through the matching command-line tool (claude, codex, copilot) or OpenRouter, so that tool must be
 * signed in on this computer too.
 */
export function skyn3tModelEnv(model: string): { env: Record<string, string>; via: string } | { error: string } {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const id = slash > 0 ? model.slice(slash + 1) : "";
  if (!provider || !id) return { error: `"${model}" is not a provider/model name (for example anthropic/claude-sonnet-5-5).` };
  const fixed = {
    SKYN3T_CODEGEN_CLI_PROVIDER: "", SKYN3T_CODEGEN_MODEL_SLOT: "", SKYN3T_REPAIR_MODEL_SLOT: "",
    SKYN3T_BEST_OF_N_ACROSS_MODELS: "false", SKYN3T_AUTO_ROUTE: "false", SKYN3T_MODEL_EVOLUTION: "false",
  };
  const backend = CLI_BACKENDS[provider];
  if (backend) {
    return {
      via: `${backend.replace("_cli", "")} command-line tool, model ${id}`,
      env: {
        ...fixed, SKYN3T_LLM_BACKEND: backend, SKYN3T_CODEGEN_CLI_MODEL: id,
        ...Object.fromEntries(OPENROUTER_TIERS.map((name) => [name, ""])),
        // SkyN3t never uses Claude while no_claude is on; the run asked for Claude, so it is off for this run only.
        ...(provider === "anthropic" ? { SKYN3T_NO_CLAUDE: "false" } : {}),
      },
    };
  }
  if (provider === "openrouter") {
    return {
      via: `OpenRouter, model ${id}`,
      env: {
        ...fixed, SKYN3T_LLM_BACKEND: "openrouter", SKYN3T_PREFERRED_MODEL: id, SKYN3T_OPENROUTER_CODEGEN_MODEL: id,
        ...Object.fromEntries(OPENROUTER_TIERS.map((name) => [name, id])),
        SKYN3T_FREE_ONLY: id.endsWith(":free") ? "true" : "false",
        ...(id.startsWith("anthropic/") ? { SKYN3T_NO_CLAUDE: "false" } : {}),
      },
    };
  }
  return {
    error: `SkyN3t can't use ${provider} models. Pick a model from anthropic, openai-codex, github-copilot or openrouter `
      + "(with --model, or when the script asks).",
  };
}
