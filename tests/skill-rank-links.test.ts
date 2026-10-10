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
