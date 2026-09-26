import { expect, test } from "bun:test";
import { allocate } from "../src/allocate";

const cents = (parts: string[]) => parts.reduce((sum, part) => sum + BigInt(part.replace(".", "")), 0n);

test("leftover cents go to the largest remainders, ties to the earlier ratio", () => {
  expect(allocate("100.00", "USD", [1, 1, 1])).toEqual(["33.34", "33.33", "33.33"]);
  expect(allocate("0.05", "USD", [3, 7])).toEqual(["0.02", "0.03"]);
  expect(allocate("0.10", "USD", [1, 1, 1, 1, 1, 1, 1])).toEqual(["0.02", "0.02", "0.02", "0.01", "0.01", "0.01", "0.01"]);
  // 1.00 by 1:2:3:4 is 10 / 20 / 30 / 40 exactly; 1.01 leaves one cent for the largest remainder (index 3: 0.4).
  expect(allocate("1.01", "USD", [1, 2, 3, 4])).toEqual(["0.10", "0.20", "0.30", "0.41"]);
});

test("the parts always add up to the amount", () => {
  for (const [amount, ratios] of [["10.00", [3, 3, 3]], ["0.01", [1, 1]], ["999.99", [7, 11, 13, 17]], ["1.00", [1, 1, 1, 1, 1, 1]]] as const) {
    const parts = allocate(amount, "USD", ratios);
    expect({ amount, total: cents(parts) }).toEqual({ amount, total: BigInt(amount.replace(".", "")) });
  }
});

test("a negative amount mirrors the positive split, and zero parts are never negative", () => {
  expect(allocate("-100.00", "USD", [1, 1, 1])).toEqual(["-33.34", "-33.33", "-33.33"]);
  expect(allocate("-0.01", "USD", [1, 1])).toEqual(["-0.01", "0.00"]);
  expect(allocate("0.00", "USD", [1, 2])).toEqual(["0.00", "0.00"]);
});

test("each currency uses its own minor units and every part is printed with exactly that many digits", () => {
  expect(allocate("100", "JPY", [1, 1, 1])).toEqual(["34", "33", "33"]);
  expect(allocate("1.000", "KWD", [1, 2])).toEqual(["0.333", "0.667"]);
  expect(allocate("1", "KWD", [1, 1])).toEqual(["0.500", "0.500"]);
  expect(allocate("5.5", "USD", [1])).toEqual(["5.50"]);
});

test("amounts beyond floating-point precision stay exact", () => {
  expect(allocate("92233720368547758.07", "USD", [1, 1])).toEqual(["46116860184273879.04", "46116860184273879.03"]);
});

test("rejects amounts with more decimal places than the currency has, malformed amounts and unknown currencies", () => {
  for (const [amount, currency] of [["100.5", "JPY"], ["1.001", "USD"], ["1.", "USD"], [".5", "USD"], ["abc", "USD"], ["1e3", "USD"], ["+1.00", "USD"], ["", "USD"], ["1.00", "XXX"], ["1.00", "toString"]]) {
    expect(() => allocate(amount!, currency!, [1])).toThrow(RangeError);
  }
});

test("rejects an empty ratio list and ratios that are not positive integers", () => {
  for (const ratios of [[], [0], [1, 0], [-1, 2], [1.5, 1], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
    expect(() => allocate("1.00", "USD", ratios)).toThrow(RangeError);
  }
});
