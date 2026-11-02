import { expect, test } from "bun:test";
import { scoreSkill } from "../src/skills/rank";
import { classifyTask } from "../src/task/classify";

/** A word inside a link is not what the request is about: "casper-network-mcp" in a GitHub link picked a skill tagged mcp. */
const lab = { name: "simrack", description: "SimRack runbook for vJunos sandboxes on Proxmox.", tags: ["simrack", "proxmox", "vjunos", "mcp"],
  stacks: [], intents: [], extra: {} } as never;
const project = { languages: [], frameworks: [] } as never;
const score = (request: string) => scoreSkill(lab, request, project, classifyTask(request));

test("words only inside a link don't pick a skill; the same words written out still do", () => {
  expect(score("https://github.com/example/casper-network-mcp needs its next version update")).toBe(0);
  expect(score("github.com/example/casper-network-mcp needs its next version update")).toBe(0);
  expect(score("the mcp server needs its next version update")).toBeGreaterThan(0);
  expect(score("rebuild the simrack lab, see https://github.com/example/notes")).toBeGreaterThan(0);
  // A path in the project is not a link.
  expect(score("fix tests/proxmox-api.test.ts")).toBeGreaterThan(0);
});

test("a long request shares many words with any long description by chance; that alone doesn't pick a skill", () => {
  // A real 5,000-character build spec picked xlsx, docx, docs and google-workspace (41k characters of skill text in every
  // turn) on words such as "file", "read", "edit", "data" and "word". A short request that names the topic still does.
  const sheets = { name: "xlsx", description: "Use for any spreadsheet file: open, read, edit, create or fix data in a workbook, even from a script or an API, with a word on formulas.",
    tags: [], stacks: [], intents: [], extra: {} } as never;
  const spec = Array.from({ length: 60 }, (_, i) => `Section ${i}: the server reads file data${i}, people edit field${i} in a form, a script calls api${i} and writes word${i} cards.`).join("\n");
  expect(scoreSkill(sheets, spec, project, classifyTask(spec))).toBe(0);
  expect(scoreSkill(sheets, "fix the formulas in my budget spreadsheet", project, classifyTask("fix the formulas in my budget spreadsheet"))).toBeGreaterThan(0);
  // A long request that names the skill still picks it.
  expect(score(`${spec}\nThen rebuild the simrack lab.`)).toBeGreaterThan(0);
});
