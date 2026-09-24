// Compiled-binary probe: derive request auth from a stored OAuth credential for every provider
// Casper's /login offers. Offline: toAuth only reads the credential. Setup comes from the same
// module the CLI imports before anything else.
import "../../src/runtime/engine-setup";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

const credential = { type: "oauth" as const, access: "tid=probe;proxy-ep=proxy.individual.githubcopilot.com", refresh: "probe", expires: Date.now() + 3_600_000 };
const results: Record<string, string> = {};
for (const provider of [openaiCodexProvider(), githubCopilotProvider(), anthropicProvider(), openrouterProvider()]) {
  try {
    const auth = await provider.auth.oauth!.toAuth(credential);
    results[provider.id] = auth.apiKey === credential.access ? "ok" : "unexpected auth";
  } catch (error) {
    results[provider.id] = error instanceof Error ? error.message : String(error);
  }
}
process.stdout.write(JSON.stringify(results));
