import { expect, test } from "bun:test";
import { createRouter } from "../src/router";
import { inventory } from "./data";

const text = (result: { content: readonly { text: string }[] }) => result.content.map((part) => part.text).join("");

test("only the three router tools are listed", () => {
  expect(createRouter(inventory).listTools().map((tool) => tool.name)).toEqual(["find_tool", "invoke_read_tool", "invoke_tool"]);
});

test("find_tool discovers device tools and invoke_read_tool runs read-only ones", () => {
  const router = createRouter(inventory);
  expect(JSON.parse(text(router.callTool("find_tool", { query: "version" }))).map((tool: { name: string }) => tool.name)).toEqual(["show_version"]);
  expect(JSON.parse(text(router.callTool("invoke_read_tool", { name: "show_version", arguments: { device: "lab-sw1" } }))))
    .toEqual({ device: "lab-sw1", model: "6300M", firmware: "FL.10.13.1000" });
});

test("write tools are refused by invoke_read_tool and need confirmation", () => {
  const router = createRouter(inventory);
  const args = { name: "set_interface_description", arguments: { device: "lab-sw1", interface: "1/1/1", description: "x" } };
  expect(router.callTool("invoke_read_tool", args).isError).toBe(true);
  expect(router.callTool("invoke_tool", args).isError).toBe(true);
});
