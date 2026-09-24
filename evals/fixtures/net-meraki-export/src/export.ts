import { csvRow } from "./csv";

export interface ExportOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly orgId: string;
  readonly perPage?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Consecutive 429 responses tolerated for one URL before giving up. */
  readonly maxRateLimitRetries?: number;
}

interface Device {
  serial?: string | null;
  name?: string | null;
  model?: string | null;
  networkId?: string | null;
  mac?: string | null;
  lanIp?: string | null;
  tags?: string[] | null;
}

export const COLUMNS = ["serial", "name", "model", "networkId", "mac", "lanIp", "tags"] as const;

/** The `rel=next` target of a Link header, or null. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]*)>\s*(.*)$/.exec(part);
    if (!match) continue;
    const rels = match[2]!.split(";").map((parameter) => parameter.trim()).filter((parameter) => /^rel\s*=/i.test(parameter))
      .flatMap((parameter) => parameter.replace(/^rel\s*=\s*/i, "").replace(/^"|"$/g, "").split(/\s+/));
    if (rels.some((rel) => rel.toLowerCase() === "next")) return match[1]!;
  }
  return null;
}

export async function exportInventory(options: ExportOptions): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const limit = options.maxRateLimitRetries ?? 5;
  const base = options.baseUrl.replace(/\/+$/, "");
  let url: string | null = `${base}/organizations/${encodeURIComponent(options.orgId)}/devices?perPage=${options.perPage ?? 1000}`;
  const devices: Device[] = [];
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url)) throw new Error(`Pagination loop at ${url}`);
    seen.add(url);
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetcher(url, { headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" } });
      if (response.status !== 429) break;
      if (attempt >= limit) throw new Error(`Rate limited ${attempt + 1} times at ${url}`);
      const seconds = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`Expected a JSON array from ${url}`);
    devices.push(...page as Device[]);
    url = nextLink(response.headers.get("link"));
  }
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const rows = devices
    .map((device) => [text(device.serial), text(device.name), text(device.model), text(device.networkId), text(device.mac), text(device.lanIp),
      Array.isArray(device.tags) ? device.tags.filter((tag) => typeof tag === "string").join(" ") : ""])
    .sort((left, right) => left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0);
  return [csvRow(COLUMNS), ...rows.map(csvRow)].map((line) => `${line}\n`).join("");
}
