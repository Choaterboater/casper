import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Cloud metadata addresses: on a cloud machine, a page here can hand out that machine's cloud login. The AI's browser
 * asks once before it reaches one (AWS, Azure, GCP, Oracle; AWS IPv6; ECS task roles; Alibaba). Every other address,
 * LAN, private, loopback and the rest of link-local, opens as before.
 */
export const METADATA_HOSTS: readonly string[] = ["169.254.169.254", "fd00:ec2::254", "metadata.google.internal", "169.254.170.2", "100.100.100.200"];

/** A host as Chrome writes it in a URL, plainly: no brackets, lower case, no trailing dot; ::ffff:a.b.c.d as a.b.c.d. */
export function plainHost(host: string): string {
  let plain = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(plain);
  if (mapped?.[1]) plain = mapped[1];
  else if (mapped?.[2] && mapped[3]) {
    const high = parseInt(mapped[2], 16), low = parseInt(mapped[3], 16);
    plain = [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return plain;
}

/** The metadata address a URL's host names, or undefined. Hostnames that resolve there are checked by lookup. */
export function metadataHost(url: string, hosts: readonly string[] = METADATA_HOSTS): string | undefined {
  let host: string;
  try { host = plainHost(new URL(url).hostname); } catch { return undefined; }
  return hosts.map(plainHost).includes(host) ? host : undefined;
}

/** A name worth looking up: not an IP, not localhost (Chrome never asks DNS for those). */
function lookupWorthy(host: string): boolean {
  return Boolean(host) && !isIP(host) && host !== "localhost" && !host.endsWith(".localhost");
}

export type Lookup = (host: string) => Promise<string[]>;

/** The host's addresses, or none when it can't be looked up within a second (Chrome's own lookup decides then). */
export const systemLookup: Lookup = async host => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dnsLookup(host, { all: true }).then(found => found.map(entry => entry.address)),
      new Promise<string[]>(resolve => { timer = setTimeout(() => resolve([]), 1000); }),
    ]);
  } catch { return []; } finally { clearTimeout(timer); }
};

/** The small part of a CDP session the guard uses: a fake one in tests. */
export interface MetadataWire {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (event: unknown) => void): unknown;
}
interface Paused { requestId: string; request: { url: string }; resourceType: string; frameId?: string }
export interface BlockedRequest { url: string; address: string; mainFrame: boolean }

/**
 * Holds back every request to a cloud metadata address the person has not said yes to: a page load, a redirect, a
 * frame, a picture or a fetch. Only page documents and the metadata addresses themselves pause; all other traffic
 * never reaches Casper. What was held back is listed in `blocked` so the session can ask once, then load it again.
 */
export class MetadataGuard {
  readonly blocked: BlockedRequest[] = [];
  private readonly found = new Map<string, Promise<string | undefined>>();
  private mainFrame?: string;

  constructor(private readonly options: { allowed: (address: string) => boolean; hosts?: readonly string[]; lookup?: Lookup }) {}

  private get hosts(): readonly string[] { return this.options.hosts ?? METADATA_HOSTS; }

  /** The metadata address a URL reaches by name, by IP or by lookup, or undefined. Lookups are kept for the session. */
  async address(url: string): Promise<string | undefined> {
    const named = metadataHost(url, this.hosts);
    if (named) return named;
    let host: string;
    try { host = plainHost(new URL(url).hostname); } catch { return undefined; }
    if (!lookupWorthy(host)) return undefined;
    let pending = this.found.get(host);
    if (!pending) {
      const plain = this.hosts.map(plainHost);
      pending = (this.options.lookup ?? systemLookup)(host).then(addresses => addresses.map(plainHost).find(entry => plain.includes(entry)), () => undefined);
      this.found.set(host, pending);
    }
    return pending;
  }

  async attach(wire: MetadataWire): Promise<void> {
    const tree = await wire.send("Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } } | undefined;
    this.mainFrame = tree?.frameTree?.frame?.id;
    wire.on("Fetch.requestPaused", event => { void this.paused(wire, event as Paused); });
    const literal = this.hosts.map(plainHost).flatMap(host => isIP(host) === 6 ? [`*://[${host}]*`]
      : [`*://${host}/*`, `*://${host}:*`, ...(isIP(host) ? [] : [`*://${host}./*`, `*://${host}.:*`])]);
    await wire.send("Fetch.enable", { patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
      ...literal.map(urlPattern => ({ urlPattern, requestStage: "Request" })),
    ] });
  }

  private async paused(wire: MetadataWire, event: Paused): Promise<void> {
    let address: string | undefined;
    try { address = await this.address(event.request.url); } catch { address = undefined; }
    try {
      if (address && !this.options.allowed(address)) {
        this.blocked.push({ url: event.request.url, address, mainFrame: event.resourceType === "Document" && event.frameId === this.mainFrame });
        await wire.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      } else await wire.send("Fetch.continueRequest", { requestId: event.requestId });
    } catch {}
  }

  /** What was held back since the last call, and forget it. */
  take(): BlockedRequest[] { return this.blocked.splice(0); }
}
