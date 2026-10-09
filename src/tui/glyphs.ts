/** The marks this terminal can draw. The old Windows console (conhost, not Windows Terminal or an editor's terminal)
 * has no braille, rounded corners or most symbols in its fonts, so it gets ASCII and square corners instead. */
export interface GlyphSet {
  spinner: readonly string[];
  /** Top-left, top-right, bottom-left, bottom-right. */
  corners: readonly [string, string, string, string];
  /** Every other mark Casper writes (❯ ✓ ✗ → ↳ ▌ ◐ ○ • – … ⚠ ↻), as this terminal draws it. */
  text(text: string): string;
}

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One column each, like the mark it stands for, so a line keeps its width and nothing shifts. The box-drawing
 * corner is one the old console draws, as for the panel corners. */
const ASCII: Readonly<Record<string, string>> = {
  "❯": ">", "✓": "+", "✗": "x", "→": ">", "↳": "└", "▌": "|", "◐": "*", "○": "o", "•": "*", "–": "-", "…": "~", "⚠": "!", "↻": "@",
};
const ASCII_MARKS = new RegExp(`[${Object.keys(ASCII).join("")}]`, "gu");

/** The old console: Windows with none of the variables Windows Terminal, an editor's terminal or ConEmu set. */
export function legacyConsole(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  return platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM && !env.ConEmuANSI;
}

export function glyphSet(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): GlyphSet {
  return legacyConsole(platform, env)
    ? { spinner: ["|", "/", "-", "\\"], corners: ["┌", "┐", "└", "┘"], text: text => text.replace(ASCII_MARKS, mark => ASCII[mark]!) }
    : { spinner: BRAILLE, corners: ["╭", "╮", "╰", "╯"], text: text => text };
}

/** This process's terminal. */
export const GLYPHS = glyphSet();

/** A terminal's output with every mark drawn as `glyphs` can: on the old console, ASCII. Anything else (a pipe, a
 * file, another terminal) gets the output unchanged. */
export function glyphOutput<T extends { write(text: string): unknown; isTTY?: boolean }>(output: T, glyphs: GlyphSet = GLYPHS): T {
  if (!output.isTTY || glyphs.text("✓") === "✓") return output;
  return new Proxy(output, {
    get(target, property) {
      if (property === "write") return (text: unknown, ...rest: unknown[]) =>
        (target.write as (...args: unknown[]) => unknown).call(target, typeof text === "string" ? glyphs.text(text) : text, ...rest);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
