import { readFile } from "node:fs/promises";
import path from "node:path";
import { isOutside } from "../platform/inside";
import { listPages, PAGE_POLICY, PAGE_SANDBOX, pageFile, pageNameProblem } from "./store";

/**
 * The local page server: 127.0.0.1 only, a free port picked by the system, one per session, stopped when Casper
 * quits. It serves the files in one project's pages folder and nothing else, each with a strict policy header, and
 * tells an open page to reload itself when Casper writes it again (server-sent events on /_events).
 */

/** Sent with every answer: no sniffing, no referrer, no caching, never framed. */
const COMMON_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};

/** The few lines added to every page served: reload when Casper changes it, say so when it was removed. */
function reloadScript(name: string): string {
  return `<script>(()=>{const e=new EventSource("/_events?page=${name}");e.onmessage=m=>{if(m.data==="reload")location.reload();if(m.data==="gone"){e.close();document.title="(removed) "+document.title;}};})();</script>`;
}

/** The page with the reload script before its last </body>, or at the end. */
export function withReload(html: string, name: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at < 0 ? `${html}\n${reloadScript(name)}` : `${html.slice(0, at)}${reloadScript(name)}${html.slice(at)}`;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

interface Listener { page: string; send(data: string): void }

export class PageServer {
  private server?: ReturnType<typeof Bun.serve>;
  private readonly listeners = new Set<Listener>();
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private readonly directory: string) {}

  /** http://127.0.0.1:<port>, starting the server on first use. */
  start(): string {
    if (!this.server) {
      this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (request) => this.answer(request) });
      // A comment line now and then keeps a quiet event stream open and finds the ones a closed tab left.
      this.heartbeat = setInterval(() => { for (const listener of this.listeners) listener.send(": ping\n\n"); }, 15_000);
      this.heartbeat.unref?.();
    }
    return `http://127.0.0.1:${this.server.port}`;
  }

  get running(): boolean { return this.server !== undefined; }

  /** The address of one page (starts the server). */
  url(name: string): string { return `${this.start()}/${name}.html`; }

  /** Tells every open copy of the page that it changed ("reload") or was removed ("gone"). */
  notify(name: string, event: "reload" | "gone"): void {
    for (const listener of this.listeners) if (listener.page === name) listener.send(`data: ${event}\n\n`);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.listeners.clear();
    const server = this.server;
    this.server = undefined;
    await server?.stop(true);
  }

  private async answer(request: Request): Promise<Response> {
    const port = this.server?.port;
    // Only this computer's own name for the server: a web page elsewhere that points a name of its own at
    // 127.0.0.1 (DNS rebinding) is refused.
    const host = request.headers.get("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return this.plain(403, "Forbidden");
    if (request.method !== "GET" && request.method !== "HEAD") return this.plain(405, "Method not allowed", { allow: "GET, HEAD" });
    const url = new URL(request.url);
    if (url.pathname === "/") return this.index();
    if (url.pathname === "/_events") return this.events(url.searchParams.get("page") ?? "", request.signal);
    const match = /^\/([^/]+)\.html$/.exec(url.pathname);
    if (!match || pageNameProblem(match[1])) return this.plain(404, "Not found");
    const name = match[1]!;
    const page = await pageFile(this.directory, name);
    // The name rule already keeps a request in the folder; this is the second lock.
    if (!page || isOutside(path.relative(this.directory, page.file))) return this.plain(404, "Not found");
    const html = await readFile(page.file, "utf8").catch(() => undefined);
    if (html === undefined) return this.plain(404, "Not found");
    return this.html(withReload(html, name));
  }

  private async index(): Promise<Response> {
    const pages = await listPages(this.directory);
    const items = pages.map((page) => `<li><a href="/${page.name}.html">${escapeHtml(page.name)}</a> <small>${escapeHtml(page.modified.toLocaleString())}</small></li>`).join("");
    return this.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Casper pages</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:40rem;padding:0 16px}</style></head>
<body><h1>Pages</h1>${items ? `<ul>${items}</ul>` : "<p>No pages yet. Ask Casper for one.</p>"}</body></html>`);
  }

  private events(name: string, signal: AbortSignal): Response {
    if (pageNameProblem(name)) return this.plain(404, "Not found");
    const encoder = new TextEncoder();
    let listener: Listener | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        listener = { page: name, send: (data) => { try { controller.enqueue(encoder.encode(data)); } catch { this.listeners.delete(listener!); } } };
        this.listeners.add(listener);
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        signal.addEventListener("abort", () => { this.listeners.delete(listener!); try { controller.close(); } catch { /* already closed */ } }, { once: true });
      },
      cancel: () => { if (listener) this.listeners.delete(listener); },
    });
    // A sandboxed page's origin is "null"; the stream says only "reload" or "gone".
    return new Response(stream, { headers: { ...COMMON_HEADERS, "content-type": "text/event-stream; charset=utf-8", "access-control-allow-origin": "null" } });
  }

  private html(body: string): Response {
    return new Response(body, { headers: { ...COMMON_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": `${PAGE_POLICY}; ${PAGE_SANDBOX}` } });
  }

  private plain(status: number, text: string, extra: Record<string, string> = {}): Response {
    return new Response(text, { status, headers: { ...COMMON_HEADERS, ...extra, "content-type": "text/plain; charset=utf-8" } });
  }
}
