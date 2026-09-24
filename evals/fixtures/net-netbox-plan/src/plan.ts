import type { Field, Plan, SourceDevice, Update } from "./types";

export interface PlanOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly source: readonly SourceDevice[];
  readonly fetch?: typeof fetch;
}

interface NetboxDevice {
  id: number;
  name: string | null;
  serial?: string | null;
  site?: { slug?: string | null } | null;
  role?: { slug?: string | null } | null;
  device_role?: { slug?: string | null } | null;
  primary_ip4?: { address?: string | null } | null;
}

const FIELDS: readonly Field[] = ["serial", "site", "role", "primaryIp4"];
const value = (text: string | null | undefined) => text === undefined || text === null || text === "" ? null : text;
const byName = (left: { name: string }, right: { name: string }) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

async function fetchDevices(options: PlanOptions): Promise<NetboxDevice[]> {
  const fetcher = options.fetch ?? fetch;
  const devices: NetboxDevice[] = [];
  const seen = new Set<string>();
  let url: string | null = `${options.baseUrl.replace(/\/+$/, "")}/api/dcim/devices/?limit=50`;
  while (url) {
    if (seen.has(url)) throw new Error(`Pagination loop at ${url}`);
    seen.add(url);
    const response = await fetcher(url, { method: "GET", headers: { authorization: `Token ${options.token}`, accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    const page = await response.json() as { next: string | null; results: NetboxDevice[] };
    devices.push(...page.results);
    url = page.next;
  }
  return devices;
}

function current(device: NetboxDevice): Record<Field, string | null> {
  return {
    serial: value(device.serial),
    site: value(device.site?.slug),
    role: value((device.role ?? device.device_role)?.slug),
    primaryIp4: value(device.primary_ip4?.address),
  };
}

export async function planSync(options: PlanOptions): Promise<Plan> {
  const names = new Set<string>();
  for (const device of options.source) {
    if (names.has(device.name)) throw new Error(`Duplicate source device: ${device.name}`);
    names.add(device.name);
  }
  const netbox = new Map<string, NetboxDevice>();
  for (const device of await fetchDevices(options)) if (device.name) netbox.set(device.name, device);
  const create: SourceDevice[] = [];
  const update: Update[] = [];
  const unchanged: string[] = [];
  for (const device of options.source) {
    const existing = netbox.get(device.name);
    if (!existing) { create.push(device); continue; }
    const have = current(existing);
    const changes: Update["changes"] = {};
    for (const field of FIELDS) {
      const want = value(device[field]);
      if (have[field] !== want) (changes as Record<Field, { from: string | null; to: string | null }>)[field] = { from: have[field], to: want };
    }
    if (Object.keys(changes).length) update.push({ name: device.name, id: existing.id, changes });
    else unchanged.push(device.name);
  }
  const onlyInNetbox = [...netbox.keys()].filter((name) => !names.has(name));
  return {
    create: create.sort(byName),
    update: update.sort(byName),
    unchanged: unchanged.sort(),
    onlyInNetbox: onlyInNetbox.sort(),
  };
}
