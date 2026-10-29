/**
 * After a task, the Next row offers to keep what you said "Yes, for this session" to during it: `Always allow npm test
 * in this project`, which runs `/allowed keep <n>`. That replaces the approval box's fourth row, "Yes, always for this
 * project" (docs/adr/0002/45-three-row-approvals.md). Each yes is offered once; only your own key or typed command keeps it.
 */
import type { SandboxStore } from "../sandbox/store";
import type { NextItem } from "../tui/next-row";

/** At most this many on one Next row, newest first. */
const MOST = 2;

/** The session yeses not offered yet, as Next row items; they count as offered from now on. */
export function keepNextItems(store: SandboxStore): NextItem[] {
  const fresh = store.keepable.map((offer, index) => ({ offer, number: index + 1 })).filter(({ offer }) => !offer.offered && !offer.kept);
  for (const { offer } of fresh) offer.offered = true;
  return fresh.slice(-MOST).reverse().map(({ offer, number }) => ({ label: `Always allow ${offer.what} in this project`, command: `/allowed keep ${number}` }));
}
