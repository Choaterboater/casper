/** The names /login gives providers, in its order (Enter picks OpenRouter). /model's refresh line uses them too, so an
 * expired sign-in reads as the row it was made from: "Anthropic API", never the Claude plan Claude Code keeps. */
export const SIGN_IN_NAMES = [
  ["openrouter", "OpenRouter"], ["claude-subscription", "Claude Pro/Max (Claude Code)"], ["anthropic", "Anthropic API"],
  ["openai-codex", "ChatGPT Plus/Pro (Codex)"], ["github-copilot", "GitHub Copilot"],
] as const;

/** A provider's /login name, or its own id when /login has no row for it. */
export function signInName(provider: string): string {
  return SIGN_IN_NAMES.find(([id]) => id === provider)?.[1] ?? provider;
}
