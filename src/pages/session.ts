import { pathToFileURL } from "node:url";
import { desktopHere, openInBrowser } from "./open";
import { PageServer } from "./server";
import { listPages, pageFile, type PageFile, pageNameProblem, removePage, writePage } from "./store";

export interface PageSessionOptions {
  homeDir: string;
  /** ~/.casper/pages/<project-key>/. */
  directory: string;
  /** A session someone is watching: the page server runs and pages can open. A one-shot run only saves the file. */
  live: boolean;
  /** "Open pages in the browser" (open_pages); read at each page, so a change applies at once. */
  openSetting: () => boolean;
  /** Tests: whether this computer has a desktop, and the browser opener. */
  desktop?: () => boolean;
  open?: (url: string) => boolean;
  /** One line for the transcript. */
  say: (line: string) => void;
}

export interface MadePage {
  name: string;
  /** The address to open, or the file's own address in a one-shot run. */
  link: string;
  updated: boolean;
  /** Opened in the browser now. */
  opened: boolean;
  /** Why it did not open, when it didn't and it is the first time this session. */
  notOpened?: string;
}

/** The pages of one project for one Casper session: writes them, serves them, opens each one the first time it is
 * made or opened in the session, and makes an open tab reload itself after a change. */
export class PageSession {
  private server?: PageServer;
  /** Pages already shown in this session: a change only reloads their tab. */
  private readonly shown = new Set<string>();

  constructor(private readonly options: PageSessionOptions) {}

  get directory(): string { return this.options.directory; }

  /** The address the person opens: the page server's in a live session, else the file itself. */
  private link(page: Pick<PageFile, "name" | "file">): string {
    if (!this.options.live) return pathToFileURL(page.file).href;
    this.server ??= new PageServer(this.options.directory);
    return this.server.url(page.name);
  }

  /** Why a page would not open now, or undefined when it opens. */
  private openBlock(): string | undefined {
    if (!this.options.live) return "a one-shot run";
    if (!(this.options.desktop ?? desktopHere)()) return "no desktop here";
    return undefined;
  }

  async make(name: string, html: string): Promise<MadePage> {
    const { file, created } = await writePage(this.options.homeDir, this.options.directory, name, html);
    const link = this.link({ name, file });
    this.server?.notify(name, "reload");
    let opened = false;
    let notOpened: string | undefined;
    if (!this.shown.has(name)) {
      this.shown.add(name);
      notOpened = !this.options.openSetting() ? "opening pages is off" : this.openBlock();
      if (!notOpened) opened = (this.options.open ?? openInBrowser)(link);
      if (!notOpened && !opened) notOpened = "the browser did not start";
    }
    this.options.say(`[page] ${name}${created ? "" : " updated"} → ${link}`);
    return { name, link, updated: !created, opened, ...(notOpened ? { notOpened } : {}) };
  }

  /** The pages with their addresses. A live session starts the server for them. */
  async list(): Promise<Array<PageFile & { link: string }>> {
    const pages = await listPages(this.options.directory);
    return pages.map((page) => ({ ...page, link: this.link(page) }));
  }

  /** /pages open: opens it whatever the setting (you asked); prints the link when nothing can open here. */
  async open(name: string): Promise<{ link: string; opened: boolean } | string> {
    const problem = pageNameProblem(name);
    if (problem) return problem;
    const page = await pageFile(this.options.directory, name);
    if (!page) return `No page ${name}. /pages lists them.`;
    const link = this.link(page);
    const opened = !this.openBlock() && (this.options.open ?? openInBrowser)(link);
    if (opened) this.shown.add(name);
    return { link, opened };
  }

  /** /pages remove: deletes the file; an open tab says it was removed. */
  async remove(name: string): Promise<boolean> {
    if (pageNameProblem(name)) return false;
    const removed = await removePage(this.options.directory, name);
    if (removed) { this.server?.notify(name, "gone"); this.shown.delete(name); }
    return removed;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.stop();
  }
}
