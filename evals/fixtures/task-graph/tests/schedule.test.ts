import { expect, test } from "bun:test";
import { schedule } from "../src/schedule";

test("orders a chain so each task follows its dependency", () => {
  expect(schedule({ deploy: ["build"], build: ["install"], install: [] })).toEqual(["install", "build", "deploy"]);
});
