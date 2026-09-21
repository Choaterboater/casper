import { outstandingCents, totalCents, type Invoice } from "./invoice";

/** One-line summary used by the CLI: `id: <total> cents (<outstanding> outstanding)`. */
export function summarize(invoice: Invoice): string {
  return `${invoice.id}: ${totalCents(invoice)} cents (${outstandingCents(invoice)} outstanding)`;
}
