/** Pages the AI makes (casper_page) and /pages: the session's page folder, server and browser opening. */

import type { CasperApp } from "../app";
import { PageSession } from "../pages/session";
import { pagesDirectory } from "../pages/store";
import { pageTool } from "../pages/tool";
import type { RuntimeTool } from "../runtime/types";
import { terminalText } from "../tui/format";
import { MermaidProvider } from "../visualize/mermaid";
import { diagramPageFor, diagramPageName } from "../visualize/page";
import type { RenderedVisualization } from "../visualize/router";

/** The session's pages for the project it opened, made on first use; its server stops when Casper quits. */
export function pageSession(app: CasperApp): PageSession {
  const directory = pagesDirectory(app.homeDir(), app.projectContext!.stateDirectory);
  if (app.pages?.directory === directory) return app.pages;
  const previous = app.pages;
  void previous?.close().catch(() => {});
  const session = app.pages = new PageSession({
    homeDir: app.homeDir(), directory, live: app.interactive,
    openSetting: () => app.projectContext?.openPages !== false,
    ...app.pageSeams,
    say: (line) => { if (!app.closing) { app.events.ensureLineBreak(); app.output.write(`${terminalText(line)}\n`); } },
  });
  app.lifecycle.add({ name: "pages", close: () => session.close() });
  return session;
}

/** casper_page for this task, or undefined when Pages the AI makes is off. One tool for the session, so its guide is
 * sent once. */
export function pageToolFor(app: CasperApp): RuntimeTool | undefined {
  if (app.projectContext?.aiPages === false) return undefined;
  app.pageTool ??= pageTool(() => pageSession(app));
  return app.pageTool;
}

/** A diagram the diagram tool or /visualize repo drew, as a page Casper makes from it (no model), opened like the AI's
 * pages (open_pages). Only in a session someone is watching, and not with visualize.outputDir: false (in-conversation
 * only). What to tell the model, or undefined when no page was made. */
export async function showDiagramPage(app: CasperApp, rendered: RenderedVisualization): Promise<string | undefined> {
  if (!app.interactive || !app.projectContext || !app.visualization?.settings.outputDir) return undefined;
  const mermaid = rendered.primary.provider === "mermaid" ? rendered.primary.content : (await new MermaidProvider().render(rendered.graph)).content;
  const page = await pageSession(app).make(diagramPageName(rendered.graph.title), diagramPageFor(rendered.graph, mermaid, rendered.artifacts.map((artifact) => artifact.path)));
  if (page.opened) return `Shown in the user's browser as page ${page.name} (${page.link}); don't make a page for it.`;
  return page.notOpened ? `Saved as page ${page.name} (${page.link}), not opened: ${page.notOpened}.`
    : `Page ${page.name} updated (${page.link}); don't make a page for it.`;
}

const USAGE = "Usage: /pages | /pages open <name> | /pages remove <name>";

/** /pages: this project's pages with their links; /pages open <name>; /pages remove <name>. No model; runs during a
 * task too. */
export async function pagesCommand(app: CasperApp, args: string): Promise<void> {
  const write = (text: string) => app.output.write(text);
  const [action, name, ...extra] = args.split(/\s+/).filter(Boolean);
  const session = pageSession(app);
  if (!action || action === "list") {
    if (name) { write(`${USAGE}\n`); return; }
    const pages = await session.list();
    if (!pages.length) {
      const off = app.projectContext?.aiPages === false ? " Pages the AI makes is off (/settings)." : " Ask for one: \"show me the options side by side\".";
      write(`[pages] No pages for this project yet.${off}\n`);
      return;
    }
    write(`Pages (${terminalText(session.directory)}):\n${pages.map((page) => `  ${page.name.padEnd(24)} ${page.link}`).join("\n")}\n/pages open <name> shows one · /pages remove <name> deletes it\n`);
    return;
  }
  if ((action !== "open" && action !== "remove") || !name || extra.length) { write(`${USAGE}\n`); return; }
  if (action === "remove") {
    write(await session.remove(name) ? `[pages] Removed ${name}.\n` : `[pages] No page ${terminalText(name)}. /pages lists them.\n`);
    return;
  }
  const opened = await session.open(name);
  if (typeof opened === "string") { write(`[pages] ${terminalText(opened)}\n`); return; }
  write(`[page] ${name} → ${opened.link}${opened.opened ? "" : " (open it in your browser)"}\n`);
}
