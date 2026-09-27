import { expect, test } from "bun:test";
import { InvoiceError, totalInvoice, type Invoice } from "../src/invoice";

function issuesOf(invoice: Invoice): { path: string; message: string }[] {
  try {
    totalInvoice(invoice);
    throw new Error("expected InvoiceError, got no error");
  } catch (error) {
    if (!(error instanceof InvoiceError)) throw error;
    return error.issues;
  }
}

/** Parses a USD (2-decimal) amount string into an exact integer number of cents. */
function centsOf(amount: string): bigint {
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, frac = ""] = unsigned.split(".");
  const value = BigInt(whole + frac.padEnd(2, "0"));
  return negative ? -value : value;
}

test("01 amounts are decimal strings and all arithmetic is exact, including amounts above 2^53 minor units", () => {
  const result = totalInvoice({
    currency: "USD",
    // 9007199254740993 (2^53 + 1) is odd, so it has no exact float64 representation; the exact product
    // is 90071992547409.93, above 2^53 minor units. Computing it via floats (parseFloat and multiply,
    // with or without an intermediate Math.round) instead loses precision and gives 90071992547409.92.
    lines: [{ id: "a", quantity: "9007199254740993", unitPrice: "0.01" }],
  });
  expect(result.lines[0]!.subtotal).toBe("90071992547409.93");
});

test("02 every output amount has exactly the currency's number of decimal places", () => {
  const jpy = totalInvoice({ currency: "JPY", lines: [{ id: "a", quantity: "3", unitPrice: "100" }] });
  expect(jpy.lines[0]!.subtotal).toBe("300");
  const bhd = totalInvoice({ currency: "BHD", lines: [{ id: "a", quantity: "2", unitPrice: "0.505" }] });
  expect(bhd.lines[0]!.subtotal).toBe("1.010");
});

test("03 a zero result is never printed negative", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "-0.03", unitPrice: "0.03" }],
  });
  expect(result.lines[0]!.subtotal).toBe("0.00");
  expect(result.lines[0]!.net).toBe("0.00");
});

test("04 quantity is a decimal with at most 3 decimal places", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "1.234", unitPrice: "1.00" }],
  });
  expect(result.lines[0]!.subtotal).toBe("1.23");
});

test("05 [D] unitPrice may have up to 4 decimal places, whatever the currency", () => {
  const result = totalInvoice({
    currency: "USD",
    // quantity 1 so rounding order can never matter here (that's case 6's own concern).
    lines: [{ id: "a", quantity: "1", unitPrice: "2.5001" }],
  });
  expect(result.lines[0]!.subtotal).toBe("2.50");
});

test("06 a line's subtotal rounds the quantity-times-price product once, never the unit price first", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "5", unitPrice: "0.126" }],
  });
  // 5 * 0.126 = 0.630, which rounds to 0.63; rounding 0.126 to cents first (0.13) would give 0.65 instead.
  expect(result.lines[0]!.subtotal).toBe("0.63");
});

test("07 [D] rounding is half to even everywhere", () => {
  const a = totalInvoice({ currency: "USD", lines: [{ id: "a", quantity: "1", unitPrice: "0.125" }] });
  expect(a.lines[0]!.subtotal).toBe("0.12");
  const b = totalInvoice({ currency: "USD", lines: [{ id: "a", quantity: "1", unitPrice: "0.135" }] });
  expect(b.lines[0]!.subtotal).toBe("0.14");
});

test("08 a line discount is percent of the subtotal or a fixed amount", () => {
  const percent = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "100.00", discount: { percent: "15" } }],
  });
  expect(percent.lines[0]!.discount).toBe("15.00");
  const amount = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "100.00", discount: { amount: "20.00" } }],
  });
  expect(amount.lines[0]!.discount).toBe("20.00");
});

test("09 a line discount with both percent and amount, or the invoice discount the same way, is an issue", () => {
  const lineIssues = issuesOf({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "10.00", discount: { percent: "10", amount: "5.00" } }],
  });
  expect(lineIssues).toEqual([{ path: "lines[0].discount", message: "use percent or amount, not both" }]);
  const invoiceIssues = issuesOf({
    currency: "USD",
    discount: { percent: "10", amount: "5.00" },
    lines: [{ id: "a", quantity: "1", unitPrice: "10.00" }],
  });
  expect(invoiceIssues).toEqual([{ path: "discount", message: "use percent or amount, not both" }]);
});

