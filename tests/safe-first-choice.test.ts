import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ALREADY_FAILING_CHOICES, MCP_REMEMBER_CHOICES, MCP_WRITES_CHOICES, modelFailedChoices, PLAN_CHOICES, PLAN_QUESTION, REMEMBER_BIG_MODEL_CHOICES,
  REPAIR_LIMIT_STOP, spendChoices, undoChangedChoices, missingFolderChoices, workFolderChoices, unfinishedChoices, HOST_CHOICES, SHELL_COMMAND_CHOICES, AI_REVIEW_CHOICES, REACH_CHOICES,
} from "../src/app/safe-choices";
import { planEditorHeading } from "../src/flows/plan";
import { askBuildRequest, newProjectInEmptyFolder, offerMissingFolder, type NewProjectFlow } from "../src/app/new-project";
import { labAskFor, labFailureAsk } from "../src/network/checks";
import { newProjectQuestion } from "../src/new/pick";
import { IGNORE_CHOICES, IGNORE_FILE_CHOICES } from "../src/security/format";
import { INSTALL_CHOICES, OSV_UPDATE_QUESTION } from "../src/security/install";

/**
 * Enter picks choice 1 on both terminals, so choice 1 of every Casper question is the one that does nothing risky.
 * A choice that builds, installs, downloads, spends tokens, runs again, remembers, approves or reaches a lab must
 * never come back to slot 1.
 */
const DOING = /^(?:build|yes|retry|fix|install|download|remember|enable|run|always|keep it|use my|ask the model|allow more)/i;

const firsts: Array<[string, string, string]> = [
  ["Build this plan?", PLAN_CHOICES[0].label, "Stop"],
  ["Build this plan? (rich terminal, after the plan editor)", PLAN_CHOICES[0].label, "Stop"],
  ["Fix it anyway?", ALREADY_FAILING_CHOICES[0].label, "Leave it"],
  ["The model failed again", modelFailedChoices()[0]!.label, "Stop"],
  ["The model failed again (big model set)", modelFailedChoices("fixture/big")[0]!.label, "Stop"],
  ["timed out", unfinishedChoices(600_000, 2_400_000)[0]!.label, "Stop"],
  ["could not start", unfinishedChoices(0, 60_000)[0]!.label, "Stop"],
  ["repair limit", REPAIR_LIMIT_STOP.label, "Stop here"],
  ["Use it as your big model?", REMEMBER_BIG_MODEL_CHOICES[0].label, "No"],
  ["Remember this server?", MCP_REMEMBER_CHOICES[0], "Just this time"],
  ["/mcp writes", MCP_WRITES_CHOICES[0], "Keep writes off"],
  ["security tools install", INSTALL_CHOICES[0], "Stop"],
  ["advisory download", OSV_UPDATE_QUESTION.choices[0]!, "Stop"],
  ["new ignore", IGNORE_CHOICES[0], "Leave it flagged"],
  ["changed ignore file", IGNORE_FILE_CHOICES[0], "Keep the default"],
  ["build request", newProjectQuestion({ template: "mist-python", name: "mist-aps", kind: "Mist Python project" }, "~/Projects").choices[0]!, "Use this folder"],
  ["lab check (ansible)", labAskFor("aoscx-check", "ansible-check", [{ name: "sw1", address: "10.0.0.1" }]).choices[0]!, "Skip"],
  ["lab check (junos commit)", labAskFor("junos-commit", "junos-commit", [{ name: "r1", address: "10.0.0.2" }]).choices[0]!, "Skip"],
  ["lab failure", labFailureAsk("junos-commit").choices[0]!, "Stop"],
  ["undo with a file changed since", undoChangedChoices("Undo", 2)[0]!.label, "Cancel"],
  ["redo with a file changed since", undoChangedChoices("Redo", 1)[0]!.label, "Cancel"],
  ["a shell command wants to reach a host", HOST_CHOICES[0].label, "No"],
  ["run this command? (no sandbox)", SHELL_COMMAND_CHOICES[0].label, "No"],
  ["reach another machine (ssh, scp, nc ...)", REACH_CHOICES[0].label, "No"],
  ["the AI security review", AI_REVIEW_CHOICES[0].label, "Stop here"],
  ["a typed folder that isn't there", missingFolderChoices("Documents", "mist-tools")[0]!.label, "Stay in Documents"],
  ["the work is in a project inside this folder", workFolderChoices("Documents", "mist-tools")[0]!.label, "Stay here"],
  ["this task has used $5.02", spendChoices("$10")[0]!.label, "Stop here"],
];

test.each(firsts)("choice 1 at %s is the safe one", (_question, first, expected) => {
  expect(first).toBe(expected);
  expect(first).not.toMatch(DOING);
});

