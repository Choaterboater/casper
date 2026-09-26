import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

test("returns the defaults when there is nothing else", () => {
  expect(loadConfig({ name: "app", port: 3000 })).toEqual({ name: "app", port: 3000 });
});

test("a file value overrides a top-level default", () => {
  expect(loadConfig({ name: "app", port: 3000 }, { file: { port: 8080 } })).toEqual({ name: "app", port: 8080 });
});
