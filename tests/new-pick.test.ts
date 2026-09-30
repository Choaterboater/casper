import { expect, test } from "bun:test";
import { newProjectQuestion, newProjectSuggestion, parseNameAnswer, templateMenu } from "../src/new/pick";
import { allTemplates, listTemplates, projectSlug } from "../src/new/templates";

test("build requests map to a template and a folder name", () => {
  expect(newProjectSuggestion("build a tool that lists Mist APs per site")).toEqual({ template: "mist-python", name: "mist-aps", kind: "Mist Python project" });
  expect(newProjectSuggestion("build an MCP server for Mist")).toMatchObject({ template: "network-mcp", name: "mist-mcp" });
  expect(newProjectSuggestion("write a script that pulls Mist sites")).toMatchObject({ template: "mist-python", name: "mist-sites" });
  expect(newProjectSuggestion("Create a CLI that renames photos by date")).toMatchObject({ template: "python-cli", name: "renames-photos" });
  expect(newProjectSuggestion("make a NOC dashboard for our branches")).toMatchObject({ template: "noc-dashboard" });
  expect(newProjectSuggestion("build a React web app for tickets")).toMatchObject({ template: "web-app" });
  expect(newProjectSuggestion("write a playbook that shows interfaces on our Junos boxes")).toMatchObject({ template: "junos-ansible" });
  expect(newProjectSuggestion("write an ansible playbook for the Aruba CX switches")).toMatchObject({ template: "aoscx-ansible" });
  expect(newProjectSuggestion("can you build me a tool to count clients")).toMatchObject({ template: "python-cli", name: "clients" });
});

test("things that aren't a new project are left alone", () => {
  expect(newProjectSuggestion("build the docs")).toBeUndefined();
  expect(newProjectSuggestion("fix the bug")).toBeUndefined();
  expect(newProjectSuggestion("make the tests pass")).toBeUndefined();
  expect(newProjectSuggestion("what does this tool do?")).toBeUndefined();
  expect(newProjectSuggestion("build it for the server")).toBeUndefined();
});

test("unclear kinds ask instead of guessing", () => {
  expect(newProjectSuggestion("build an app")).toBe("ask");
  expect(newProjectSuggestion("start a new project")).toBe("ask");
  expect(newProjectSuggestion("write an ansible playbook")).toBe("ask");
});

test("templates that aren't ready are never picked", () => {
  const notReady = allTemplates().map((t) => (t.id === "mist-python" ? { ...t, ready: false } : t));
  expect(newProjectSuggestion("build a tool that lists Mist APs per site", notReady)).toBe("ask");
});

test("the question and the menu use numbered plain choices", () => {
  const suggestion = newProjectSuggestion("build a tool that lists Mist APs per site");
  if (!suggestion || suggestion === "ask") throw new Error("expected a suggestion");
  expect(newProjectQuestion(suggestion, "~/Projects")).toEqual({
    question: "Build this as a new Mist Python project in ~/Projects/mist-aps?",
    choices: ["Use this folder", "Yes", "Other kind"],
  });
  const menu = templateMenu();
  expect(menu.question).toBe("What are you building?");
  expect(menu.choices.slice(0, 3)).toEqual(["Python tool (command line)", "MCP server for your network", "Mist Python scripts"]);
  expect(menu.ids).toEqual(listTemplates().map((t) => t.id));
});

test("names: Enter takes the default, anything else must be a valid name", () => {
  expect(parseNameAnswer("", "my-tool")).toEqual({ name: "my-tool" });
  expect(parseNameAnswer(" mist-aps ", "my-tool")).toEqual({ name: "mist-aps" });
  expect(parseNameAnswer("../x", "my-tool")).toEqual({ error: "Names use lowercase letters, digits and dashes, like mist-aps." });
  expect(parseNameAnswer("Mist APs", "my-tool")).toHaveProperty("error");
});

test("projectSlug keeps up to three content words", () => {
  expect(projectSlug("that lists Mist APs per site")).toBe("mist-aps");
  expect(projectSlug("the")).toBe("");
  expect(projectSlug("show BGP peers flaps and alerts on changes")).toBe("bgp-peers-flaps");
  expect(projectSlug("2024 report")).toBe("");
});
