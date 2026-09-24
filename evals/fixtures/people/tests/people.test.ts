import { expect, test } from "bun:test";
import { search, sortUsers } from "../src/directory";
import { greeting } from "../src/email";
import { billTo } from "../src/invoice";
import { ada, alan, grace } from "./data";

test("search matches names and emails case-insensitively", () => {
  expect(search([ada, alan, grace], "TUR").map((user) => user.id)).toEqual(["u2"]);
  expect(search([ada, alan, grace], "grace@").map((user) => user.id)).toEqual(["u3"]);
});

test("users sort by family name", () => {
  expect(sortUsers([alan, ada, grace]).map((user) => user.id)).toEqual(["u3", "u1", "u2"]);
});

test("emails greet by given name and invoices use the full name", () => {
  expect(greeting(ada)).toBe("Hi Ada,");
  expect(billTo(grace)).toBe("Bill to: Grace Hopper <grace@example.com>");
});
