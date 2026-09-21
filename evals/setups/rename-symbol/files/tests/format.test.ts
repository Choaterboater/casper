import { expect, test } from "bun:test";
import { formatCurrency } from "../src/format";
import { renderReceipt, renderTotal } from "../src/report";

test("amounts render with two decimal places", () => {
  expect(formatCurrency(0)).toBe("USD 0.00");
  expect(formatCurrency(5)).toBe("USD 0.05");
  expect(formatCurrency(1234)).toBe("USD 12.34");
  expect(formatCurrency(-1234)).toBe("-USD 12.34");
});

test("receipts use the shared formatter", () => {
  expect(renderReceipt({ id: "r1", cents: 250 })).toBe("r1: USD 2.50");
  expect(renderTotal([{ id: "r1", cents: 250 }, { id: "r2", cents: 100 }])).toBe("total USD 3.50");
});
