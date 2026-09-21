import { formatMoney } from "./format";

export interface Receipt {
  readonly id: string;
  readonly cents: number;
}

export function renderReceipt(receipt: Receipt): string {
  return `${receipt.id}: ${formatMoney(receipt.cents)}`;
}

export function renderTotal(receipts: readonly Receipt[]): string {
  return `total ${formatMoney(receipts.reduce((sum, receipt) => sum + receipt.cents, 0))}`;
}
