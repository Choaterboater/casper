import { add, times, zero, type Money } from "./money";

export interface LineItem {
  readonly description: string;
  readonly unitPrice: Money;
  readonly quantity: number;
}

export interface Invoice {
  readonly id: string;
  readonly lines: readonly LineItem[];
}

/** Sum of every line. */
export function invoiceTotal(invoice: Invoice): Money {
  return invoice.lines.reduce((sum, line) => add(sum, times(line.unitPrice, line.quantity)), zero());
}
