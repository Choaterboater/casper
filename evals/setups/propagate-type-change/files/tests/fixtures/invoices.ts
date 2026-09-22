import type { Invoice } from "../../src/invoice";

/** Shared test data. Typed against `src/`, so a type change here is a compile error until it follows. */
export const invoices: readonly Invoice[] = [
  {
    id: "INV-1",
    lines: [
      { description: "seat", unitPrice: { amount: 40 }, quantity: 2 },
      { description: "support", unitPrice: { amount: 40.5 }, quantity: 1 },
    ],
  },
  {
    id: "INV-2",
    lines: [{ description: "seat", unitPrice: { amount: 33 }, quantity: 3 }],
  },
  {
    id: "INV-3",
    lines: [{ description: "training", unitPrice: { amount: 250 }, quantity: 1 }],
  },
];
