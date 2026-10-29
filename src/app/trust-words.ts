/**
 * A typed line that only says to trust this folder, or to stop ("trust this folder", "I trust this repo", "stop
 * trusting this folder", "untrust this project"): Casper runs /trust or /trust off itself, with no model call, as it does
 * for "change model to opus 5.5" (src/app/model-words.ts). Only a whole short line the person typed counts; a question
 * ("do you trust this repo?") or code ("trust the user's input in this folder") goes to the AI as before.
 */

import { terminalText } from "../tui/format";

const THING = String.raw`(?:this|the|current|my|our)\s+(?:folder|project|repo|repository|directory|dir|workspace)`;
const POLITE = String.raw`(?:(?:please|pls|ok|okay|yes|casper)[,\s]+)*`;
const ON = new RegExp(String.raw`^${POLITE}(?:i\s+)?(?:trust|(?:mark|set)\s+${THING}\s+(?:as\s+)?trusted\b)(?:\s+${THING})?$`, "i");
const OFF = new RegExp(String.raw`^${POLITE}(?:(?:stop|quit)\s+trusting|untrust|(?:don'?t|do\s+not|no\s+longer)\s+trust|forget\s+(?:my\s+)?trust\s+(?:for|in|of))\s+${THING}$`, "i");

/** "on" or "off" when the typed line only asks to trust this folder or stop; undefined for anything else. `pasted`: text
 * pasted into the line; a line with any never counts. */
export function trustRequest(line: string, pasted: readonly string[] = []): "on" | "off" | undefined {
  if (pasted.some(Boolean) || line.length > 80 || /[\r\n]/.test(line.trim())) return undefined;
  const text = line.trim().replace(/\s*[.!]+$/, "").trim();
  if (OFF.test(text)) return "off";
  // "trust" alone with nothing after it is too short to be sure of; "mark this folder as trusted" names it itself.
  const on = ON.exec(text);
  return on && (new RegExp(THING, "i").test(text)) ? "on" : undefined;
}

/** The /trust line the words ask for. */
export const trustLine = (request: "on" | "off") => request === "on" ? "/trust" : "/trust off";

/** The one line that says Casper did it itself. */
export const trustHandledHere = (line: string) => `[trust] Handled here, no model call: ${terminalText(line)} does the same.\n`;
