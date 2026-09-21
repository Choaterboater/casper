import { expect, test } from "bun:test";
import { outstandingCents, totalCents, type Invoice } from "../src/invoice";
import { summarize } from "../src/summary";

const unpaid: Invoice = { id: "inv-1", items: [{ description: "seat", cents: 250 }, { description: "tea", cents: 125 }], paidAt: null };
const paid: Invoice = { ...unpaid, paidAt: "2026-01-01T00:00:00.000Z" };

test("totals add every line item", () => {
  expect(totalCents(unpaid)).toBe(375);
});

test("outstanding is the total until the invoice is paid", () => {
  expect(outstandingCents(unpaid)).toBe(375);
  expect(outstandingCents(paid)).toBe(0);
});

test("the summary reports totals and outstanding amounts", () => {
  expect(summarize(unpaid)).toBe("inv-1: 375 cents (375 outstanding)");
  expect(summarize(paid)).toBe("inv-1: 375 cents (0 outstanding)");
});