test("the risky choices still exist, as a deliberate 2 or later", () => {
  expect(PLAN_CHOICES.map((choice) => choice.label)).toEqual(["Stop", "Build"]);
  expect(ALREADY_FAILING_CHOICES.map((choice) => choice.label)).toEqual(["Leave it", "Fix it anyway"]);
  expect(spendChoices("$10").map((choice) => choice.label)).toEqual(["Stop here", "Keep going"]);
  expect(modelFailedChoices("fixture/big").map((choice) => choice.label)).toEqual(["Stop", "Retry", "Retry with your big model"]);
  expect(unfinishedChoices(600_000, 2_400_000).map((choice) => choice.label)).toEqual(["Stop", "Retry", "Fix it anyway", "Allow more time"]);
  expect(unfinishedChoices(600_000, 2_400_000)[0]!.choice).toBeUndefined();
  expect([...MCP_REMEMBER_CHOICES]).toEqual(["Just this time", "Remember"]);
  expect([...MCP_WRITES_CHOICES]).toEqual(["Keep writes off", "Enable for this server"]);
  expect([...INSTALL_CHOICES]).toEqual(["Stop", "Run what's installed", "Install them"]);
  expect(OSV_UPDATE_QUESTION.choices).toEqual(["Stop", "Download it"]);
  expect(undoChangedChoices("Undo", 2).map((choice) => choice.label)).toEqual(["Cancel", "Undo the other 2 files"]);
  expect(AI_REVIEW_CHOICES.map((choice) => choice.label)).toEqual(["Stop here", "Run the AI review"]);
  expect(REACH_CHOICES.map((choice) => choice.label)).toEqual(["No", "Yes, this time", "Yes, for this session"]);
  expect(missingFolderChoices("Documents", "mist-tools").map((choice) => choice.label)).toEqual(["Stay in Documents", "Make mist-tools here"]);
  expect(workFolderChoices("Documents", "mist-tools").map((choice) => choice.label)).toEqual(["Stay here", "Switch there"]);
});

test("Enter in the rich terminal's plan editor goes on to Build this plan?, never straight to a build", () => {
  const { hint } = planEditorHeading({ steps: ["Add a Limiter class"], tests: ["limit(0) throws"] });
  expect(hint).toStartWith("Enter goes on to 1 Stop · 2 Build");
  expect(hint).not.toMatch(/Enter builds/i);
  expect(PLAN_QUESTION).toBe("Build this plan?");
  // tests/plan-first.test.ts drives the rich terminal: Enter in the editor, then Enter again, builds nothing.
});

/** A flow whose person presses Enter at every question (Enter picks choice 1), and a create that must not run. */
function enterFlow(home: string) {
  const asked: Array<{ question: string; labels: string[] }> = [];
  let created = 0;
  const flow: NewProjectFlow = {
    homeDir: home,
    write: () => {},
    pick: async (question, options) => { asked.push({ question, labels: options.map((option) => option.label) }); return options[0]?.label; },
    create: async () => { created++; throw new Error("Enter must never build a project"); },
  };
  return { flow, asked, created: () => created };
}

test("Enter at the empty-folder question builds nothing: Not now is choice 1", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-safe-empty-"));
  try {
    const { flow, asked, created } = enterFlow(home);
    expect(await newProjectInEmptyFolder(flow, path.join(home, "demo"))).toBeUndefined();
    expect(asked[0]!.labels[0]).toBe("Not now");
    expect(created()).toBe(0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Enter at the build-request question, and at its Other kind list, keeps the folder", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-safe-build-"));
  try {
    const enter = enterFlow(home);
    expect(await askBuildRequest(enter.flow, "build a tool that lists Mist APs per site")).toEqual({ keep: true });
    expect(enter.asked[0]!.labels[0]).toBe("Use this folder");
    expect(enter.created()).toBe(0);

    // "Other kind" is a deliberate 3; Enter at the kinds that follow still builds nothing.
    const other = enterFlow(home);
    let first = true;
    const pick = other.flow.pick;
    other.flow.pick = async (question, options, signal) => {
      if (first) { first = false; other.asked.push({ question, labels: options.map((option) => option.label) }); return "Other kind"; }
      return pick(question, options, signal);
    };
    expect(await askBuildRequest(other.flow, "build a tool that lists Mist APs per site")).toEqual({ keep: true });
    expect(other.asked[1]!.question).toBe("What are you building?");
    expect(other.asked[1]!.labels[0]).toBe("Use this folder");
    expect(other.created()).toBe(0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Enter at \"mist-tools isn't a folder in Documents\" makes nothing: Stay is choice 1", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-safe-missing-"));
  try {
    const { flow, asked, created } = enterFlow(home);
    expect(await offerMissingFolder(flow, "mist-tools", home, "Documents")).toBeUndefined();
    expect(asked[0]!.question).toBe("mist-tools isn't a folder in Documents. Make it?");
    expect(asked[0]!.labels).toEqual(["Stay in Documents", "Make mist-tools here"]);
    expect(created()).toBe(0);
  } finally { await rm(home, { recursive: true, force: true }); }
});
