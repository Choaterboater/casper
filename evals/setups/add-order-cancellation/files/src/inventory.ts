import { failure, success, type Line, type Result } from "./domain";

export interface Stock {
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
}

export class Inventory {
  private readonly items = new Map<string, { onHand: number; reserved: number }>();

  constructor(seed: Readonly<Record<string, number>>) {
    for (const [sku, onHand] of Object.entries(seed)) {
      if (!Number.isSafeInteger(onHand) || onHand < 0) throw new Error("Invalid opening stock");
      this.items.set(sku, { onHand, reserved: 0 });
    }
  }

  stock(sku: string): Result<Stock> {
    const item = this.items.get(sku);
    return item ? success({ ...item, available: item.onHand - item.reserved }) : failure("unknown-sku");
  }

  // Service callers supply canonical lines. Validate the entire reservation before mutating stock.
  reserve(lines: readonly Line[]): Result<void> {
    for (const line of lines) {
      const item = this.items.get(line.sku);
      if (!item) return failure("unknown-sku");
      if (line.quantity > item.onHand - item.reserved) return failure("insufficient-stock");
    }
    for (const line of lines) this.items.get(line.sku)!.reserved += line.quantity;
    return success(undefined);
  }

  // Only a reserved order can reach these transitions; the service guards replay/state changes.
  ship(lines: readonly Line[]): void {
    for (const line of lines) {
      const item = this.items.get(line.sku)!;
      item.reserved -= line.quantity;
      item.onHand -= line.quantity;
    }
  }
}
