/** Small model windows (typically local models). Casper's own request (instructions plus tool
 * descriptions) takes about 4,600 tokens, and Pi keeps 16,384 tokens free for the reply when it
 * decides to compact, so an 8k window would compact on every turn. */
export const SMALL_WINDOW = 16_000;
export const COMPACTION_RESERVE_UNTIL = 32_000;
const MIN_RESERVE = 2_000;

/** The compaction reserve for a window below 32k: a quarter of it, at least 2,000. Undefined means
 * "leave Pi's default". */
export function compactionReserveFor(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  if (contextWindow >= COMPACTION_RESERVE_UNTIL) return undefined;
  return Math.max(MIN_RESERVE, Math.floor(contextWindow / 4));
}

export function smallWindowWarning(contextWindow: number | undefined): string | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0 || contextWindow >= SMALL_WINDOW) return undefined;
  return `This model's window is only ${contextWindow.toLocaleString("en-US")} tokens; Casper's own instructions take about 4,600 of them. `
    + "Expect short tasks only, or pick a model with 16k or more (see docs/CONFIGURATION.md, Local models).";
}

/** The least a request needs besides Casper's own part: the person's words and a short reply (Casper's smallest
 * output cap). */
export const MIN_TURN = 1_024;

/** Casper's own part of every request, in tokens (about 4 characters each): its instructions and its tools as sent. */
export function fixedRequestTokens(systemPrompt: string, tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>): number {
  const sent = tools.map(({ name, description, parameters }) => JSON.stringify({ name, description, parameters }).length);
  return Math.ceil((systemPrompt.length + sent.reduce((sum, size) => sum + size, 0)) / 4);
}

/** Why a window can't hold Casper's own part and one short turn, with the fix, or undefined when it can. Said
 * before the model is called: a request that doesn't fit is cut by the server and its reply cut short. */
export function windowTooSmall(contextWindow: number | undefined, fixed: number, model: { id: string; ollama?: boolean }): string | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0 || fixed + MIN_TURN <= contextWindow) return undefined;
  const words = (n: number) => n.toLocaleString("en-US");
  const why = `${model.ollama ? `Ollama serves ${model.id}` : `${model.id} has`} a ${words(contextWindow)}-token window, and Casper's own instructions and tools need about ${words(fixed)}, leaving no room for your request and the reply.`;
  return model.ollama
    ? `${why} Start Ollama with OLLAMA_CONTEXT_LENGTH=32768 ollama serve, or set PARAMETER num_ctx 32768 in a Modelfile, then try again; or /model to pick another.`
    : `${why} Pick a model with 16k or more (/model), or start its server with a bigger window.`;
}
