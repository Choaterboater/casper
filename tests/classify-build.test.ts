import { expect, test } from "bun:test";
import { classifyTask } from "../src/task/classify";

test("a build verb beats a configuration, docs or refactor word elsewhere in the request", () => {
  for (const request of [
    "Add a tool that returns the running configuration",
    "Add an MCP tool to fetch the switch configuration and show the diff",
    "Implement a command that installs nothing and prints the setup status",
    "Build a page that renders the README",
    "Create a helper that renames interface descriptions",
  ]) expect({ request, intent: classifyTask(request).intent }).toEqual({ request, intent: "implement" });
});

test("configuration, docs or a refactor as the object of the verb, or with no build verb, keep their intent", () => {
  expect(classifyTask("Add configuration for eslint").intent).toBe("configure");
  expect(classifyTask("Set up the dev container").intent).toBe("configure");
  expect(classifyTask("Add docs for the login flow").intent).toBe("document");
  expect(classifyTask("Refactor the parser").intent).toBe("refactor");
  expect(classifyTask("Upgrade the dependency to v2").intent).toBe("configure");
});
