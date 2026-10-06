import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

function render(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<App />));
  return container;
}

test("the page shows its heading", () => {
  const page = render();
  expect(page.querySelector("h1")?.textContent).toBe("{{name}}");
});

test("every field in the form has a label", () => {
  const page = render();
  const fields = [...page.querySelectorAll("input, select")];
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) expect(page.querySelector(`label[for="${field.id}"]`)).not.toBeNull();
});

test("before a request, the answer area says what will show there", () => {
  const page = render();
  expect(page.textContent).toContain("No answer yet");
});
