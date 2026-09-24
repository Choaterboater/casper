import { expect, test } from "bun:test";
import { createToggle } from "../src";

test("renders pressed state and escapes the label", () => {
  const toggle = createToggle({ label: "Bold <b>" });
  expect(toggle.render()).toBe('<button type="button" aria-pressed="false">Bold &lt;b&gt;</button>');
  toggle.toggle();
  expect(toggle.pressed).toBe(true);
  expect(toggle.render()).toContain('aria-pressed="true"');
});

test("rejects an empty label", () => {
  expect(() => createToggle({ label: " " })).toThrow("Toggle:");
});
