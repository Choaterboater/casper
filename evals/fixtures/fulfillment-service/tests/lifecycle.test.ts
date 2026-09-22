import { expect, test } from "bun:test";
import { createFulfillment } from "../src/app";

test("shipment consumes the normalized order once and preserves other orders' reservations", () => {
  const app = createFulfillment({ book: 10, pen: 4 });
  app.execute({ type: "place-order", id: "one", lines: [
    { sku: "book", quantity: 2 }, { sku: "pen", quantity: 1 }, { sku: "book", quantity: 3 },
  ] });
  app.execute({ type: "place-order", id: "two", lines: [{ sku: "book", quantity: 2 }] });
  const shipped = app.execute({ type: "ship-order", id: "one" });
  expect(shipped).toEqual({ ok: true, value: { id: "one", status: "shipped", lines: [
    { sku: "book", quantity: 5 }, { sku: "pen", quantity: 1 },
  ] } });
  expect(app.order("one")).toEqual(shipped);
  expect(app.execute({ type: "ship-order", id: "one" })).toEqual({ ok: false, error: "invalid-transition" });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 2, available: 3 } });
  expect(app.stock("pen")).toEqual({ ok: true, value: { onHand: 3, reserved: 0, available: 3 } });
});

test("cancellation releases every line without consuming stock or releasing another order's units", () => {
  const app = createFulfillment({ book: 10, pen: 4 });
  app.execute({ type: "place-order", id: "one", lines: [
    { sku: "book", quantity: 2 }, { sku: "pen", quantity: 1 }, { sku: "book", quantity: 3 },
  ] });
  const other = app.execute({ type: "place-order", id: "two", lines: [{ sku: "book", quantity: 2 }] });
  const cancelled = app.execute({ type: "cancel-order", id: "one" });
  expect(cancelled).toEqual({ ok: true, value: { id: "one", status: "cancelled", lines: [
    { sku: "book", quantity: 5 }, { sku: "pen", quantity: 1 },
  ] } });
  expect(app.order("one")).toEqual(cancelled);
  expect(app.order("two")).toEqual(other);
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 10, reserved: 2, available: 8 } });
  expect(app.stock("pen")).toEqual({ ok: true, value: { onHand: 4, reserved: 0, available: 4 } });
  expect(app.execute({ type: "place-order", id: "three", lines: [{ sku: "book", quantity: 8 }] }))
    .toEqual({ ok: true, value: { id: "three", status: "reserved", lines: [{ sku: "book", quantity: 8 }] } });
});

test("repeated cancellation is idempotent even after released stock has been reserved again", () => {
  const app = createFulfillment({ book: 5 });
  app.execute({ type: "place-order", id: "one", lines: [{ sku: "book", quantity: 5 }] });
  const cancelled = app.execute({ type: "cancel-order", id: "one" });
  app.execute({ type: "place-order", id: "two", lines: [{ sku: "book", quantity: 5 }] });
  expect(app.execute({ type: "cancel-order", id: "one" })).toEqual(cancelled);
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 5, available: 0 } });
  expect(app.execute({ type: "ship-order", id: "two" })).toEqual({ ok: true, value: {
    id: "two", status: "shipped", lines: [{ sku: "book", quantity: 5 }],
  } });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 0, reserved: 0, available: 0 } });
});

test("a shipped order cannot be cancelled and a cancelled order cannot ship or reuse its identity", () => {
  const app = createFulfillment({ book: 5 });
  app.execute({ type: "place-order", id: "shipped", lines: [{ sku: "book", quantity: 2 }] });
  const shipped = app.execute({ type: "ship-order", id: "shipped" });
  expect(app.execute({ type: "cancel-order", id: "shipped" })).toEqual({ ok: false, error: "invalid-transition" });
  expect(app.order("shipped")).toEqual(shipped);
  app.execute({ type: "place-order", id: "cancelled", lines: [{ sku: "book", quantity: 3 }] });
  const cancelled = app.execute({ type: "cancel-order", id: "cancelled" });
  expect(app.execute({ type: "ship-order", id: "cancelled" })).toEqual({ ok: false, error: "invalid-transition" });
  expect(app.execute({ type: "place-order", id: "cancelled", lines: [{ sku: "book", quantity: 1 }] }))
    .toEqual({ ok: false, error: "duplicate-order" });
  expect(app.order("cancelled")).toEqual(cancelled);
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 3, reserved: 0, available: 3 } });
});

test("unknown orders return missing-order for both lifecycle commands without touching stock", () => {
  const app = createFulfillment({ book: 5 });
  expect(app.execute({ type: "cancel-order", id: "missing" })).toEqual({ ok: false, error: "missing-order" });
  expect(app.execute({ type: "ship-order", id: "missing" })).toEqual({ ok: false, error: "missing-order" });
  expect(app.order("missing")).toEqual({ ok: false, error: "missing-order" });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 0, available: 5 } });
});
