import path from "node:path";
import { pathToFileURL } from "node:url";
import { desktopHere, openInBrowser } from "./open";
import { PageServer } from "./server";
import { isProjectKey, type PageFile, pageNameProblem, removePage, type SavedPage, savedPages, writePage } from "./store";

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

export interface OpenedPage {
  page: SavedPage;
  link: string;
  opened: boolean;
  /** Why it did not open. */
  notOpened?: string;
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
  /** One server per page folder shown this session: this project's, and any other folder a page was opened from. */
  private readonly servers = new Map<string, PageServer>();
  /** Pages already shown in this session: a change only reloads their tab. */
  private readonly shown = new Set<string>();

  constructor(private readonly options: PageSessionOptions) {}

  get directory(): string { return this.options.directory; }

  private get server(): PageServer | undefined { return this.servers.get(this.options.directory); }

  /** The address the person opens: the page server's for its folder in a live session, else the file itself. */
  private link(page: Pick<PageFile, "name" | "file">, directory = this.options.directory): string {
    if (!this.options.live) return pathToFileURL(page.file).href;
    let server = this.servers.get(directory);
    if (!server) this.servers.set(directory, server = new PageServer(directory));
    return server.url(page.name);
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

  /** Every folder's saved pages, this one's first (store.ts savedPages). */
  saved(): Promise<SavedPage[]> { return savedPages(this.options.homeDir, this.options.directory); }

  /** The saved page a ref names: `<project>/<name>`, or a name, this folder's first, else the newest elsewhere. */
  async find(ref: string): Promise<SavedPage | string> {
    const [project, name, ...rest] = ref.split("/");
    if (name !== undefined && (rest.length || !isProjectKey(project!) || pageNameProblem(name))) return pageNameProblem(ref) ?? `No page ${ref}. /pages lists them.`;
    const problem = name === undefined ? pageNameProblem(ref) : undefined;
    if (problem) return problem;
    const page = (await this.saved()).find((saved) => name === undefined ? saved.name === ref : saved.project === project && saved.name === name);
    return page ?? `No page ${ref}. /pages lists them.`;
  }

  /** Opens a saved page from any folder. `asked`: you typed it (/pages open), so it opens whatever Open pages in the
   * browser says; the AI's open keeps to the setting. One transcript line says where it is. */
  async open(ref: string, options: { asked?: boolean } = { asked: true }): Promise<OpenedPage | string> {
    const page = await this.find(ref);
    if (typeof page === "string") return page;
    const directory = page.here ? this.options.directory : path.dirname(page.file);
    const link = this.link(page, directory);
    const notOpened = !options.asked && !this.options.openSetting() ? "opening pages is off" : this.openBlock();
    const opened = !notOpened && (this.options.open ?? openInBrowser)(link);
    if (opened && page.here) this.shown.add(page.name);
    this.options.say(`[page] ${page.name}${page.here ? "" : ` (${page.folder})`} → ${link}${opened ? "" : " (open it in your browser)"}`);
    return { page, link, opened, ...(opened ? {} : { notOpened: notOpened ?? "the browser did not start" }) };
  }

  /** /pages remove: deletes the file; an open tab says it was removed. A bare name is this folder's page only: another
   * folder's needs its `<project>/<name>`, so a page of the same name elsewhere is never removed by mistake. */
  async remove(ref: string): Promise<boolean> {
    const page = await this.find(ref);
    if (typeof page === "string" || (!page.here && !ref.includes("/"))) return false;
    const directory = path.dirname(page.file);
    const removed = await removePage(directory, page.name);
    if (removed) { this.servers.get(page.here ? this.options.directory : directory)?.notify(page.name, "gone"); if (page.here) this.shown.delete(page.name); }
    return removed;
  }

  async close(): Promise<void> {
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(servers.map((server) => server.stop()));
  }
}
