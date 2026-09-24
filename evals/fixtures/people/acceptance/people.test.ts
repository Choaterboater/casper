import { expect, test } from "bun:test";
import { search, sortUsers } from "../src/directory";
import { greeting } from "../src/email";
import { billTo } from "../src/invoice";
import { fromLegacy } from "../src/legacy";
import { displayName, sortName, type User } from "../src/user";

const user = (id: string, given: string, family: string): User => ({ id, name: { given, family }, email: `${id}@example.com` });

test("displayName and sortName format both parts and skip an empty one", () => {
  expect(displayName(user("a", "Mary Ann", "Smith"))).toBe("Mary Ann Smith");
  expect(sortName(user("a", "Mary Ann", "Smith"))).toBe("Smith, Mary Ann");
  expect(displayName(user("b", "Cher", ""))).toBe("Cher");
  expect(sortName(user("b", "Cher", ""))).toBe("Cher");
  expect(displayName(user("c", "", "Prince"))).toBe("Prince");
});

test("search looks at given, family and the combined display name", () => {
  const people = [user("a", "Mary Ann", "Smith"), user("b", "Ann", "Lee"), user("c", "Bo", "Annist")];
  expect(search(people, "ann").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  expect(search(people, "ann smith").map((entry) => entry.id)).toEqual(["a"]);
  expect(search(people, "  ").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
});

test("sort is by family, then given, ignoring case and accents, then id", () => {
  const people = [user("4", "bob", "smith"), user("3", "Álvaro", "Smith"), user("2", "Zed", "Adams"), user("1", "Alvaro", "Smith")];
  expect(sortUsers(people).map((entry) => entry.id)).toEqual(["2", "1", "3", "4"]);
});

test("greeting and billing follow the structured name", () => {
  expect(greeting(user("x", "Mary Ann", "Smith"))).toBe("Hi Mary Ann,");
  expect(greeting(user("x", "", "Prince"))).toBe("Hi Prince,");
  expect(billTo(user("x", "Cher", ""))).toBe("Bill to: Cher <x@example.com>");
});

test("legacy rows split the last word off as the family name", () => {
  expect(fromLegacy({ id: "l1", full_name: "  Mary  Ann Smith ", email: "m@example.com" }))
    .toEqual({ id: "l1", email: "m@example.com", name: { given: "Mary Ann", family: "Smith" } });
  expect(fromLegacy({ id: "l2", full_name: "Cher", email: "c@example.com" }).name).toEqual({ given: "Cher", family: "" });
});
