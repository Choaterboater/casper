import type { Order } from "./domain";

// In-memory storage is private to one application instance; services own lifecycle transitions.
export class OrderStore {
  private readonly orders = new Map<string, Order>();

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  save(order: Order): void {
    this.orders.set(order.id, order);
  }
}
