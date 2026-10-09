import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isOutside } from "../platform/inside";

/**
 * The pages the AI makes: one HTML file each in ~/.casper/pages/<project-key>/, where <project-key> is the name
 * of the project's own state folder (~/.casper/projects/<key>), so two projects with the same folder name never
 * share pages. Only Casper writes here (the folder is under ~/.casper, which the AI's tools can't change).
 */

/** Short, lower case, digits and dashes; no dots, slashes or spaces, so a name is never a path. */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** Names Windows can't use for a file, whatever the extension. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
/** A page is one file; a bigger one is almost always pasted data the AI should summarise. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** The name the AI meant: lower case, any run of other characters as one "-", no dash at either end, at most 40
 * characters ("Ghost_Options" is ghost-options), so a near-miss name never throws away a whole page. */
export function pageName(name: unknown): unknown {
  if (typeof name !== "string") return name;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
}

/** What is wrong with a page name, or undefined for a good one. */
export function pageNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || !name) return "name is required: a short name such as db-options (a-z, 0-9 and -)";
  if (!NAME.test(name)) return `name ${JSON.stringify(name.slice(0, 60))} must be 1-40 of a-z, 0-9 and -, starting and ending with a letter or digit`;
  if (WINDOWS_RESERVED.test(name)) return `name ${name} is reserved on Windows; pick another`;
  return undefined;
}

/** ~/.casper/pages/<project-key>/ for the project whose state folder is `stateDirectory`. */
export function pagesDirectory(homeDir: string, stateDirectory: string): string {
  return path.join(homeDir, ".casper", "pages", path.basename(stateDirectory));
}

/** The policy every page carries: written into the file and sent as a header. Inline script and style for the page
 * itself; libraries and fonts only from the well-known CDNs; images and data inline; connections only back to the
 * Casper page server (live reload). No forms, frames or base URL. */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Served pages also get an origin of their own (no cookies or storage shared with other apps on 127.0.0.1); a
 * header only, as browsers ignore sandbox in a meta tag. */
export const PAGE_SANDBOX = "sandbox allow-scripts allow-popups allow-modals allow-downloads";

/** In the file: the same policy less frame-ancestors, which browsers ignore (with a console warning) in a meta tag. */
const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY.replace(/; frame-ancestors [^;]*/, "")}">`;

/** No policy covers WebRTC, which could send UDP or TCP to any host and port; this takes it away before the page's
 * own script runs. Best effort only: a same-origin frame can bring it back, so docs never call it blocked. */
export const RTC_GUARD = `<script>for(const k of["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate"])try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}</script>`;

/** The page as saved: the policy as the first tag after any doctype, so a page opened straight from the file is held
 * to it too. A doctype stays first (anything before it would put the browser in quirks mode). */
export function withPolicy(saved: string): string {
  // A page the AI read back and sent again keeps one copy of the tag.
  const html = saved.split(POLICY_META).join("").split(RTC_GUARD).join("");
  const head = `${POLICY_META}${RTC_GUARD}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  // The line breaks Casper added last time go, so saving a page again changes nothing.
  const rest = (doctype ? html.slice(doctype[0].length) : html).replace(/^(?:\r?\n)+/, "");
  return doctype ? `${doctype[0]}\n${head}\n${rest}` : `${head}\n${rest}`;
}

/** The folder, made (owner only) when missing; refused when it, or ~/.casper/pages, is a link that leads elsewhere. */
async function ensureFolder(homeDir: string, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const base = await realpath(path.join(homeDir, ".casper"));
  const real = await realpath(directory);
  const relative = path.relative(path.join(base, "pages"), real);
  if (!relative || isOutside(relative) || relative.includes(path.sep)) throw new Error("The pages folder is not where Casper keeps pages; nothing was written");
}

export interface PageFile { name: string; file: string; modified: Date; bytes: number }

/** The page's file, or undefined when there is none (or it is not a plain file, such as a link). */
export async function pageFile(directory: string, name: string): Promise<PageFile | undefined> {
  if (pageNameProblem(name)) return undefined;
  const file = path.join(directory, `${name}.html`);
  if (isOutside(path.relative(directory, file))) return undefined;
  const stats = await lstat(file).catch(() => undefined);
  return stats?.isFile() ? { name, file, modified: stats.mtime, bytes: stats.size } : undefined;
}

/** Writes (or replaces) one page. The new text goes to a temporary file first and is renamed over the old one, so a
 * reader never sees half a page and a link at the page's name is replaced, never followed. */
export async function writePage(homeDir: string, directory: string, name: string, html: string): Promise<{ file: string; created: boolean }> {
  const problem = pageNameProblem(name);
  if (problem) throw new Error(problem);
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw new Error(`the page is over ${MAX_PAGE_BYTES / 1024 / 1024} MB; keep it to what the user needs to see`);
  await ensureFolder(homeDir, directory);
  const file = path.join(directory, `${name}.html`);
  const created = !(await lstat(file).catch(() => undefined));
  const temporary = path.join(directory, `.${name}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(withPolicy(html), "utf8"); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return { file, created };
}

/** This project's pages, newest first. */
export async function listPages(directory: string): Promise<PageFile[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const pages = await Promise.all(names.filter((entry) => entry.endsWith(".html")).map((entry) => pageFile(directory, entry.slice(0, -5))));
  return pages.filter((page): page is PageFile => page !== undefined).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** The page's saved text, or undefined. */
export async function readPage(directory: string, name: string): Promise<string | undefined> {
  const page = await pageFile(directory, name);
  return page ? readFile(page.file, "utf8").catch(() => undefined) : undefined;
}

/** Deletes one page; false when there was none. */
export async function removePage(directory: string, name: string): Promise<boolean> {
  const page = await pageFile(directory, name);
  if (!page) return false;
  await rm(page.file, { force: true });
  return true;
}
