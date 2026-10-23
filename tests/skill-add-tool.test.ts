import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { holdsSecret } from "../src/secrets/refuse";
import { SKILL_ADD_TOOL, skillAddTool, skillNamed, type SkillAddHost } from "../src/skills/add-tool";
import { parseSkillMetadata, splitSkill } from "../src/skills/metadata";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** casper_skill_add: the AI adds a skill only after the person has seen its whole text and said yes. Placeholder skills only. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const SKILL = { name: "lab-naming", description: "Naming rules for lab sites and switches.", tags: ["naming", "lab"],
  text: "Site names are <city>-<building>.\nSwitch names are <site>-sw<nn>, numbered from 01." };
const FILE = "---\nname: lab-naming\ndescription: Naming rules for lab sites and switches.\ntags:\n  - naming\n  - lab\n---\n"
  + "Site names are <city>-<building>.\nSwitch names are <site>-sw<nn>, numbered from 01.\n";

interface FakeHost extends SkillAddHost { told: string; shown: string[]; asked: Array<{ preview: string; question: string }>; reloads: number }

/** The tool's host under a fresh home: `answer` is the person's yes (true) or no; reload indexes skills as a session does. */
async function toolHost(options: { canAsk?: boolean; answer?: boolean } = {}): Promise<FakeHost> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-skill-tool-"));
  cleanup.push(() => removeTempDir(root));
  const homeDir = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(homeDir, ".casper"), { recursive: true }); await mkdir(project);
  let registry = await SkillRegistry.discover({ projectRoot: project, homeDir });
  const host: FakeHost = {
    homeDir, told: "", shown: [], asked: [], reloads: 0,
    canAsk: () => options.canAsk ?? true,
    taken: () => registry.list().map((skill) => skill.name),
    holdsSecret: (text) => holdsSecret(text, { env: {}, values: [] }),
    show: (rows) => { host.shown.push(...rows(70)); },
    confirm: async (preview, question) => { host.asked.push({ preview, question }); return options.answer ?? false; },
    tell: (text) => { host.told += text; },
    reload: async () => { host.reloads++; registry = await SkillRegistry.discover({ projectRoot: project, homeDir }); },
    loaded: (name) => registry.list().some((skill) => skill.name === name && skill.source === "user"),
  };
  return host;
}
const folder = (home: string, name = "lab-naming") => stat(path.join(home, ".casper/skills", name)).then(() => true, () => false);

test("the whole skill is shown behind a bar and the box says what a yes does before anything is written; No writes nothing", async () => {
  const host = await toolHost({ answer: false });
  const result = await skillAddTool(host).execute(SKILL);
  expect(host.shown).toEqual([
    "--- the skill lab-naming: ~/.casper/skills/lab-naming/SKILL.md ---",
    ...FILE.trimEnd().split("\n").map((line) => `  │ ${line}`),
    "--- end of the skill lab-naming ---",
  ]);
  expect(host.asked).toEqual([{
    preview: "The AI wants to add a skill (its whole text is above):\n"
      + "  name         lab-naming\n"
      + "  description  Naming rules for lab sites and switches.\n"
      + "  tags         naming, lab\n"
      + "It goes in ~/.casper/skills/lab-naming/SKILL.md. From then on the AI reads it whenever a request fits it, in every project, "
      + "until you delete that folder.\n",
    question: "Add the skill lab-naming?",
  }]);
  expect(result).toEqual({ text: "Not added: the user said no. Nothing was written.", isError: true });
  expect(await folder(host.homeDir)).toBe(false);
  expect(host.reloads).toBe(0);
});

test("a yes writes the file exactly as shown and indexes skills again, so the next request that fits can use it", async () => {
  const host = await toolHost({ answer: true });
  const result = await skillAddTool(host).execute({ ...SKILL, source: "https://github.com/example/skills/tree/1a2b3c4d/lab-naming" });
  expect(host.asked[0]!.preview).toContain("\n  from         https://github.com/example/skills/tree/1a2b3c4d/lab-naming\n");
  const written = await readFile(path.join(host.homeDir, ".casper/skills/lab-naming/SKILL.md"), "utf8");
  expect(written).toBe(FILE);
  expect(host.shown.slice(1, -1).map((row) => row.slice(4)).join("\n")).toBe(FILE.trimEnd());
  expect(parseSkillMetadata(splitSkill(written).header)).toMatchObject({ name: "lab-naming", description: SKILL.description, tags: ["naming", "lab"] });
  expect(host.reloads).toBe(1);
  expect(host.loaded("lab-naming")).toBe(true);
  expect(result).toEqual({ text: "Added the skill lab-naming (~/.casper/skills/lab-naming/SKILL.md). It is used from the next request it fits." });
  expect(host.told).toBe("[skills] Added lab-naming: ~/.casper/skills/lab-naming/SKILL.md\n");
});

