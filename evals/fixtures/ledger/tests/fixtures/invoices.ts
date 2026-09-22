import type { Invoice } from "../../src/invoice";

/** Shared test data. Typed against `src/`, so a type change here is a compile error until it follows. */
export const invoices: readonly Invoice[] = [
  {
    id: "INV-1",
    currency: "EUR",
    lines: [
      { description: "seat", unitPrice: { amount: 40, currency: "EUR" }, quantity: 2 },
      { description: "support", unitPrice: { amount: 40.5, currency: "EUR" }, quantity: 1 },
    ],
  },
  {
    id: "INV-2",
    currency: "USD",
    lines: [{ description: "seat", unitPrice: { amount: 33, currency: "USD" }, quantity: 3 }],
  },
  {
    id: "INV-3",
    currency: "EUR",
    lines: [{ description: "training", unitPrice: { amount: 250, currency: "EUR" }, quantity: 1 }],
  },
];
