/** Synthetic prompt replay against a real, local Ollama model. No repo files or cloud models are sent.
 * Usage: bun run scripts/measure-tool-history.ts [model] [rounds=20] [num_ctx=32768]
 * A 300-line read lands every six rounds; the rest are short replies. Each arm starts from a cold prefix.
 * `prompt_eval_count` is the whole prompt; duration shows what the warm prefix saved. */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { ToolHistory } from "../src/runtime/tool-history";

const base = "http://127.0.0.1:11434";
const tags = await fetch(`${base}/api/tags`).then((response) => response.json()) as {
  models: Array<{ name: string; remote_model?: string; remote_host?: string; capabilities?: string[] }> };
const model = process.argv[2] ?? tags.models.find((entry) => !entry.remote_model && !entry.remote_host && entry.capabilities?.includes("completion"))?.name;
const entry = tags.models.find((entry) => entry.name === model);
if (!entry || entry.remote_model || entry.remote_host) throw new Error("Choose an installed local completion model; cloud models are not measured.");
const rounds = Number(process.argv[3] ?? 20);
const numCtx = Number(process.argv[4] ?? 32_768);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const source = (read: number) => Array.from({ length: 300 }, (_, n) => `const item${read}_${n} = ${n}; // synthetic fixture line ${n}`).join("\n");
const totals: Record<string, { prompt_eval_ms: number; checkpoints: number; last_prompt_eval_count: number }> = {};
for (const enabled of [false, true]) {
  const mode = enabled ? "on" : "off";
  const history = new ToolHistory();
  const messages: Message[] = [{ role: "system", content: `Synthetic ${mode.padEnd(3)} ${Date.now()} cache experiment. Reply OK.`, timestamp: 0 },
    { role: "user", content: "Continue the synthetic task.", timestamp: 0 }];
  let previous: Message[] = [];
  const total = totals[mode] = { prompt_eval_ms: 0, checkpoints: 0, last_prompt_eval_count: 0 };
  for (let round = 1; round <= rounds; round++) {
    const reads = round % 6 === 1;
    const id = `sample_read_${round}`;
    const assistant: AssistantMessage = { role: "assistant", timestamp: round, api: "openai-completions", provider: "fixture",
      model: "fixture", usage, stopReason: reads ? "toolUse" : "stop",
      content: reads ? [{ type: "toolCall", id, name: "read", arguments: { path: `src/sample-${round}.ts` } }]
        : [{ type: "text", text: `Completed synthetic step ${round}.` }] };
    messages.push(assistant);
    if (reads) messages.push({ role: "toolResult", toolCallId: id, toolName: "read", timestamp: round,
      content: [{ type: "text", text: source(round) }], isError: false });
    messages.push({ role: "user", content: `Continue step ${round + 1}.`, timestamp: round });
    const projected = history.project(messages, enabled, { contextWindow: numCtx });
    const prompt = JSON.stringify(projected.messages) + "\nReply OK.";
    const response = await fetch(`${base}/api/generate`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, raw: true, stream: false, keep_alive: "5m",
        options: { num_ctx: numCtx, num_predict: 1, temperature: 0, seed: 0 } }), signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const result = await response.json() as { error?: string; prompt_eval_count: number; prompt_eval_duration: number };
    if (result.error) throw new Error(result.error);
    const sample = { mode, round, checkpoint: Boolean(projected.checkpoint), hidden: projected.checkpoint?.masks.length ?? 0,
      prompt_eval_count: result.prompt_eval_count, prompt_eval_ms: Math.round(result.prompt_eval_duration / 1e6),
      prefix_messages_identical: JSON.stringify(projected.messages.slice(0, previous.length)) === JSON.stringify(previous) };
    console.log(JSON.stringify(sample));
    // Round 1 is the cold start in both arms; the comparison is everything after it.
    if (round > 1) total.prompt_eval_ms += sample.prompt_eval_ms;
    total.checkpoints += sample.checkpoint ? 1 : 0;
    total.last_prompt_eval_count = sample.prompt_eval_count;
    previous = projected.messages;
  }
}
console.log(JSON.stringify({ model, rounds, num_ctx: numCtx, totals_after_round_1: totals }, null, 2));
