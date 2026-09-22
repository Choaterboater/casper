import { expect, test } from "bun:test";
import { createFulfillment } from "../src/app";

 test("placing an order combines repeated SKUs in first-seen order and reserves the exact total", () => {
  const app = createFulfillment({ book: 5, pen: 4 });
  const result = app.execute({ type: "place-order", id: "one", lines: [
    { sku: "book", quantity: 2 }, { sku: "pen", quantity: 1 }, { sku: "book", quantity: 3 },
  ] });
  expect(result).toEqual({ ok: true, value: { id: "one", status: "reserved", lines: [
    { sku: "book", quantity: 5 }, { sku: "pen", quantity: 1 },
  ] } });
  expect(app.order("one")).toEqual(result);
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 5, available: 0 } });
  expect(app.stock("pen")).toEqual({ ok: true, value: { onHand: 4, reserved: 1, available: 3 } });
});

test("a second order cannot reserve stock already promised to the first", () => {
  const app = createFulfillment({ book: 5 });
  app.execute({ type: "place-order", id: "one", lines: [{ sku: "book", quantity: 4 }] });
  expect(app.execute({ type: "place-order", id: "two", lines: [{ sku: "book", quantity: 2 }] }))
    .toEqual({ ok: false, error: "insufficient-stock" });
  expect(app.order("two")).toEqual({ ok: false, error: "missing-order" });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 4, available: 1 } });
});

test("a late shortage leaves earlier SKUs untouched and the rejected order ID can be retried", () => {
  const app = createFulfillment({ book: 5, pen: 0 });
  expect(app.execute({ type: "place-order", id: "retry", lines: [
    { sku: "book", quantity: 3 }, { sku: "pen", quantity: 1 },
  ] })).toEqual({ ok: false, error: "insufficient-stock" });
  expect(app.order("retry")).toEqual({ ok: false, error: "missing-order" });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 0, available: 5 } });
  expect(app.execute({ type: "place-order", id: "retry", lines: [{ sku: "book", quantity: 5 }] }))
    .toEqual({ ok: true, value: { id: "retry", status: "reserved", lines: [{ sku: "book", quantity: 5 }] } });
});

test("an unknown SKU after a valid line rejects the whole order without creating inventory", () => {
  const app = createFulfillment({ book: 5 });
  expect(app.execute({ type: "place-order", id: "one", lines: [
    { sku: "book", quantity: 2 }, { sku: "missing", quantity: 1 },
  ] })).toEqual({ ok: false, error: "unknown-sku" });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 0, available: 5 } });
  expect(app.stock("missing")).toEqual({ ok: false, error: "unknown-sku" });
  expect(app.order("one")).toEqual({ ok: false, error: "missing-order" });
});

test("repeated SKU quantities cannot each pass a check against the same available units", () => {
  const app = createFulfillment({ book: 5 });
  expect(app.execute({ type: "place-order", id: "one", lines: [
    { sku: "book", quantity: 3 }, { sku: "book", quantity: 3 },
  ] })).toEqual({ ok: false, error: "insufficient-stock" });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 0, available: 5 } });
  expect(app.order("one")).toEqual({ ok: false, error: "missing-order" });
});

test("invalid individual quantities cannot be hidden by combining repeated SKUs", () => {
  const app = createFulfillment({ book: 5 });
  expect(app.execute({ type: "place-order", id: "one", lines: [
    { sku: "book", quantity: 3 }, { sku: "book", quantity: -1 },
  ] })).toEqual({ ok: false, error: "invalid-quantity" });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 0, available: 5 } });
  expect(app.order("one")).toEqual({ ok: false, error: "missing-order" });
});

test("combining individually safe quantities must not overflow the domain's integer range", () => {
  const app = createFulfillment({ book: Number.MAX_SAFE_INTEGER });
  expect(app.execute({ type: "place-order", id: "one", lines: [
    { sku: "book", quantity: Number.MAX_SAFE_INTEGER }, { sku: "book", quantity: 1 },
  ] })).toEqual({ ok: false, error: "invalid-quantity" });
  expect(app.stock("book")).toEqual({ ok: true, value: {
    onHand: Number.MAX_SAFE_INTEGER, reserved: 0, available: Number.MAX_SAFE_INTEGER,
  } });
});

test("an order needs an identity and at least one line", () => {
  const app = createFulfillment({ book: 5 });
  expect(app.execute({ type: "place-order", id: " ", lines: [{ sku: "book", quantity: 1 }] }))
    .toEqual({ ok: false, error: "invalid-order" });
  expect(app.execute({ type: "place-order", id: "empty", lines: [] }))
    .toEqual({ ok: false, error: "invalid-order" });
  expect(app.order("empty")).toEqual({ ok: false, error: "missing-order" });
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 0, available: 5 } });
});

test("duplicate order identity does not reserve twice or replace the original order", () => {
  const app = createFulfillment({ book: 5 });
  const original = app.execute({ type: "place-order", id: "one", lines: [{ sku: "book", quantity: 2 }] });
  expect(app.execute({ type: "place-order", id: "one", lines: [{ sku: "book", quantity: 1 }] }))
    .toEqual({ ok: false, error: "duplicate-order" });
  expect(app.order("one")).toEqual(original);
  expect(app.stock("book")).toEqual({ ok: true, value: { onHand: 5, reserved: 2, available: 3 } });
});
