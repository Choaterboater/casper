import { expect, test } from "bun:test";
import { components, findComponent } from "../src/components";

test("the registry exposes the components in order", () => {
  expect(components.map((component) => component.name)).toEqual(["Button", "Badge"]);
});

test("Button renders a labelled button", () => {
  expect(findComponent("Button")?.render({ label: "Save" })).toBe('<button class="btn">Save</button>');
});

test("Badge renders a labelled badge", () => {
  expect(findComponent("Badge")?.render({ label: "New" })).toBe('<span class="badge">New</span>');
});
