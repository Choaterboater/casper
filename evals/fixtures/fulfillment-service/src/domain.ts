export interface Line {
  readonly sku: string;
  readonly quantity: number;
}

export interface Order {
  readonly id: string;
  readonly status: "reserved" | "shipped" | "cancelled";
  readonly lines: readonly Line[];
}

export type ErrorCode = "invalid-order" | "invalid-quantity" | "duplicate-order" | "unknown-sku"
  | "insufficient-stock" | "missing-order" | "invalid-transition" | "unknown-command";

export type Result<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorCode };

export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure(error: ErrorCode): Result<never> {
  return { ok: false, error };
}

// Order lines are canonical: unique SKUs in first-seen order, positive safe integer quantities.
// Validate each input before combining it; a negative line must not cancel out a valid one.
export function normalizeLines(lines: readonly Line[]): Result<readonly Line[]> {
  if (lines.length === 0) return failure("invalid-order");
  const quantities = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) return failure("invalid-quantity");
    const quantity = (quantities.get(line.sku) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity)) return failure("invalid-quantity");
    quantities.set(line.sku, quantity);
  }
  return success(Array.from(quantities, ([sku, quantity]) => ({ sku, quantity })));
}
