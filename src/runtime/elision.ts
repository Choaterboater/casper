/**
 * Catches a write or edit that leaves a placeholder where code was, such as `// ... existing code ...` or
 * `# ... rest unchanged` (borrowed from skyn3t's elided-code check). Only a comment line counts, so spread
 * syntax (`...rest`) and a plain "unchanged" in prose never match. A placeholder line the old text already had
 * is not counted again. It is a note added to the tool result, never a refusal.
 */
const OPENER = String.raw`(?:\/\/|#|\/\*|<!--|--|\{\/\*)`;
const PHRASE = String.raw`(?:\.\.\.|…)\s*(?:unchanged|existing|rest\s+(?:of\b|unchanged)|remainder|same\s+as\s+before|snipped?|omitted|elided)`
  + String.raw`|(?:unchanged|existing\s+code|rest\s+of\s+(?:the\s+)?(?:file|code|implementation)|same\s+as\s+before|snipped?|omitted|elided)\s*(?:\.\.\.|…)`
  + String.raw`|(?:rest|remainder|everything\s+else)\s+of\s+(?:the\s+)?(?:file|code|implementation|function|class|module|method|component)\b[^\n]{0,40}?(?:unchanged|the\s+same|omitted|identical|as\s+before)`;
const MARKER = new RegExp(String.raw`^\s*${OPENER}\s*(?:${PHRASE})`, "i");

export const ELISION_NOTE = "The file now has a placeholder where code was. Write it in full or use edit.";

function markerLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!MARKER.test(line)) continue;
    const key = line.trim();
    lines.set(key, (lines.get(key) ?? 0) + 1);
  }
  return lines;
}

/** The placeholder lines in `after` that `before` did not already have. */
export function newElisions(before: string, after: string): string[] {
  const had = markerLines(before);
  const added: string[] = [];
  for (const [line, count] of markerLines(after)) {
    for (let index = had.get(line) ?? 0; index < count; index++) added.push(line);
  }
  return added;
}

/** The old and new text of a write (old file text given) or an edit (its oldText and newText). */
export function elisionTexts(toolName: string, input: Record<string, unknown>, oldFile: string | undefined): { before: string; after: string } | undefined {
  if (toolName === "write") return typeof input.content === "string" ? { before: oldFile ?? "", after: input.content } : undefined;
  if (toolName !== "edit") return undefined;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const pick = (key: string) => edits.map((edit) => {
    const value = edit && typeof edit === "object" ? Reflect.get(edit, key) : undefined;
    return typeof value === "string" ? value : "";
  }).join("\n");
  return { before: pick("oldText"), after: pick("newText") };
}
