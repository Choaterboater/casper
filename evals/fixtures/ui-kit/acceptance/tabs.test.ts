import { expect, test } from "bun:test";
import * as kit from "../src";
import { byRole } from "./dom";

const { createTabs } = kit as unknown as { createTabs: (options: unknown) => {
  render(): string; select(id: string): void; key(key: string): void; readonly selected: string;
} };

const tabs = [
  { id: "overview", label: "Overview", panel: "Summary" },
  { id: "specs", label: "Specs & <size>", panel: "10 < 20" },
  { id: "reviews", label: "Reviews", panel: "Five stars" },
];

function state(html: string) {
  const buttons = byRole(html, "tab");
  const panels = byRole(html, "tabpanel");
  return {
    lists: byRole(html, "tablist").length,
    selected: buttons.filter((button) => button.attributes["aria-selected"] === "true").map((button) => button.attributes.id),
    focusable: buttons.filter((button) => button.attributes.tabindex === "0").map((button) => button.attributes.id),
    visible: panels.filter((panel) => !("hidden" in panel.attributes)).map((panel) => panel.attributes.id),
    buttons, panels,
  };
}

test("createTabs is exported from the package index", () => {
  expect(typeof createTabs).toBe("function");
});

test("renders a tablist with linked tabs and panels, first tab selected by default", () => {
  const html = createTabs({ tabs }).render();
  const view = state(html);
  expect(view.lists).toBe(1);
  expect(view.buttons.map((button) => button.attributes.id)).toEqual(["tab-overview", "tab-specs", "tab-reviews"]);
  expect(view.buttons.every((button) => button.tag === "button")).toBe(true);
  expect(view.buttons.map((button) => button.attributes["aria-controls"])).toEqual(["panel-overview", "panel-specs", "panel-reviews"]);
  expect(view.panels.map((panel) => [panel.attributes.id, panel.attributes["aria-labelledby"]])).toEqual([
    ["panel-overview", "tab-overview"], ["panel-specs", "tab-specs"], ["panel-reviews", "tab-reviews"],
  ]);
  expect(view.selected).toEqual(["tab-overview"]);
  expect(view.focusable).toEqual(["tab-overview"]);
  expect(view.buttons.filter((button) => button.attributes.tabindex === "-1")).toHaveLength(2);
  expect(view.visible).toEqual(["panel-overview"]);
});

test("escapes labels and panel content", () => {
  const html = createTabs({ tabs, selected: "specs" }).render();
  expect(html).toContain("Specs &amp; &lt;size&gt;");
  expect(html).toContain("10 &lt; 20");
  expect(html).not.toContain("<size>");
});

test("select() and the initial option change the selected tab and visible panel", () => {
  const component = createTabs({ tabs, selected: "reviews" });
  expect(component.selected).toBe("reviews");
  expect(state(component.render()).visible).toEqual(["panel-reviews"]);
  component.select("specs");
  expect(component.selected).toBe("specs");
  const view = state(component.render());
  expect(view.selected).toEqual(["tab-specs"]);
  expect(view.focusable).toEqual(["tab-specs"]);
  expect(view.visible).toEqual(["panel-specs"]);
});

test("arrow keys wrap, Home and End jump, other keys do nothing", () => {
  const component = createTabs({ tabs });
  component.key("ArrowLeft");
  expect(component.selected).toBe("reviews");
  component.key("ArrowRight");
  expect(component.selected).toBe("overview");
  component.key("ArrowRight");
  expect(component.selected).toBe("specs");
  component.key("End");
  expect(component.selected).toBe("reviews");
  component.key("Home");
  expect(component.selected).toBe("overview");
  component.key("Enter");
  component.key("a");
  expect(component.selected).toBe("overview");
  expect(state(component.render()).visible).toEqual(["panel-overview"]);
});

test("invalid options and unknown ids throw with the component name", () => {
  expect(() => createTabs({ tabs: [] })).toThrow(/^Tabs:/);
  expect(() => createTabs({ tabs, selected: "missing" })).toThrow(/^Tabs:/);
  expect(() => createTabs({ tabs: [tabs[0], tabs[0]] })).toThrow(/^Tabs:/);
  const component = createTabs({ tabs });
  expect(() => component.select("missing")).toThrow(/^Tabs:/);
  expect(component.selected).toBe("overview");
});

test("each instance keeps its own state", () => {
  const first = createTabs({ tabs });
  const second = createTabs({ tabs });
  first.select("reviews");
  expect(second.selected).toBe("overview");
});
