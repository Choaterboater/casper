/**
 * A model named in words: `/model opus 5.5` (src/runtime/model-words.ts finds it), the numbered question when words
 * name several, and a typed line that only asks to change the model ("change model to opus 5.5"), which Casper does
 * itself with no model call. That line is read only when the person typed all of it, it is short and whole, and its
 * target names a model you can pick; anything else goes to the AI as before.
 */

import type { InteractiveTerminal } from "../tui/terminal";
import type { RuntimeModelWordsMatch, RuntimeSession } from "../runtime/types";
import { terminalText } from "../tui/format";

type Listed = { provider: string; id: string; name: string };

/** The numbered question for words that name several models (at most 4); undefined (Esc) changes nothing. */
export function chooseModel(terminal: Pick<InteractiveTerminal, "pick">, words: string, signal?: AbortSignal) {
  return async (models: Listed[]): Promise<{ provider: string; id: string } | undefined> => {
    const labels = models.map((model) => `${model.provider}/${model.id}`);
    const answer = await terminal.pick(`"${terminalText(words)}" names ${models.length} models. Which one?`,
      models.map((model, index) => ({ label: terminalText(labels[index]!), ...(model.name && model.name !== model.id ? { description: terminalText(model.name) } : {}) })), signal);
    const picked = answer === undefined ? -1 : labels.findIndex((label) => terminalText(label) === answer);
    return picked === -1 ? undefined : { provider: models[picked]!.provider, id: models[picked]!.id };
  };
}

/** `"opus" names several models: a, b. Type /model <provider/id>. Model unchanged.` */
export function severalModelsMessage(words: string, models: ReadonlyArray<{ provider: string; id: string }>): string {
  return `${JSON.stringify(words)} names several models: ${models.map((model) => `${model.provider}/${model.id}`).join(", ")}. Type /model <provider/id>. Model unchanged.`;
}

// "change model to X", "change the model to X", "set model to X", "switch model to X", "switch to X", "change to X",
// "use X", "use model X", "use the X model": the whole line, nothing before or after but please and a full stop.
const REQUEST = /^(?:please\s+)?(?:(?:change|switch|set)\s+(?:the\s+|my\s+)?model\s+to|(?:switch|change)\s+to(?:\s+the)?(?:\s+model)?|use(?:\s+the)?(?:\s+model)?)\s+(.+?)(?:\s+model)?(?:\s+(?:please|now|instead))?\s*[.!]?$/i;
// The target: model-id characters only, at most 5 words. No file name (models.py), path (src/x), code or quotes.
const TARGET = /^[a-z0-9][a-z0-9 .:_/-]*$/i;
// Words that are part of many model ids but name none by themselves: "use flash", "use the latest", "switch to auto".
const GENERIC = new Set(["auto", "free", "latest", "preview", "mini", "nano", "lite", "small", "medium", "large", "fast", "flash",
  "pro", "max", "plus", "turbo", "instruct", "chat", "thinking", "reasoning", "beta", "exp", "experimental", "base", "code", "coder",
  "vision", "online", "default", "local", "new", "old", "it"]);
// Model families a bare "use X" or "switch to X" may name without a version; any other word needs one, or the word
// "model" in the line ("use the step model"), so "use next", "use search" and "switch to main" stay requests.
const FAMILIES = new Set(["claude", "opus", "sonnet", "haiku", "fable", "gpt", "codex", "gemini", "gemma", "llama", "qwen", "qwq",
  "deepseek", "mistral", "mixtral", "codestral", "devstral", "magistral", "grok", "kimi", "glm", "minimax", "nemotron", "phi"]);
// A size (70b, 2.4t), a version alone (v3) or a letter or two (r, x): never a model by itself.
const BARE = /^(?:\d+(?:\.\d+)?[bkmt]?|v\d+|[a-z]{1,2})$/i;

/** The model a typed line asks to change to, or undefined when the line is anything else. `pasted`: text pasted into
 * the line; a line with any never counts. */
export function modelChangeRequest(line: string, pasted: readonly string[] = []): string | undefined {
  if (pasted.some(Boolean) || line.length > 80 || /[\r\n]/.test(line.trim())) return undefined;
  const target = REQUEST.exec(line.trim())?.[1]?.trim();
  if (!target || !TARGET.test(target)) return undefined;
  const words = target.split(/\s+/);
  if (words.length > 5) return undefined;
  // A file name or path: models.py, src/model.ts, ./x, a/b/c.
  if (words.some((word) => /\.[a-z]{1,5}$/i.test(word) || word.startsWith(".") || (word.match(/\//g)?.length ?? 0) > 1)) return undefined;
  // Something more than generic words, sizes and numbers.
  const parts = target.toLowerCase().split(/[\s\-_:/]+/).filter(Boolean);
  if (!parts.some((part) => /[a-z]/.test(part) && !GENERIC.has(part) && !BARE.test(part))) return undefined;
  // Without the word "model", a version or a family name.
  const named = /\bmodel\b/i.test(line.trim().replace(target, ""));
  if (!named && !/\d/.test(target) && !FAMILIES.has(/^[a-z]+/i.exec(target)?.[0]?.toLowerCase() ?? "")) return undefined;
  return target;
}

/** Whether `target` starts the name of a model you can pick (one, or several to choose from): `next` is no model
 * though qwen3-coder-next ends with it. Makes no model call. `wait: false` (during a task): no wait for model servers
 * on this computer still being found, so the line is not held. */
export async function namesModel(session: Pick<RuntimeSession, "matchModel"> | undefined, target: string, wait = true): Promise<boolean> {
  let match: RuntimeModelWordsMatch | undefined;
  try { match = await session?.matchModel?.(target, { head: true, ...(wait ? {} : { wait: false }) }); } catch { match = undefined; }
  return match !== undefined && match.kind !== "none";
}

/** The one line that says Casper changed the model itself. */
export const handledHere = (target: string) => `[model] Handled here, no model call: /model ${terminalText(target)} does the same.\n`;
