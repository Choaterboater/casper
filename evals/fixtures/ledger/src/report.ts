import { invoiceTotal, type Invoice } from "./invoice";
import { add, format, type Money } from "./money";

/** Grand totals keyed by currency; invoices in different currencies are never summed together. */
export function totalsByCurrency(invoices: readonly Invoice[]): Record<string, Money> {
  const totals: Record<string, Money> = {};
  for (const invoice of invoices) {
    const total = invoiceTotal(invoice);
    const current = totals[total.currency];
    totals[total.currency] = current ? add(current, total) : total;
  }
  return totals;
}

/** One line per invoice followed by one line per currency total. */
export function renderReport(invoices: readonly Invoice[]): string[] {
  const lines = invoices.map((invoice) => `${invoice.id}: ${format(invoiceTotal(invoice))}`);
  for (const [currency, total] of Object.entries(totalsByCurrency(invoices)).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`total ${currency}: ${format(total)}`);
  }
  return lines;
}
