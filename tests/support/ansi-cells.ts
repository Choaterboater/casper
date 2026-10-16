/** Small headless row renderer for TUI snapshots. Feed rendered rows, not a stripped transcript.
 * Unsupported screen controls fail loudly rather than silently producing misleading colour evidence. */
export interface Cell {
  char: string;
  foreground: string;
  background: string;
  dim: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}
const neutral = (): Omit<Cell, "char"> => ({ foreground: "default", background: "default", dim: false, bold: false, italic: false, underline: false, inverse: false });

/** A terminal cannot retain half of a wide glyph outside an overwritten/erased span. */
function clearWideEdges(cells: Cell[], start: number, end: number, style: Omit<Cell, "char">): void {
  let left = start;
  while (left > 0 && cells[left]?.char === "") left--;
  for (; left < start; left++) cells[left] = { char: " ", ...style };
  for (let right = end; cells[right]?.char === ""; right++) cells[right] = { char: " ", ...style };
}

function sgr(style: Omit<Cell, "char">, parameters: string): Omit<Cell, "char"> {
  const codes = parameters.split(";").map(Number);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) style = neutral();
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 39) style.foreground = "default";
    else if (code === 49) style.background = "default";
    else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) style.foreground = String(code);
    else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) style.background = String(code);
    else if (code === 38 || code === 48) {
      const mode = codes[++i];
      let color: string;
      if (mode === 5 && codes[i + 1] !== undefined) color = `index:${codes[++i]}`;
      else if (mode === 2 && codes[i + 3] !== undefined) { color = `rgb:${codes.slice(i + 1, i + 4).join(",")}`; i += 3; }
      else throw new Error(`Unsupported SGR colour: ${parameters}`);
      if (code === 38) style.foreground = color; else style.background = color;
    } else throw new Error(`Unsupported SGR: ${code}`);
  }
  return style;
}

/** SGR state survives line breaks and nested resets, as in a terminal. Wide graphemes occupy two cells. */
export function ansiCells(rows: readonly string[]): Cell[][] {
  let style = neutral();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return rows.map(row => {
    const cells: Cell[] = [];
    let x = 0;
    for (let i = 0; i < row.length;) {
      if (row[i] === "\x1b") {
        const escape = /^(?:\x1b\[([\d;]*)m|\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[([012]?)K)/.exec(row.slice(i));
        if (!escape) throw new Error(`Unsupported row escape: ${JSON.stringify(row.slice(i, i + 32))}`);
        if (escape[1] !== undefined) style = sgr(style, escape[1]);
        else if (escape[3] !== undefined) {
          const mode = Number(escape[3]);
          const start = mode === 0 ? x : 0;
          const end = mode === 1 ? x + 1 : cells.length;
          clearWideEdges(cells, start, end, style);
          for (let col = start; col < end; col++) cells[col] = { char: " ", ...style };
        }
        i += escape[0].length;
      } else if (row[i] === "\r") { x = 0; i++; }
      else if (row[i] === "\b") { x = Math.max(0, x - 1); i++; }
      else {
        const end = row.indexOf("\x1b", i);
        const text = row.slice(i, end === -1 ? row.length : end);
        const control = text.search(/[\r\b]/);
        const printable = control === -1 ? text : text.slice(0, control);
        if (/[\x00-\x1f\x7f]/.test(printable)) throw new Error("Non-printing control in snapshot row");
        for (const { segment } of segmenter.segment(printable)) {
          const width = Bun.stringWidth(segment);
          if (width === 0) {
            let base = x - 1;
            while (base >= 0 && cells[base]?.char === "") base--;
            if (base >= 0) cells[base]!.char += segment;
            continue;
          }
          clearWideEdges(cells, x, x + width, style);
          cells[x++] = { char: segment, ...style };
          for (let extra = 1; extra < width; extra++) cells[x++] = { char: "", ...style };
        }
        i += printable.length;
      }
    }
    return cells;
  });
}

/** Every cell belonging to an exact text span, excluding padding outside it. Missing text is an error. */
export function cellsFor(rows: readonly Cell[][], text: string): Cell[] {
  for (const row of rows) {
    const plain = row.map(cell => cell.char).join("");
    const start = plain.indexOf(text);
    if (start < 0) continue;
    let offset = 0, included = false;
    return row.filter(cell => {
      if (!cell.char) return included; // A wide grapheme's continuation belongs to the same span.
      const end = offset + cell.char.length;
      included = offset < start + text.length && end > start;
      offset = end;
      return included;
    });
  }
  throw new Error(`Missing snapshot text: ${JSON.stringify(text)}`);
}

/** One line per terminal row, runs with equal attributes share a tag. Stable, compact and reviewable. */
export function cellSnapshot(rows: readonly Cell[][]): string {
  return rows.map(row => {
    const runs: { tag: string; text: string }[] = [];
    for (const { char, foreground, background, ...flags } of row) {
      const tag = [foreground !== "default" ? `fg=${foreground}` : "", background !== "default" ? `bg=${background}` : "", ...Object.entries(flags).filter(([, on]) => on).map(([name]) => name)].filter(Boolean).join(" ") || "plain";
      if (runs.at(-1)?.tag === tag) runs.at(-1)!.text += char;
      else runs.push({ tag, text: char });
    }
    return runs.map(run => `[${run.tag}]${JSON.stringify(run.text)}`).join(" ");
  }).join("\n");
}
