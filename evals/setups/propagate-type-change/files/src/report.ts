import { invoiceTotal, type Invoice } from "./invoice";
import { add, format, zero, type Money } from "./money";

/** One grand total across every invoice. */
export function grandTotal(invoices: readonly Invoice[]): Money {
  return invoices.reduce((sum, invoice) => add(sum, invoiceTotal(invoice)), zero());
}

/** One line per invoice followed by the grand total. */
export function renderReport(invoices: readonly Invoice[]): string[] {
  const lines = invoices.map((invoice) => `${invoice.id}: ${format(invoiceTotal(invoice))}`);
  lines.push(`total: ${format(grandTotal(invoices))}`);
  return lines;
}