test("10 an amount discount larger than the subtotal is an issue, for a line or for the invoice", () => {
  const lineIssues = issuesOf({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "10.00", discount: { amount: "15.00" } }],
  });
  expect(lineIssues).toEqual([{ path: "lines[0].discount", message: "exceeds subtotal" }]);
  const invoiceIssues = issuesOf({
    currency: "USD",
    discount: { amount: "15.00" },
    lines: [{ id: "a", quantity: "1", unitPrice: "10.00" }],
  });
  expect(invoiceIssues).toEqual([{ path: "discount", message: "exceeds subtotal" }]);
});

test("11 line discounts apply before the invoice discount", () => {
  const result = totalInvoice({
    currency: "USD",
    discount: { percent: "10" },
    lines: [{ id: "a", quantity: "2", unitPrice: "50.00", discount: { amount: "30.00" } }],
  });
  // subtotal 100.00, own discount 30.00 leaves 70.00; the invoice's 10% is 7.00 of that, not of 100.00.
  expect(result.lines[0]!.discount).toBe("37.00");
});

test("12 the invoice discount is shared in proportion to each line's amount after its own discount", () => {
  const result = totalInvoice({
    currency: "USD",
    discount: { amount: "28.00" },
    lines: [
      { id: "a", quantity: "1", unitPrice: "100.00", discount: { amount: "20.00" } },
      { id: "b", quantity: "1", unitPrice: "200.00" },
    ],
  });
  // Eligible bases are 80.00 and 200.00 (280.00 total); the 28.00 splits 8.00 / 20.00 in that
  // proportion. A basis of the raw subtotals (100 and 200) would instead give line A a 10.00 share.
  expect(result.lines[0]!.discount).toBe("28.00");
  expect(result.lines[1]!.discount).toBe("20.00");
});

test("13 the shared discount is split in minor units by largest remainder, ties to the earlier line", () => {
  const result = totalInvoice({
    currency: "USD",
    discount: { amount: "0.01" },
    lines: [
      { id: "a", quantity: "1", unitPrice: "1.00" },
      { id: "b", quantity: "1", unitPrice: "2.00" },
      { id: "c", quantity: "1", unitPrice: "2.00" },
    ],
  });
  // Bases 1.00 / 2.00 / 2.00 (sum 5.00): each gets 0 whole cents, with remainders 1 / 2 / 2 — the
  // largest remainder is tied between lines b and c, and the earlier of those two (b) gets the cent.
  // A bug that always gives the leftover to the first line would instead put it on line a.
  expect(result.lines.map((line) => line.discount)).toEqual(["0.00", "0.01", "0.00"]);
});

test("14 [D] lines with discountable: false take no share of the invoice discount", () => {
  const result = totalInvoice({
    currency: "USD",
    discount: { amount: "10.00" },
    lines: [
      { id: "a", quantity: "1", unitPrice: "100.00" },
      { id: "b", quantity: "1", unitPrice: "100.00", discountable: false },
    ],
  });
  expect(result.lines[0]!.discount).toBe("10.00");
  expect(result.lines[1]!.discount).toBe("0.00");
});

test("15 a line's net is its subtotal minus both discounts", () => {
  const result = totalInvoice({
    currency: "USD",
    discount: { amount: "18.00" },
    lines: [{ id: "a", quantity: "1", unitPrice: "100.00", discount: { amount: "10.00" } }],
  });
  // own discount 10.00 plus the invoice's full 18.00 share (the only eligible line) is 28.00.
  expect(result.lines[0]!.discount).toBe("28.00");
  expect(result.lines[0]!.net).toBe("72.00");
});

test("16 a line's tax rate is its own taxRate, else the invoice's, else 0", () => {
  const withInvoiceRate = totalInvoice({
    currency: "USD",
    taxRate: "5",
    lines: [
      { id: "a", quantity: "1", unitPrice: "100.00" },
      { id: "b", quantity: "1", unitPrice: "100.00", taxRate: "8.25" },
    ],
  });
  expect(withInvoiceRate.lines[0]!.tax).toBe("5.00");
  expect(withInvoiceRate.lines[1]!.tax).toBe("8.25");
  const withoutAny = totalInvoice({ currency: "USD", lines: [{ id: "a", quantity: "1", unitPrice: "50.00" }] });
  expect(withoutAny.lines[0]!.tax).toBe("0.00");
});

test("17 tax-exclusive prices (default): a line's tax is net times rate, rounded per line", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "100.00", taxRate: "8" }],
  });
  expect(result.lines[0]!.tax).toBe("8.00");
});

