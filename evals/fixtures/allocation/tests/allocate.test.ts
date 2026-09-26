import { expect, test } from "bun:test";
import { allocate } from "../src/allocate";

test("splits an amount evenly", () => {
  expect(allocate("100.00", "USD", [1, 1])).toEqual(["50.00", "50.00"]);
});

test("splits by ratio", () => {
  expect(allocate("90.00", "EUR", [1, 2])).toEqual(["30.00", "60.00"]);
});
