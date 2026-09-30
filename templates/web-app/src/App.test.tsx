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
  expect(page.querySelector("h1")?.textContent).toBe("Bun + React");
});

test("the page has the API tester form", () => {
  const page = render();
  expect(page.querySelector("form")).not.toBeNull();
});