test("18 [D] tax is rounded per line, never on the invoice total", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [
      { id: "a", quantity: "1", unitPrice: "0.05", taxRate: "8" },
      { id: "b", quantity: "1", unitPrice: "0.05", taxRate: "8" },
    ],
  });
  // Each line's exact tax is 0.004 (0.05 * 8%), which rounds down to 0.00 on its own.
  expect(result.lines[0]!.tax).toBe("0.00");
  expect(result.lines[1]!.tax).toBe("0.00");
  // Summed before rounding, 0.004 + 0.004 = 0.008 would round up to 0.01; rounded per line first it is 0.00 + 0.00 = 0.00.
  expect(result.tax).toBe("0.00");
});

test("19 with pricesIncludeTax: true, a line's net divides the discounted amount by 1 + rate", () => {
  const result = totalInvoice({
    currency: "USD",
    pricesIncludeTax: true,
    lines: [{ id: "a", quantity: "1", unitPrice: "10.00", taxRate: "15" }],
  });
  expect(result.lines[0]!.net).toBe("8.70");
  expect(result.lines[0]!.tax).toBe("1.30");
});

test("20 a line's total is net plus tax", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "50.00", taxRate: "10" }],
  });
  expect(result.lines[0]!.total).toBe("55.00");
});

test("21 the invoice's subtotal, discount, net, tax and total are the sums of the line values", () => {
  const result = totalInvoice({
    currency: "USD",
    // An invoice-level discount too, so a line's discount field is itself a combination (own + share):
    // this checks only that the invoice fields equal the sums of whatever the lines report, regardless of
    // what formula produced those line values (that's cases 8, 11, 12, 15, 17-19's concern, not this one's).
    discount: { amount: "18.00" },
    lines: [
      { id: "a", quantity: "1", unitPrice: "100.00", taxRate: "10", discount: { amount: "20.00" } },
      { id: "b", quantity: "2", unitPrice: "50.00", taxRate: "20" },
    ],
  });
  const sumOfLines = (field: "subtotal" | "discount" | "net" | "tax" | "total") =>
    result.lines.reduce((sum, line) => sum + centsOf(line[field]), 0n);
  expect(centsOf(result.subtotal)).toBe(sumOfLines("subtotal"));
  expect(centsOf(result.discount)).toBe(sumOfLines("discount"));
  expect(centsOf(result.net)).toBe(sumOfLines("net"));
  expect(centsOf(result.tax)).toBe(sumOfLines("tax"));
  expect(centsOf(result.total)).toBe(sumOfLines("total"));
});

test("22 taxes groups lines by rate, sorted by rate ascending, with each group's net and tax", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [
      { id: "a", quantity: "1", unitPrice: "100.00", taxRate: "20" },
      { id: "b", quantity: "1", unitPrice: "100.00", taxRate: "5" },
      { id: "c", quantity: "1", unitPrice: "200.00", taxRate: "5" },
    ],
  });
  // Rate formatting is case 24's concern; this checks only the grouping, order and sums.
  expect(result.taxes.map((group) => ({ net: group.net, tax: group.tax }))).toEqual([
    { net: "300.00", tax: "15.00" },
    { net: "100.00", tax: "20.00" },
  ]);
});

test("23 a 0% rate appears in taxes like any other", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "50.00", taxRate: "0" }],
  });
  // A single 0% line's group must still be present (not filtered out); rate formatting is case 24's concern.
  expect(result.taxes.map((group) => ({ net: group.net, tax: group.tax }))).toEqual([{ net: "50.00", tax: "0.00" }]);
});

test("24 taxes shows each rate in its shortest decimal form", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [
      { id: "a", quantity: "1", unitPrice: "10.00", taxRate: "7.50" },
      { id: "b", quantity: "1", unitPrice: "10.00", taxRate: "8.000" },
    ],
  });
  expect(result.taxes.map((group) => group.rate)).toEqual(["7.5", "8"]);
});

test("25 [D] a negative quantity line takes no discount of either kind", () => {
  const result = totalInvoice({
    currency: "USD",
    discount: { amount: "1.00" },
    lines: [
      { id: "a", quantity: "5", unitPrice: "2.00" },
      { id: "b", quantity: "-3", unitPrice: "2.00", discount: { percent: "50" } },
    ],
  });
  expect(result.lines[1]!.discount).toBe("0.00");
  expect(result.lines[0]!.discount).toBe("1.00");
  // Its own discount is still validated, even though never applied: an out-of-range percent still issues.
  const issues = issuesOf({
    currency: "USD",
    lines: [{ id: "a", quantity: "-1", unitPrice: "2.00", discount: { percent: "150" } }],
  });
  expect(issues).toEqual([{ path: "lines[0].discount.percent", message: "percent out of range" }]);
});

