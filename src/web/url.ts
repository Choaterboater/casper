import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { NotExecutedError } from "../capabilities/result";

/**
 * Where a web lookup may go: public http(s) addresses on ports 80 and 443, never a private, local or
 * cloud-metadata address. Every hop of a fetch is checked again, and the request goes to the address
 * that was checked (src/web/lookup.ts), so a DNS answer can't change between the check and the connect.
 */

/** One DNS answer. */
export interface WebAddress { address: string; family: 4 | 6 }
/** Resolves a name to every address it has (tests pass a fake). */
export type WebDns = (host: string) => Promise<WebAddress[]>;

export const systemDns: WebDns = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));

const MAX_URL = 2048;

const PRIVATE = (() => {
  const list = new BlockList();
  for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
    list.addSubnet(net, bits, "ipv4");
  }
  for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
    ["100::", 64], ["2001:db8::", 32], ["2002::", 16]] as const) {
    list.addSubnet(net, bits, "ipv6");
  }
  return list;
})();

/** The IPv4 address inside ::ffff:a.b.c.d (or its hex spelling ::ffff:7f00:1), if any. */
function mappedIPv4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return undefined;
  const high = parseInt(hex[1]!, 16), low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** True only for an address on the public internet. */
export function publicAddress(ip: string): boolean {
  const text = ip.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  const family = isIP(text);
  if (!family) return false;
  if (family === 4) return !PRIVATE.check(text, "ipv4");
  const inner = mappedIPv4(text);
  if (inner) return isIP(inner) === 4 && !PRIVATE.check(inner, "ipv4");
  return !PRIVATE.check(text, "ipv6");
}

/**
 * The URL a lookup may request: http or https only, no user name or password, ports 80 and 443 only, no
 * #fragment, and http upgraded to https. `upgrade: false` (a redirect) refuses http instead, so a page
 * can't move a lookup from https down to http.
 */
export function webTarget(input: unknown, upgrade = true): URL {
  if (typeof input !== "string" || !input.trim()) throw new NotExecutedError("no web address given");
  if (input.length > MAX_URL) throw new NotExecutedError("the web address is longer than 2048 characters");
  if (/[\x00-\x20\x7f]/.test(input.trim())) throw new NotExecutedError("the web address has spaces or control characters");
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new NotExecutedError("that is not a web address"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NotExecutedError(`only http and https addresses can be looked up, not ${url.protocol.replace(/:$/, "")}`);
  if (url.username || url.password) throw new NotExecutedError("the web address holds a user name or password");
  if (url.port && url.port !== "80" && url.port !== "443") throw new NotExecutedError(`only ports 80 and 443 can be looked up, not ${url.port}`);
  if (url.protocol === "http:") {
    if (!upgrade) throw new NotExecutedError("the page sent the lookup from https to plain http");
    url.protocol = "https:";
    url.port = "";
  }
  url.hash = "";
  if (!url.hostname) throw new NotExecutedError("the web address has no host");
  return url;
}

/** The URL's host without IPv6 brackets. */
export function bareHost(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * The one address to connect to: an IP literal must be public; a name must resolve, and every address
 * it resolves to must be public (one private answer refuses the whole name).
 */
export async function resolvePublic(host: string, dns: WebDns): Promise<WebAddress> {
  const bare = host.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  const family = isIP(bare);
  if (family) {
    if (!publicAddress(bare)) throw new NotExecutedError(`${bare} is a private or local address`);
    return { address: bare, family: family === 6 ? 6 : 4 };
  }
  if (bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local") || bare.endsWith(".internal") || !bare.includes(".")) {
    throw new NotExecutedError(`${bare} is a local name`);
  }
  let answers: WebAddress[];
  try { answers = await dns(bare); } catch { throw new NotExecutedError(`${bare} could not be found`); }
  if (!answers.length) throw new NotExecutedError(`${bare} could not be found`);
  const blocked = answers.find((entry) => !publicAddress(entry.address));
  if (blocked) throw new NotExecutedError(`${bare} points to a private or local address (${blocked.address})`);
  return answers[0]!;
}
