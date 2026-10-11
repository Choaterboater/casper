import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { portInUse } from "../platform/managed-process";
import { isOutside } from "../platform/inside";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".webmanifest": "application/manifest+json",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wasm": "application/wasm", ".pdf": "application/pdf",
};

/** The project folder as plain files on a loopback port, served inside Casper: no command runs, nothing outlives
 * the browser session, and a path (or a link) that leads out of the project is not found. */
export class StaticServer {
  private server?: ReturnType<typeof Bun.serve>;
  private served = 0;
  private missing: string[] = [];

  diagnostics() {
    return { output: `Static files: ${this.served} served${this.missing.length ? `; not found: ${this.missing.slice(-5).join(", ")}` : ""}`, truncated: false, running: Boolean(this.server) };
  }

  async start(projectRoot: string, source: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.server) throw new Error("Only one development server is allowed per browser session");
    const url = new URL(source);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port) < 1024) throw new Error("Static files need a loopback HTTP URL with an explicit unprivileged port");
    const held = await portInUse(url.hostname, Number(url.port)).catch(() => { throw new Error("Cannot establish that browser server port is unused"); });
    if (held) throw new Error("Browser server port is already in use; existing processes are never replaced");
    signal.throwIfAborted();
    const root = await realpath(projectRoot);
    this.server = Bun.serve({ hostname: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port), fetch: (request) => this.answer(root, request) });
    return { ready: true, url: url.href, guidance: "Static files from the project folder, served by Casper and stopped with the browser session. HTTP readiness only, not verification." };
  }

  private async answer(root: string, request: Request): Promise<Response> {
    let name: string;
    try { name = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Bad path", { status: 400 }); }
    const file = await this.resolve(root, path.join(root, name));
    if (!file) { this.missing.push(name.slice(0, 120)); return new Response("Not found", { status: 404 }); }
    this.served++;
    return new Response(Bun.file(file), { headers: { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" } });
  }

  /** The file a path names inside the project (a folder gives its index.html), through links, or undefined. */
  private async resolve(root: string, wanted: string): Promise<string | undefined> {
    try {
      let real = await realpath(wanted);
      if (isOutside(path.relative(root, real))) return undefined;
      if ((await stat(real)).isDirectory()) {
        real = await realpath(path.join(real, "index.html"));
        if (isOutside(path.relative(root, real))) return undefined;
      }
      return (await stat(real)).isFile() ? real : undefined;
    } catch { return undefined; }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.stop(true);
  }
}
