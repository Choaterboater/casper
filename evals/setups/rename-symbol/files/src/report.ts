import { formatCurrency } from "./format";

export interface Receipt {
  readonly id: string;
  readonly cents: number;
}

export function renderReceipt(receipt: Receipt): string {
  return `${receipt.id}: ${formatCurrency(receipt.cents)}`;
}

export function renderTotal(receipts: readonly Receipt[]): string {
  return `total ${formatCurrency(receipts.reduce((sum, receipt) => sum + receipt.cents, 0))}`;
}
