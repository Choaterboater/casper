import { expect, test } from "bun:test";
import { paginate } from "../src/pagination";

// Requested by the exports team: the nightly export wants 250-row pages.
const items = Array.from({ length: 300 }, (_, index) => index + 1);

test("exports can request 250-row pages", () => {
  expect(paginate(items, { page: 1, size: 250 })).toHaveLength(250);
  expect(paginate(items, { page: 2, size: 250 })).toHaveLength(50);
});
