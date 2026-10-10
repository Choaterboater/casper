/** .casper/project.yaml after a task: Casper reads it again only as it read or wrote it itself. A task may rewrite the
 * file (the AI's edit is the project's to keep), but the session goes on with the checks and settings it started with
 * until Casper starts again; Casper's own writes for you (Remember, /verify add, more time) and /undo count as yours. */

import type { CasperApp } from "../app";
import type { ProjectContext } from "../project/context";
import { projectFileDigest } from "../project/context";
import { terminalText } from "../tui/format";
import { activeThemeName, findTheme, themeNote, useTheme } from "../tui/theme";

export const PROJECT_FILE_CHANGED = "[project] .casper/project.yaml changed in a task; restart Casper to use it\n";
const NONE = "none";

/** The project file's versions this session may read again: the one it started with and each Casper wrote from one. */
export function trustProjectFile(app: CasperApp, context: ProjectContext): void {
  app.trustedProjectFiles = new Set([context.projectFile ?? NONE]);
}

/** Read the project again. Its .casper/project.yaml is used only when it is a version Casper read or wrote itself;
 * otherwise the session keeps its context (with your own settings from the fresh read when `own` is set) and says so. */
export async function reloadProject(app: CasperApp, options: { own?: boolean } = {}): Promise<boolean> {
  const context = app.projectContext;
  if (!context) return false;
  const fresh = await app.loadProjectContextFn(context.info);
  if (app.trustedProjectFiles.has(fresh.projectFile ?? NONE)) {
    app.projectContext = fresh;
    followTheme(app, context.theme);
    return true;
  }
  // /settings writes only your own settings (never a project file's): those apply now.
  if (options.own) {
    app.projectContext = withOwnSettings(context, fresh);
    followTheme(app, context.theme);
  }
  app.events.ensureLineBreak();
  app.output.write(PROJECT_FILE_CHANGED);
  return false;
}

/** The theme the settings just read colours what comes next (lines already on screen keep theirs), so the screen
 * matches what /settings shows after a hand edit too. A new name Casper has no theme for is named once, as at start. */
export function followTheme(app: CasperApp, before: string | undefined): void {
  const theme = app.projectContext?.theme;
  // The theme on screen whose pack you removed (or that stopped being used) this session: the settings still name it,
  // so it stays until Casper starts again, as /pack remove said.
  if (theme !== undefined && theme === before && theme === activeThemeName() && !findTheme(theme)) return;
  useTheme(theme);
  const note = theme === before ? undefined : themeNote(theme);
  if (!note) return;
  app.events.ensureLineBreak();
  app.output.write(`[config] ${terminalText(note)}\n`);
}

/** Casper writing .casper/project.yaml for you: the new version is yours when the one it changed was. */
export async function writeProjectFile<T>(app: CasperApp, root: string, write: () => Promise<T>): Promise<T> {
  const ours = app.projectContext?.info.root === root && app.trustedProjectFiles.has(await projectFileDigest(root) ?? NONE);
  const result = await write();
  if (ours) app.trustedProjectFiles.add(await projectFileDigest(root) ?? NONE);
  return result;
}

function withOwnSettings(context: ProjectContext, fresh: ProjectContext): ProjectContext {
  const next: ProjectContext = { ...context, web: fresh.web, spend: fresh.spend };
  for (const key of ["updates", "display", "theme", "showPages", "delegate", "cache", "lab", "labProfile", "suggestions", "browser", "templates", "github", "diagrams", "pageChecks", "telemetry", "toolDownloads", "sshLogin", "otherLogins", "networkUpdates", "aiPages", "openPages"] as const) {
    if (fresh[key] === undefined) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = fresh[key];
  }
  // Your pages: off wins over the project's list; turned back on, the changed pages are checked until a restart.
  if (fresh.pageChecks === false) next.pages = "off";
  else if (context.pageChecks === false) delete next.pages;
  return next;
}
