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
  // A refactor or rename of something named after config or docs is still a refactor.
  for (const request of ["Refactor the configuration loader", "Refactor the docs generator into modules", "Rename the setup helper to init"]) {
    expect({ request, intent: classifyTask(request).intent }).toEqual({ request, intent: "refactor" });
  }
  expect(classifyTask("Upgrade the dependency to v2").intent).toBe("configure");
});

test("removing or deleting something is a change, whatever it is named: never a request for tests", () => {
  // From a real session: "test books" made this a testing task, and the model added a test that they are gone.
  for (const request of ['remove the two "The Sapphire Compass" test books from books.json', "Delete the test user from the seed data", "remove the flaky test"]) {
    expect({ request, intent: classifyTask(request).intent }).toEqual({ request, intent: "implement" });
  }
  expect(classifyTask("Write a test for the login flow").intent).toBe("test");
  expect(classifyTask("write tests for the parser").intent).toBe("test");
});

test("a stated requirement asks for a change; a question about one is still a question", () => {
  // From a real session: "show" made this a question, so the receipt called it an inspect request.
  for (const request of ['The search should also match authors, and show "No books found" when nothing matches.', "The list must show the newest book first",
    "Search needs to ignore case"]) expect({ request, intent: classifyTask(request).intent }).toEqual({ request, intent: "implement" });
  for (const request of ["Why should the search match authors?", "Should the list show the newest book first?", "how does the search work"]) {
    expect({ request, intent: classifyTask(request).intent }).toEqual({ request, intent: "inspect" });
  }
  // A fix or test word keeps its own kind of work.
  expect(classifyTask("The login should not fail with an error").intent).toBe("fix");
});