test("a run that can't ask writes nothing and tells the person", async () => {
  const host = await toolHost({ canAsk: false, answer: true });
  const result = await skillAddTool(host).execute(SKILL);
  expect(result).toEqual({ text: "Not added: this run can't ask the user. Tell them to ask for it again in a Casper session.", isError: true });
  expect(host.told).toBe("[skills] The AI wanted to add the skill lab-naming, and this run can't ask you, so nothing was added. Ask for it again in a Casper session.\n");
  expect(host.asked).toEqual([]);
  expect(host.shown).toEqual([]);
  expect(await folder(host.homeDir)).toBe(false);
});

test("refused before any box: a bad name, a name a skill has, a folder already there, a header, a key, too much text", async () => {
  const host = await toolHost({ answer: true });
  await mkdir(path.join(host.homeDir, ".casper/skills/taken-folder"), { recursive: true });
  const tool = skillAddTool(host);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...SKILL, name: "Lab Naming" }, "Not added: name must be lowercase letters, numbers and single hyphens, at most 64."],
    [{ ...SKILL, name: "network-mist-api" }, "Not added: network-mist-api is already a skill. Pick another name."],
    [{ ...SKILL, name: "taken-folder" }, "Not added: ~/.casper/skills/taken-folder is already there. Pick another name."],
    [{ ...SKILL, description: "  " }, "Not added: description must be one line of 1–1024 characters saying when the skill applies."],
    [{ ...SKILL, tags: "naming" }, "Not added: tags must be a list of up to 12 short words."],
    [{ ...SKILL, text: "---\nname: lab-naming\n---\nSite names" }, "Not added: give the text without its --- header; name, description and tags have their own fields."],
    [{ ...SKILL, text: "Use the token ghp_Zq8vLr2mXw4TnB7pKs9dZq8vLr2mXw4TnB7p for the API." }, "Not added: the skill holds what looks like a key or token. A skill is instructions, never keys."],
    [{ ...SKILL, text: "Rule.\n".repeat(1500) }, "Not added: the text is over 8 KB, more than a person reads in a box. Keep it short, or make it a pack (/pack add)."],
    [{ ...SKILL, text: 7 }, "Not added: text must be a string."],
  ];
  for (const [args, error] of cases) expect({ name: args.name, result: await tool.execute(args) }).toEqual({ name: args.name, result: { text: error, isError: true } });
  expect(host.asked).toEqual([]);
  expect(host.shown).toEqual([]);
  expect(await folder(host.homeDir)).toBe(false);
});

test("what is shown has no terminal escapes or hidden characters, and what is written is what was shown", async () => {
  const host = await toolHost({ answer: true });
  await skillAddTool(host).execute({ ...SKILL, description: "Naming\u202e rules \x1b[31mfor lab sites.", text: "Clear the screen \x1b[2J now.\u200b\nNext line." });
  expect(host.shown.join("\n")).not.toMatch(/[\x1b\u202e\u200b]/);
  const written = await readFile(path.join(host.homeDir, ".casper/skills/lab-naming/SKILL.md"), "utf8");
  expect(written).not.toMatch(/[\x1b\u202e\u200b]/);
  expect(host.shown.slice(1, -1).map((row) => row.slice(4)).join("\n")).toBe(written.trimEnd());
  expect(written).toContain("description: Naming rules for lab sites.\n");
});

test("the tool is offered for a request that names a skill, by its own name", () => {
  expect(SKILL_ADD_TOOL).toBe("casper_skill_add");
  for (const request of ["add a new skill for our lab naming rules", "save this as a skill", "install the skill at github.com/example/skills", "make skills for it"]) {
    expect({ request, named: skillNamed(request) }).toEqual({ request, named: true });
  }
  for (const request of ["fix the login bug", "a skillful fix", "reskill the team page"]) expect({ request, named: skillNamed(request) }).toEqual({ request, named: false });
});

test("the docs say how to ask for a skill in chat and what the box shows; decision 35 records the guard rails", async () => {
  const skills = (await readFile(new URL("../docs/SKILLS.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
  expect(skills).toContain("Or ask in chat (\"add a skill: our lab sites are named <city>-<building>\")");
  expect(skills).toContain("Casper prints the whole file, every line behind a `│`, then asks `Add the skill <name>?` (`1 No · 2 Yes, add it`)");
  const decision = await readFile(new URL("../docs/adr/0002/35-the-ai-adds-skills.md", import.meta.url), "utf8");
  expect(decision).toStartWith("# 35. The AI can add a skill, after a yes nothing else gives");
  expect(decision).toContain("Nothing answers the box for you");
});
