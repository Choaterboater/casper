import net from "node:net";
import { hostListed, hostName } from "../../sandbox/policy";

/**
 * One sandboxed MCP server's own way out: a small HTTPS proxy (CONNECT only) that lets it reach the hosts on its
 * list and nothing else. The sandbox lets the server connect only to this proxy, so the list is the whole network
 * it has. Each server gets its own proxy, so one server's hosts are never another's. Plain http is refused: every
 * product host is https.
 */

const MAX_HEAD = 8 * 1024;

export interface HostProxyOptions {
  hosts: readonly string[];
  /** A Unix socket path to listen on (Linux, bridged into the sandbox); else 127.0.0.1 on a free port. */
  socket?: string;
  /** Called once per host the proxy refused. */
  onRefused?: (host: string) => void;
}

export class HostProxy {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly refusedHosts = new Set<string>();
  private port?: number;

  private constructor(private readonly options: HostProxyOptions) {
    this.server = net.createServer((client) => this.handle(client));
  }

  static async start(options: HostProxyOptions): Promise<HostProxy> {
    const proxy = new HostProxy(options);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject);
      const ready = () => { proxy.server.off("error", reject); resolve(); };
      if (options.socket) proxy.server.listen(options.socket, ready);
      else proxy.server.listen(0, "127.0.0.1", ready);
    });
    const address = proxy.server.address();
    if (address && typeof address === "object") proxy.port = address.port;
    proxy.server.unref();
    return proxy;
  }

  /** The TCP port (when not on a socket). */
  get listenPort(): number | undefined { return this.port; }

  /** Hosts it refused so far. */
  refused(): string[] { return [...this.refusedHosts]; }

  allows(host: string): boolean {
    return hostListed(host, this.options.hosts);
  }

  private handle(client: net.Socket): void {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEAD) client.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
        return;
      }
      client.off("data", onData);
      client.pause();
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const rest = head.subarray(end + 4);
      this.connect(client, line, rest);
    };
    client.on("data", onData);
  }

  private connect(client: net.Socket, line: string, rest: Buffer): void {
    const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(line.trim());
    if (!match) { client.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n"); return; }
    const target = parseTarget(match[1]!);
    if (!target) { client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"); return; }
    if (!this.allows(target.host)) {
      const name = hostName(target.host);
      if (!this.refusedHosts.has(name)) { this.refusedHosts.add(name); this.options.onRefused?.(name); }
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: target.host, port: target.port });
    this.sockets.add(upstream);
    upstream.on("close", () => { this.sockets.delete(upstream); client.destroy(); });
    upstream.on("error", () => {
      if (!client.destroyed && client.bytesWritten === 0) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      else client.destroy();
    });
    client.on("close", () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** `host:port` or `[v6]:port` from a CONNECT line; the port must be there. */
export function parseTarget(authority: string): { host: string; port: number } | undefined {
  const v6 = /^\[([0-9a-f:.]+)\]:(\d{1,5})$/i.exec(authority);
  const plain = /^([^\s:/[\]@]+):(\d{1,5})$/.exec(authority);
  const found = v6 ?? plain;
  if (!found) return undefined;
  const port = Number(found[2]);
  if (!port || port > 65535) return undefined;
  return { host: found[1]!, port };
}
