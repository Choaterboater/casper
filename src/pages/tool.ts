import type { RuntimeTool } from "../runtime/types";
import guide from "./GUIDE.md" with { type: "text" };
import type { PageSession } from "./session";
import { pageName, pageNameProblem } from "./store";

/** The how-to for pages, sent to the AI only when it uses the tool: never part of the fixed prompt. */
export const PAGE_GUIDE = guide.trim();

/** casper_page: the AI shows the person a page in their browser. Its text is one short line in every request; the
 * guide comes back from the tool itself (asked for without html, or with the first page of the session). */
export function pageTool(session: () => PageSession): RuntimeTool {
  let guideSent = false;
  return {
    name: "casper_page",
    description: "Unasked, when seeing beats reading (options compared, mock-up, dashboard, shared report), show the user an HTML page; not for plain answers. Same name updates it. No html: guide.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, html: { type: "string" } } },
    async execute(args) {
      const extra = Object.keys(args).filter((key) => key !== "name" && key !== "html");
      if (extra.length) return { text: `Unknown field ${extra[0]}: send name and html only.`, isError: true };
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
