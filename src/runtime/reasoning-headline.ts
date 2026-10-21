import { lineText, redactPreview } from "../tui/format";

const SENTENCES = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * A short headline of the model's reasoning, for the status row only (decision 24): the reasoning summary's latest
 * **Title** when it has one, else its latest finished sentence, at most 60 characters, markdown marks taken off and
 * secrets hidden. Undefined when there is nothing readable: the row then says `Reasoning · 3.0k chars`.
 */
export function reasoningHeadline(text: string): string | undefined {
  let line = [...text.matchAll(/\*\*([^*\n]{3,120})\*\*/g)].at(-1)?.[1];
  if (line === undefined) {
    const sentences = Array.from(SENTENCES.segment(text.replace(/\s+/g, " ").trim())).map(part => part.segment.trim()).filter(Boolean);
    const last = sentences.at(-1);
    // A sentence still being written may stop mid-word: the one before it, while there is one.
    line = last !== undefined && !/[.!?]$/.test(last) && sentences.length > 1 ? sentences.at(-2) : last;
  }
  if (line === undefined) return undefined;
  const shown = lineText(redactPreview(line)).replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim()
    .replace(/[\s.:;…]+$/, "");
  const chars = Array.from(shown);
  if (chars.length < 3) return undefined;
  return chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : shown;
}
