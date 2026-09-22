import { expect, test } from "bun:test";
import { invoiceTotal, type Invoice } from "../src/invoice";
import { add, format, type Money } from "../src/money";
import { renderReport, totalsByCurrency } from "../src/report";
import { invoices } from "./fixtures/invoices";

test("an invoice totals its lines in its own currency", () => {
  expect(invoiceTotal(invoices[0]!)).toEqual({ amount: 120.5, currency: "EUR" });
  expect(invoiceTotal(invoices[1]!)).toEqual({ amount: 99, currency: "USD" });
});

test("amounts in different currencies never add up", () => {
  const eur: Money = { amount: 1, currency: "EUR" };
  const usd: Money = { amount: 1, currency: "USD" };
  expect(() => add(eur, usd)).toThrow("Currency mismatch");
  const mixed: Invoice = { id: "INV-X", currency: "EUR", lines: [{ description: "seat", unitPrice: usd, quantity: 1 }] };
  expect(() => invoiceTotal(mixed)).toThrow("Currency mismatch");
});

test("totals are grouped by currency", () => {
  expect(totalsByCurrency(invoices)).toEqual({
    EUR: { amount: 370.5, currency: "EUR" },
    USD: { amount: 99, currency: "USD" },
  });
});

test("the report shows the currency on every line", () => {
  expect(format({ amount: 5, currency: "GBP" })).toBe("5.00 GBP");
  expect(renderReport(invoices)).toEqual([
    "INV-1: 120.50 EUR",
    "INV-2: 99.00 USD",
    "INV-3: 250.00 EUR",
    "total EUR: 370.50 EUR",
    "total USD: 99.00 USD",
  ]);
});
