export interface LineItem {
  readonly description: string;
  readonly cents: number;
}

export interface Invoice {
  readonly id: string;
  readonly items: readonly LineItem[];
  readonly paidAt: string | null;
}

export function totalCents(invoice: Invoice): number {
  return invoice.items.reduce((sum, item) => sum + item.cents, 0);
}

/** Amount still owed: the total until the invoice is paid. */
export function outstandingCents(invoice: Invoice): number {
  return invoice.paidAt === null ? totalCents(invoice) : 0;
}
