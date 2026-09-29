import fastapiRulesText from "./rules/fastapi.yaml" with { type: "text" };
import mcpRulesText from "./rules/mcp.yaml" with { type: "text" };

/**
 * Casper's own MIT semgrep rules, embedded as text so the release binary carries them. They are written
 * to a temp folder for each run: semgrep never fetches `auto` or registry (`p/…`) rules, which are under
 * a non-OSI licence and need the network.
 */
export const mcpRules: string = mcpRulesText as unknown as string;
export const fastapiRules: string = fastapiRulesText as unknown as string;

/** Every rule id Casper ships, for tests and the docs. */
export function ruleIds(text: string): string[] {
  return [...text.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((match) => match[1]!);
}
