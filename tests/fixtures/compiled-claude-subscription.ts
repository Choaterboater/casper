import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { CLAUDE_SUBSCRIPTION, registerClaudeSubscription, streamClaudeSubscription } from "../../src/runtime/claude-subscription";
const catalog = await ModelRuntime.create({ authPath: `${process.cwd()}/auth.json`, modelsPath: null, refreshOnCreate: false });
await registerClaudeSubscription(catalog, process.cwd(), { env: { ...process.env, CASPER_CLAUDE_PATH: process.argv[2] } });
const model = catalog.getModel(CLAUDE_SUBSCRIPTION, "claude-opus-4-8")!;
const response = await streamClaudeSubscription(model, normalizeContext({ messages: [{ role: "user", content: "synthetic fixture", timestamp: 1 }] }),
  { timeoutMs: 10_000 }, { executable: process.argv[2], env: { ...process.env, ANTHROPIC_API_KEY: "synthetic", ANTHROPIC_BASE_URL: "https://example.invalid" } }).result();
console.log(JSON.stringify(response));
if (response.stopReason !== "stop") process.exitCode = 1;