test("26 the invoice total may be negative", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [{ id: "a", quantity: "-5", unitPrice: "10.00" }],
  });
  expect(result.total).toBe("-50.00");
});

test("27 output lines keep the input order and their id", () => {
  const result = totalInvoice({
    currency: "USD",
    lines: [
      { id: "b", quantity: "1", unitPrice: "1.00" },
      { id: "a", quantity: "1", unitPrice: "1.00" },
    ],
  });
  expect(result.lines.map((line) => line.id)).toEqual(["b", "a"]);
});

test("28 an unknown currency is an issue, and other checks still run and are reported too", () => {
  const issues = issuesOf({ currency: "XXX", lines: [{ id: "a", quantity: "abc", unitPrice: "1.00" }] });
  // Both issues must be present; their relative order is case 31's concern, not this one's.
  expect(issues).toHaveLength(2);
  expect(issues).toContainEqual({ path: "currency", message: "unknown currency XXX" });
  expect(issues).toContainEqual({ path: "lines[0].quantity", message: "invalid amount" });
});

test("29 no lines is an issue", () => {
  const issues = issuesOf({ currency: "USD", lines: [] });
  expect(issues).toEqual([{ path: "lines", message: "at least one line" }]);
});

test("30 a percent above 100 or below 0 is an issue, for a discount percent or a tax rate", () => {
  const discountIssues = issuesOf({
    currency: "USD",
    discount: { percent: "101" },
    lines: [{ id: "a", quantity: "1", unitPrice: "1.00" }],
  });
  expect(discountIssues).toEqual([{ path: "discount.percent", message: "percent out of range" }]);
  const taxRateIssues = issuesOf({
    currency: "USD",
    lines: [{ id: "a", quantity: "1", unitPrice: "1.00", taxRate: "-0.001" }],
  });
  expect(taxRateIssues).toEqual([{ path: "lines[0].taxRate", message: "percent out of range" }]);
});

test("31 all problems are collected and thrown together, in input order", () => {
  const issues = issuesOf({
    currency: "USD",
    taxRate: "abc",
    lines: [
      { id: "a", quantity: "abc", unitPrice: "1.00" },
      { id: "b", quantity: "1", unitPrice: "abc" },
      { id: "c", quantity: "1", unitPrice: "1.00", taxRate: "abc", discount: { percent: "abc" } },
    ],
  });
  // The invoice's own taxRate comes before any line; within line c, taxRate comes before discount.
  expect(issues).toEqual([
    { path: "taxRate", message: "invalid amount" },
    { path: "lines[0].quantity", message: "invalid amount" },
    { path: "lines[1].unitPrice", message: "invalid amount" },
    { path: "lines[2].taxRate", message: "invalid amount" },
    { path: "lines[2].discount.percent", message: "invalid amount" },
  ]);
});

test("32 a malformed amount or too many decimal places is an issue", () => {
  const cases: { path: string; invoice: Invoice }[] = [
    { path: "lines[0].quantity", invoice: { currency: "USD", lines: [{ id: "a", quantity: "1.2.3", unitPrice: "1.00" }] } },
    { path: "lines[0].quantity", invoice: { currency: "USD", lines: [{ id: "a", quantity: "abc", unitPrice: "1.00" }] } },
    { path: "lines[0].quantity", invoice: { currency: "USD", lines: [{ id: "a", quantity: "+1", unitPrice: "1.00" }] } },
    { path: "lines[0].quantity", invoice: { currency: "USD", lines: [{ id: "a", quantity: " 1", unitPrice: "1.00" }] } },
    { path: "lines[0].quantity", invoice: { currency: "USD", lines: [{ id: "a", quantity: "1.2345", unitPrice: "1.00" }] } },
    { path: "lines[0].unitPrice", invoice: { currency: "USD", lines: [{ id: "a", quantity: "1", unitPrice: "-1.00" }] } },
    { path: "lines[0].unitPrice", invoice: { currency: "USD", lines: [{ id: "a", quantity: "1", unitPrice: "1.23456" }] } },
    {
      path: "lines[0].discount.percent",
      invoice: { currency: "USD", lines: [{ id: "a", quantity: "1", unitPrice: "1.00", discount: { percent: "12.345" } }] },
    },
    { path: "lines[0].taxRate", invoice: { currency: "USD", lines: [{ id: "a", quantity: "1", unitPrice: "1.00", taxRate: "1.2.3" }] } },
  ];
  for (const { path, invoice } of cases) {
    expect({ path, issues: issuesOf(invoice) }).toEqual({ path, issues: [{ path, message: "invalid amount" }] });
  }
});
