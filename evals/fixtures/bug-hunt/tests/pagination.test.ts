import { expect, test } from "bun:test";
import { pageCount, paginate } from "../src/pagination";

const items = ["a", "b", "c", "d", "e"];

test("a page larger than the collection returns everything available", () => {
  expect(paginate(items, 1, 10)).toEqual(items);
});

test("pages past the end are empty", () => {
  expect(paginate(items, 3, 10)).toEqual([]);
});

test("invalid page or size arguments return nothing", () => {
  expect(paginate(items, 0, 2)).toEqual([]);
  expect(paginate(items, 1, 0)).toEqual([]);
});

test("page count rounds up", () => {
  expect(pageCount(5, 2)).toBe(3);
  expect(pageCount(0, 2)).toBe(0);
});
