import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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

test("a request for a report, review or audit, or one that says not to change anything, is read-only: debug or change in it doesn't make it a fix", () => {
  // From a real session: "debug" made this audit a fix task, and verification and repair rounds were forced onto it.
  for (const request of [
    "run a crew debug and report back to one and review it - ux, uxi, debug, audit, interface, backend,frontend, optimization,code, deadcode",
    "look for issues and report back, don't change anything",
    "audit the code and report back",
    "review the app for bugs and report",
    "why does the login fail? do not modify any files",
    "find the dead code and report it without changing anything",
  ]) expect({ request, ...classifyTask(request) }).toEqual({ request, intent: classifyTask(request).intent, mode: "read", verification: [] });
  // A request that also asks for the change is still one.
  for (const [request, intent] of [
    ["fix the debug output", "fix"],
    ["debug why the export fails and fix it", "fix"],
    ["review the PR feedback and fix it", "fix"],
    ["audit the dependencies and update the outdated ones", "implement"],
    ["don't change the API, but fix the login bug", "fix"],
    ["debug the login flow", "fix"],
  ] as const) expect({ request, intent: classifyTask(request).intent, mode: classifyTask(request).mode }).toEqual({ request, intent, mode: "modify" });
});

test("the verification guide says a report, review or audit request is read-only", async () => {
  const doc = (await readFile(new URL("../docs/VERIFICATION.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
  expect(doc).toContain("A request for a report, review or audit, or one that says not to change anything");
  expect(doc).toContain("is read-only even when it names debugging or changes: the AI is told so, and it gets no checklist or proof step, unless it also asks for a change");
});
