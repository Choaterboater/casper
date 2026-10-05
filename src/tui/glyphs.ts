/** The spinner frames and panel corners this terminal can draw. The old Windows console (conhost, not Windows
 * Terminal or an editor's terminal) has no braille or rounded corners in its fonts, so it gets ASCII and square ones. */
export interface GlyphSet {
  spinner: readonly string[];
  /** Top-left, top-right, bottom-left, bottom-right. */
  corners: readonly [string, string, string, string];
}

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function glyphSet(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): GlyphSet {
  const legacy = platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM && !env.ConEmuANSI;
  return legacy
    ? { spinner: ["|", "/", "-", "\\"], corners: ["┌", "┐", "└", "┘"] }
    : { spinner: BRAILLE, corners: ["╭", "╮", "╰", "╯"] };
}

/** This process's terminal. */
export const GLYPHS = glyphSet();
