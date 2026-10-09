import type { RuntimeTool } from "../runtime/types";

/** Hard cap on clarifying questions per task; the tool result reports the remaining budget. */
export const ASK_BUDGET = 8;
const MAX_INPUT_BYTES = 4096;

export interface AskChannel {
  /** True only in an interactive session with the rich surface available. */
  available(): boolean;
  /** Undefined means the question was skipped, aborted or never rendered. */
  ask(question: string, options: { label: string; description?: string }[], multi: boolean, signal?: AbortSignal): Promise<string[] | undefined>;
  /** Called once per question with its answer, e.g. `Postgres | skipped` (the answered box is the transcript record). */
  record(answer: string): void;
}

/** Model-callable `ask` tool: one structured clarification with 2–4 concrete options and free text.
 * Degrades honestly outside interactive sessions (structured error, never a block) and is
 * budget-capped per task; a fresh instance per prepareCapabilities call resets the budget. */
export function askTool(channel: AskChannel): RuntimeTool {
  let used = 0;
  return {
    name: "ask",
    sequential: true,
    description: `Ask the human to choose or confirm something at any point (unclear requirements, "shall I do X next?") instead of ending a reply with a question in prose. Give 2–4 concrete options (labels plus short descriptions), the safe choice first; the human picks one, types an answer, or skips. After the answer, reply with only what is new: don't repeat what you showed before asking. Budget: ${ASK_BUDGET} questions per task — when it runs out, state your assumptions in the reply instead.`,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["question", "options"],
      properties: {
        question: { type: "string", description: "One specific question; never ask what the repository already answers." },
        options: {
          type: "array", minItems: 2, maxItems: 4,
          items: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string" }, description: { type: "string" } } },
        },
        multi: { type: "boolean", description: "Allow choosing several options." },
      },
    },
    execute: async (args, signal) => {
      if (Buffer.byteLength(JSON.stringify(args)) > MAX_INPUT_BYTES) return { text: "Question exceeds the 4 KiB input limit; shorten it.", isError: true };
      if (!channel.available()) return { text: JSON.stringify({ skipped: true, reason: "Clarification needs an interactive terminal; state your assumptions in the reply and continue." }), isError: true };
      if (used >= ASK_BUDGET) return { text: JSON.stringify({ skipped: true, reason: `Question budget exhausted (${ASK_BUDGET} per task); state your assumptions and continue.` }), isError: true };
      const question = typeof args.question === "string" ? args.question.trim() : "";
      const options = Array.isArray(args.options) ? args.options : [];
      if (!question) return { text: "Expected a nonempty question string.", isError: true };
      const clean = options.map(option => {
        if (typeof option !== "object" || option === null || !("label" in option) || typeof option.label !== "string") return undefined;
        const label = option.label.trim();
        if (!label) return undefined;
        const description = "description" in option && typeof option.description === "string" ? option.description.trim() : undefined;
        return { label, description };
      }).filter(option => option !== undefined);
      if (clean.length < 2) return { text: "Expected 2–4 options, each with a nonempty label.", isError: true };
      const answer = await channel.ask(question, clean, args.multi === true, signal);
      used++;
      channel.record(answer ? answer.join(" | ") : "skipped");
      return { text: JSON.stringify({ answers: answer ?? [], skipped: !answer, remaining: ASK_BUDGET - used }) };
    },
  };
}
