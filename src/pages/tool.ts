import type { RuntimeTool } from "../runtime/types";
import guide from "./GUIDE.md" with { type: "text" };
import type { PageSession } from "./session";
import { findSaved, pageDay, pageName, pageNameProblem, type SavedPage } from "./store";

/** The how-to for pages, sent to the AI only when it uses the tool: never part of the fixed prompt. */
export const PAGE_GUIDE = guide.trim();

/** At most this many saved pages in one answer to open. */
const LISTED = 20;

/** casper_page: the AI shows the person a page in their browser, or opens one saved before, from any folder ("show me
 * the radar page from yesterday"). Its text is one short line in every request; the guide comes back from the tool
 * itself (asked for without html, or with the first page of the session). */
export function pageTool(session: () => PageSession, now: () => Date = () => new Date()): RuntimeTool {
  let guideSent = false;
  return {
    name: "casper_page",
    description: "Unasked, when seeing beats reading (options, mock-up, dashboard, report), show an HTML page; not for plain answers. No html: guide. open: reopen by words",
    inputSchema: { type: "object", properties: { name: { type: "string" }, html: { type: "string" }, open: { type: "string" } } },
    async execute(args) {
      const extra = Object.keys(args).filter((key) => key !== "name" && key !== "html" && key !== "open");
      if (extra.length) return { text: `Unknown field ${extra[0]}: send name and html, or open.`, isError: true };
      if (args.open !== undefined) {
        if (typeof args.open !== "string" || args.name !== undefined || args.html !== undefined) return { text: "open is the saved page's name or a few words, sent alone.", isError: true };
        return { text: await reopen(session(), args.open, now()) };
      }
      if (args.html === undefined) {
        guideSent = true;
        return { text: `${PAGE_GUIDE}\n\nThen call casper_page with name and html.` };
      }
      // A near-miss name ("Ghost_Options") is fixed, never refused: a refusal would throw the whole page away.
      const name = pageName(args.name);
      const problem = pageNameProblem(name) ?? (typeof args.html !== "string" || !args.html.trim() ? "html must be the whole page as text" : undefined);
      if (problem) return { text: problem, isError: true };
      try {
        const page = await session().make(name as string, args.html as string);
        const shown = page.opened ? "It is open in the user's browser."
          : page.notOpened ? `The user has the link (not opened: ${page.notOpened}).` : "The open tab reloads itself.";
        const lines = [`Page ${page.name} ${page.updated ? "updated" : "made"}: ${page.link}. ${shown} Casper already printed the link; don't paste the page into chat.`];
        if (!guideSent) { guideSent = true; lines.push(`Guide for later pages:\n${PAGE_GUIDE}`); }
        return { text: lines.join("\n\n") };
      } catch (error) {
        return { text: `Page not saved: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };
}

/** casper_page open: one match opens; several, none or "" list them with the ref to send back. */
async function reopen(pages: PageSession, words: string, now: Date): Promise<string> {
  const saved = await pages.saved();
  const found = findSaved(saved, words);
  const line = (page: SavedPage) => `- ${page.ref} · ${page.here ? "this folder" : page.folder} · ${pageDay(page.modified, now)}`;
  const list = (shown: readonly SavedPage[]) => [...shown.slice(0, LISTED).map(line), ...shown.length > LISTED ? [`… and ${shown.length - LISTED} more`] : []].join("\n");
  if (!saved.length) return "No saved pages yet.";
  if (!words.trim()) return `Saved pages, this folder first, then newest:\n${list(saved)}`;
  if (!found.length) return `No saved page matches ${JSON.stringify(words)}. Saved pages:\n${list(saved)}`;
  if (found.length > 1) return `${found.length} saved pages match ${JSON.stringify(words)}; send open again with one ref:\n${list(found)}`;
  const opened = await pages.open(found[0]!.ref, { asked: false });
  if (typeof opened === "string") return opened;
  const where = `Page ${opened.page.name} (folder ${opened.page.here ? "this one" : opened.page.folder}, made ${pageDay(opened.page.modified, now)})`;
  return opened.opened ? `${where} is open in the user's browser: ${opened.link}. Casper printed the link.`
    : `${where} not opened (${opened.notOpened}); the user has the link: ${opened.link}.`;
}
