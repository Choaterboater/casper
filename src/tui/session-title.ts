const MAX = 40;

/** A short name for a conversation from its first request ("IPv4 subnet calculator"), like the title a chat
 * gets. Plain text rules, never a model call. Undefined when there is nothing to name (blank, a slash command). */
export function sessionTitle(request: string): string | undefined {
  let text = request.split("\n").map(line => line.trim()).find(Boolean) ?? "";
  if (text.startsWith("/")) return undefined;
  text = text.replace(/^(?:please|can you|could you|would you)\b[\s,]*/i, "");
  // "Build a small web app in this folder: an IPv4 subnet calculator." names the thing after the colon.
  const after = /^[^:]{1,80}:\s+(\S+\s+\S.*)$/.exec(text);
  if (after) text = after[1]!;
  text = text.split(/[.!?;](?:\s|$)|\s[—–-]\s/)[0]!.replace(/^(?:a|an|the)\s+/i, "").replace(/[\s.,:;!?]+$/, "");
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
  if (text.length <= MAX) return text;
  let short = "";
  for (const word of text.split(/\s+/)) {
    const next = short ? `${short} ${word}` : word;
    if (next.length > MAX) break;
    short = next;
  }
  return `${short || text.slice(0, MAX)}…`;
}

/** The window title: ◐ while Casper works, the plain name while it waits for you. */
export function windowTitle(name: string, busy: boolean): string {
  return `${busy ? "◐ " : ""}Casper · ${name}`;
}
