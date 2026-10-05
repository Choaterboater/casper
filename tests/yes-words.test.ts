import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  APPROVE_CHOICES, APPROVE_ONCE_CHOICES, APPROVE_ONCE_PREVIEW_CHOICES, APPROVE_PREVIEW_CHOICES, HOST_CHOICES, kindAllowChoices, NO, REACH_CHOICES,
  SHELL_COMMAND_CHOICES, writeChoices, YES_ALWAYS, YES_ONCE, YES_SESSION, YES_WORDS,
} from "../src/app/safe-choices";
import { labAskFor } from "../src/network/checks";

/**
 * One set of yes-words in every approval box: 1 No · 2 Yes, this once · 3 Yes, for this session · 4 Yes, always for
 * this project. A box offers only the ones that make sense, but the ones it offers come first, in that order, so a
 * number means the same thing wherever it appears. What the yes is about goes in the question, never in the answer.
 */

test("the yes-words are these four, in this order", () => {
  expect([...YES_WORDS]).toEqual(["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"]);
  expect([NO, YES_ONCE, YES_SESSION, YES_ALWAYS]).toEqual([...YES_WORDS]);
});

const labels = (choices: ReadonlyArray<string | { label: string }>) => choices.map((choice) => typeof choice === "string" ? choice : choice.label);
const boxes: Array<[string, string[]]> = [
  ["MCP change", labels(APPROVE_CHOICES)],
  ["MCP change with a preview", labels(APPROVE_PREVIEW_CHOICES)],
  ["MCP destructive change", labels(APPROVE_ONCE_CHOICES)],
  ["MCP destructive change with a preview", labels(APPROVE_ONCE_PREVIEW_CHOICES)],
  ["MCP risky change kind", kindAllowChoices("firmware")],
  ["a host the sandbox doesn't list", labels(HOST_CHOICES)],
  ["a write outside the project", labels(writeChoices("~/apps/x"))],
  ["reach another machine", labels(REACH_CHOICES)],
  ["a shell command with no sandbox", labels(SHELL_COMMAND_CHOICES)],
  ["a device check (junos-commit)", labAskFor("junos-commit", "junos-commit", [{ name: "r1", address: "10.0.0.2" }]).choices],
  ["a device check (ansible)", labAskFor("aoscx-check", "ansible-check", [{ name: "sw1", address: "10.0.0.1" }]).choices],
];

test.each(boxes)("%s: the yes-words it offers come first, in order, with the same numbers everywhere", (_box, choices) => {
  expect(choices[0]).toBe(NO);
  const offered = choices.filter((label) => (YES_WORDS as readonly string[]).includes(label));
  expect(choices.slice(0, offered.length)).toEqual(offered);
  expect(offered).toEqual(YES_WORDS.filter((word) => offered.includes(word)));
  // A yes always reads as one of the four (the MCP box's own "Yes to everything on <product>" and the Junos box's
  // "Yes, show commands on <server> for this session" aside).
  for (const label of choices) if (/^yes\b/i.test(label) && !/^Yes(?: to everything|, show commands on)/.test(label)) expect(YES_WORDS as readonly string[]).toContain(label);
  // 2 is "Yes, this once" and 3 "Yes, for this session" wherever a box offers them.
  for (const word of [YES_ONCE, YES_SESSION]) if (offered.includes(word)) expect(choices.indexOf(word)).toBe((YES_WORDS as readonly string[]).indexOf(word));
});

/** Every source file (TypeScript and Markdown skills), the network server batch aside. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return full.endsWith(path.join("mcp", "network")) ? [] : sources(full);
    return /\.(ts|md)$/.test(name) && !name.endsWith(".generated.ts") ? [full] : [];
  });
}

test("no box asks in other words: no typed yes, no 'this time', no 'Run it' or 'Remember' answers", () => {
  const stale = [/Type yes/, /Yes, this time/, /Just this time/, /"Run it"/, /"Allow for this session"/, /label: "Always for this project"/, /"Always for this project"/];
  const found: string[] = [];
  for (const file of sources(path.join(import.meta.dir, "../src"))) {
    const text = readFileSync(file, "utf8");
    for (const pattern of stale) if (pattern.test(text)) found.push(`${path.relative(path.join(import.meta.dir, ".."), file)}: ${pattern}`);
  }
  expect(found).toEqual([]);
});
