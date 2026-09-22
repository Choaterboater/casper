import { failure, normalizeLines, success, type Line, type Order, type Result } from "./domain";
import { Inventory } from "./inventory";
import { OrderStore } from "./order-store";

export class OrderService {
  constructor(private readonly inventory: Inventory, private readonly orders: OrderStore) {}

  place(id: string, input: readonly Line[]): Result<Order> {
    if (id.trim().length === 0) return failure("invalid-order");
    if (this.orders.get(id)) return failure("duplicate-order");
    const normalized = normalizeLines(input);
    if (!normalized.ok) return normalized;
    const lines = normalized.value;
    const reserved = this.inventory.reserve(lines);
    if (!reserved.ok) return reserved;
    const order: Order = { id, status: "reserved", lines };
    this.orders.save(order);
    return success(order);
  }

  ship(id: string): Result<Order> {
    const order = this.orders.get(id);
    if (!order) return failure("missing-order");
    if (order.status !== "reserved") return failure("invalid-transition");
    this.inventory.ship(order.lines);
    const shipped: Order = { ...order, status: "shipped" };
    this.orders.save(shipped);
    return success(shipped);
  }
}
