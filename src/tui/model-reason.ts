import { truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { MODEL_REASON_PREFIX } from "./choices";
import { lineText } from "./format";

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Display-only: the last sentence, at most 100 characters plus an ellipsis. */
export function modelReasonSummary(text: string): string {
  const plain = lineText(text).replace(/\s+/g, " ").trim();
  const last = Array.from(sentences.segment(plain)).at(-1)?.segment.trim() ?? "";
  const chars = Array.from(last);
  return chars.length > 100 ? `${chars.slice(0, 100).join("")}…` : last;
}

/** Attribution and summary occupy exactly one terminal row, even in a narrow window. */
export function modelReasonLine(text: string, width: number): string {
  const reason = text.startsWith(MODEL_REASON_PREFIX) ? text.slice(MODEL_REASON_PREFIX.length) : text;
  return stripVTControlCharacters(truncateToWidth(`${MODEL_REASON_PREFIX}${modelReasonSummary(reason)}`, Math.max(1, width), "…"));
}
