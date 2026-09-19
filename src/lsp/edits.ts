export interface Position {
  line: number;
  character: number;
}

export interface TextEdit {
  range: { start: Position; end: Position };
  newText: string;
}

/** Pure preflight for UTF-16 LSP edits. No disk writes or input mutation.
 * All positions refer to the same original snapshot. Unsupported extensions
 * must be rejected by the protocol adapter before entering this function.
 */
export function applyTextEdits(content: string, edits: readonly TextEdit[]): string {
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "\n" && content[i] !== "\r") continue;
    lines.push({ start, end: i });
    if (content[i] === "\r" && content[i + 1] === "\n") i++;
    start = i + 1;
  }
  lines.push({ start, end: content.length });

  function offset(position: Position): number {
    if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)
      || position.line < 0 || position.character < 0) {
      throw new Error("Invalid LSP position");
    }
    const line = lines[position.line];
    if (!line || position.character > line.end - line.start) throw new Error("LSP position outside snapshot");
    const value = line.start + position.character;
    const previous = content.charCodeAt(value - 1);
    const next = content.charCodeAt(value);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      throw new Error("LSP position splits a surrogate pair");
    }
    return value;
  }

  const ordered = edits.map((edit, index) => {
    const from = offset(edit.range.start);
    const to = offset(edit.range.end);
    if (from > to) throw new Error("Reversed LSP range");
    return { from, to, text: edit.newText, index };
  }).sort((a, b) => a.from - b.from || a.index - b.index);

  // Inserts at one position retain server order. An insertion may precede
  // a replacement at that position, but may not follow it or lie inside it.
  let cursor = 0;
  const chunks: string[] = [];
  for (const edit of ordered) {
    if (edit.from < cursor) throw new Error("Overlapping LSP edits");
    chunks.push(content.slice(cursor, edit.from), edit.text);
    cursor = edit.to;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}
