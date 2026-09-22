import { failure, success, type Line, type Order, type Result } from "./domain";
import { Inventory } from "./inventory";
import { OrderService } from "./order-service";
import { OrderStore } from "./order-store";

// Public commands use kebab-case discriminants and return Result, not thrown domain errors.
export type Command = { readonly type: "place-order"; readonly id: string; readonly lines: readonly Line[] }
  | { readonly type: "ship-order"; readonly id: string }
  | { readonly type: "cancel-order"; readonly id: string };

export function createFulfillment(seed: Readonly<Record<string, number>>) {
  const inventory = new Inventory(seed);
  const orders = new OrderStore();
  const service = new OrderService(inventory, orders);
  return {
    execute(command: Command): Result<Order> {
      switch (command.type) {
        case "place-order": return service.place(command.id, command.lines);
        case "ship-order": return service.ship(command.id);
        case "cancel-order": return service.cancel(command.id);
        default: return failure("unknown-command");
      }
    },
    order(id: string): Result<Order> {
      const order = orders.get(id);
      return order ? success(order) : failure("missing-order");
    },
    stock(sku: string) {
      return inventory.stock(sku);
    },
  };
}
