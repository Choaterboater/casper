/**
 * "stop asking" typed alone at the prompt opens the /permissions all box (1 Keep asking · 2 Stop asking until I quit),
 * as if /permissions all were typed, with no model call. It stands in for the shell box's old "Yes to everything this session"
 * row (docs/adr/0002/45-three-row-approvals.md). Only the whole short line counts: "stop asking about the tests and fix
 * them" or "don't ask the user again in the code" go to the AI. The box itself still asks, and Keep asking is first.
 */

const POLITE = String.raw`(?:(?:please|pls|casper|ok|okay)[,\s]+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const ASK = String.raw`(?:stop\s+asking|quit\s+asking|no\s+more\s+asking|don'?t\s+ask(?:\s+me)?\s+again|do\s+not\s+ask(?:\s+me)?\s+again)`;
const TAIL = String.raw`(?:\s+me)?(?:\s+(?:for\s+(?:permission|approval|my\s+ok)|every\s+time|each\s+time|all\s+the\s+time|this\s+session|please))*`;
const WHOLE = new RegExp(String.raw`^${POLITE}${ASK}${TAIL}$`, "i");

/** True when a typed line only asks Casper to stop asking. `pasted`: text pasted into the line; a line with any never counts. */
export function stopAskingRequest(line: string, pasted: readonly string[] = []): boolean {
  if (pasted.some(Boolean) || line.length > 80 || /[\r\n]/.test(line.trim())) return false;
  return WHOLE.test(line.trim().replace(/\s*[.!]+$/, ""));
}
