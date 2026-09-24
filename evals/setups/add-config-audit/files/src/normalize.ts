import type { Vendor } from "./vendor";

// TODO: drop volatile lines (comments, headers), mask Junos $9$ secrets, keep AOS-CX hierarchy.
export function normalizeConfig(vendor: Vendor, text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}
