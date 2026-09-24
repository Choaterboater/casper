import type { Plan, SourceDevice, Update } from "./types";

export interface PlanOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly source: readonly SourceDevice[];
  readonly fetch?: typeof fetch;
}

interface NetboxDevice {
  id: number;
  name: string;
  serial: string;
}

export async function planSync(options: PlanOptions): Promise<Plan> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(`${options.baseUrl}/api/dcim/devices/?limit=50`, { headers: { authorization: `Token ${options.token}` } });
  const page = await response.json() as { results: NetboxDevice[] };
  const netbox = new Map(page.results.map((device) => [device.name, device]));
  const create: SourceDevice[] = [];
  const update: Update[] = [];
  const unchanged: string[] = [];
  for (const device of options.source) {
    const existing = netbox.get(device.name);
    if (!existing) create.push(device);
    else if (existing.serial !== device.serial) update.push({ name: device.name, id: existing.id, changes: { serial: { from: existing.serial, to: device.serial } } });
    else unchanged.push(device.name);
  }
  return { create, update, unchanged, onlyInNetbox: [] };
}
