import { BUILT_IN_THEMES, registerTheme, unregisterTheme, type Theme } from "../tui/theme";
import { loadInstalledPacks } from "./store";

/**
 * The themes packs bring, on the list /settings offers and `theme:` can name. Only a pack you added, still exactly as
 * you were shown it, with packs on, adds its theme; nothing about it reaches the model. A theme whose name is taken
 * (a built-in one, or another pack's) is not added: a pack's theme never replaces another.
 */

/** Theme name to the pack that brought it, for the themes on the list now. */
const fromPacks = new Map<string, string>();

/** The pack a theme on the list came from, if it came from one. */
export function packThemeOwner(name: string): string | undefined {
  return fromPacks.get(name);
}

/** The themes the packs you added bring (packs on, every file as you saw it), and a plain line for each that can't
 * be used. Reads only: casper doctor asks this, so a doctor run in a session leaves the session's list as it is. */
export async function packThemes(home: string, packsOn: boolean): Promise<{ themes: Array<{ theme: Theme; pack: string }>; notes: string[] }> {
  if (!packsOn) return { themes: [], notes: [] };
  let listing;
  try { listing = await loadInstalledPacks(home); } catch { return { themes: [], notes: [] }; }
  const taken = new Set(BUILT_IN_THEMES.map((theme) => theme.name));
  const themes: Array<{ theme: Theme; pack: string }> = [];
  const notes: string[] = [];
  for (const { record, theme, problem } of listing.packs) {
    if (!theme || problem) continue;
    if (taken.has(theme.name)) { notes.push(`Pack ${record.name}'s theme ${theme.name} is not used: there is already a theme with that name.`); continue; }
    taken.add(theme.name);
    themes.push({ theme, pack: record.name });
  }
  return { themes, notes };
}

/** Puts the themes of the packs you added on the list, in place of any put there before (a removed pack's theme
 * goes; one in use stays on screen until Casper starts again). With packs off, none is. Returns a plain line for
 * each theme that can't be added. */
export async function registerPackThemes(home: string, packsOn: boolean): Promise<string[]> {
  for (const name of fromPacks.keys()) unregisterTheme(name);
  fromPacks.clear();
  const { themes, notes } = await packThemes(home, packsOn);
  for (const { theme, pack } of themes) {
    try {
      registerTheme(theme);
      fromPacks.set(theme.name, pack);
    } catch {
      notes.push(`Pack ${pack}'s theme ${theme.name} is not used: there is already a theme with that name.`);
    }
  }
  return notes;
}
