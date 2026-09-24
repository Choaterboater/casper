export interface ExportOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly orgId: string;
  readonly perPage?: number;
  readonly fetch?: typeof fetch;
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

export async function exportInventory(options: ExportOptions): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const url = `${base}/organizations/${encodeURIComponent(options.orgId)}/devices?perPage=${options.perPage ?? 1000}`;
  const response = await fetcher(url, { headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" } });
  const devices = await response.json() as Device[];
  const rows = devices.map((device) => [device.serial, device.name, device.model, device.networkId, device.mac, device.lanIp, (device.tags ?? []).join(" ")].join(","));
  return [COLUMNS.join(","), ...rows].map((line) => `${line}\n`).join("");
}
