import { expect, test } from "bun:test";
import { totalInvoice } from "../src/invoice";

test("one USD line with no tax or discount", () => {
  const result = totalInvoice({ currency: "USD", lines: [{ id: "a", quantity: "2", unitPrice: "9.99" }] });
  expect(result.lines[0]).toEqual({ id: "a", subtotal: "19.98", discount: "0.00", net: "19.98", tax: "0.00", total: "19.98" });
  expect(result.total).toBe("19.98");
});

test("one line with a 10% tax rate", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "100.00", taxRate: "10" }],
  });
  expect(result.lines[0]!.tax).toBe("10.00");
  expect(result.total).toBe("110.00");
});
