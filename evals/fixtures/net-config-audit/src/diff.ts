import { normalizeConfig } from "./normalize";
import type { Vendor } from "./vendor";

export interface ConfigDiff {
  readonly added: string[];
  readonly removed: string[];
}

export function diffConfigs(vendor: Vendor, before: string, after: string): ConfigDiff {
  const old = normalizeConfig(vendor, before);
  const updated = normalizeConfig(vendor, after);
  const had = new Set(old);
  const has = new Set(updated);
  return {
    added: [...new Set(updated.filter((line) => !had.has(line)))],
    removed: [...new Set(old.filter((line) => !has.has(line)))],
  };
}
