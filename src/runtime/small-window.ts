/** Small model windows (typically local models). Casper's own request (instructions plus tool
 * descriptions) takes about 4,600 tokens. Pi sizes compaction for a large window: it compacts once fewer than
 * 16,384 tokens are left and keeps the latest 20,000 word for word, which on a 32k window left it nothing older to
 * summarise, so it did nothing while each reply's room shrank to a token. */
export const SMALL_WINDOW = 16_000;
const PI_RESERVE = 16_384;
const PI_KEEP_RECENT = 20_000;
/** What Pi keeps spare under every reply's cap: it trims the reply to the window less the context and this. */
const PI_SPARE = 4_096;
/** Casper's own part of a request before the session can measure it. */
export const OWN_PART = 4_600;

/** The compaction reserve: room for the reply plus the 4,096 Pi keeps spare under it. The reply gets the quarter of the
 * window Casper allows a local model, but never more than half of what Casper's own part (`fixed`) and the spare leave,
 * so a small window keeps room for the conversation too. Undefined (from 49,152 tokens, where that reaches Pi's 16,384)
 * means "leave Pi's default". */
export function compactionReserveFor(contextWindow: number | undefined, fixed = OWN_PART): number | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const reply = Math.max(0, Math.min(Math.floor(contextWindow / 4), Math.floor((contextWindow - fixed - PI_SPARE) / 2)));
  return PI_SPARE + reply < PI_RESERVE ? PI_SPARE + reply : undefined;
}

/** How much of the latest conversation a compaction keeps word for word: a quarter of the conversation's room (the window
 * less the reserve and Casper's own part), at least 1,024, at most `keep` (Pi's 20,000, which large windows keep). */
export function compactionKeepFor(contextWindow: number | undefined, reserve: number, fixed: number, keep = PI_KEEP_RECENT): number | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return Math.min(keep, Math.max(MIN_TURN, Math.floor((contextWindow - reserve - fixed) / 4)));
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
