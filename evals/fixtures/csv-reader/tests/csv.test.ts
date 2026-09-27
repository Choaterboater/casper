import { expect, test } from "bun:test";
import { readCsv } from "../src/csv";

test("plain rows are split on commas and newlines", () => {
  expect(readCsv("a,b\nc,d").rows).toEqual([["a", "b"], ["c", "d"]]);
});

test("a quoted field may contain a comma", () => {
  expect(readCsv('"a,b",c').rows).toEqual([["a,b", "c"]]);
});

test("header: true turns each row into an object", () => {
  expect(readCsv("a,b\n1,2", { header: true }).rows).toEqual([{ a: "1", b: "2" }]);
});
