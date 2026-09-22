import { expect, test } from "bun:test";
import { MAX_PAGE_SIZE, pageCount, paginate } from "../src/pagination";

const items = Array.from({ length: 250 }, (_, index) => index + 1);

test("pages are 1-based and sized as requested", () => {
  expect(paginate(items, { page: 1, size: 10 })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(paginate(items, { page: 3, size: 10 })).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  expect(paginate(items, { page: 26, size: 10 })).toEqual([]);
});

test("the page size is clamped to the v1 contract", () => {
  expect(MAX_PAGE_SIZE).toBe(100);
  expect(paginate(items, { page: 1, size: 500 })).toHaveLength(100);
  expect(paginate(items, { page: 3, size: 500 })).toEqual(items.slice(200));
  expect(pageCount(250, 500)).toBe(3);
});

test("invalid requests yield an empty page", () => {
  expect(paginate(items, { page: 0, size: 10 })).toEqual([]);
  expect(paginate(items, { page: 1, size: 0 })).toEqual([]);
  expect(paginate(items, { page: 1.5, size: 10 })).toEqual([]);
  expect(pageCount(250, 0)).toBe(0);
});
