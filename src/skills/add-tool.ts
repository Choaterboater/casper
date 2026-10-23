/**
 * casper_skill_add: the AI adds a skill for the person ("add a skill: our lab sites are named <city>-<building>", or one
 * the person points it to). Casper writes the SKILL.md itself from the name, description, tags and text, prints the
 * whole file behind a bar and asks in a yes/no box; nothing is written before the person's yes. The box is never
 * answered for them: not by "Yes to everything", /permissions all or anything remembered, because a skill is
 * instructions the AI reads in every project from then on (docs/adr/0002/35-the-ai-adds-skills.md). A run that can't
 * ask writes nothing. A yes writes ~/.casper/skills/<name>/SKILL.md, never over anything there, and indexes skills
 * again, so the next request that fits it can use it.
 */

import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { shownLine, shownText } from "../packs/files";
import type { RuntimeTool } from "../runtime/types";
import { allBundledSkills } from "./bundled";
import { SKILL_NAME } from "./metadata";

export const SKILL_ADD_TOOL = "casper_skill_add";
/** The box's yes: only a person's key picks it. */
export const SKILL_ADD_YES = "Yes, add it";
/** More text than a person reads in a box before saying yes: a bigger set of skills is a pack (/pack add). */
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_TAGS = 12;
/** In front of every row of the skill's text, so nothing in it can pass for Casper's own lines around it. */
const BAR = "  │ ";

/** A request that names a skill is offered the tool ("add a skill", "save this as a skill"). */
export function skillNamed(text: string): boolean {
  return /\bskills?\b/i.test(text);
}

export interface SkillAddHost {
  homeDir: string;
  /** A person can answer a box now (an interactive session that isn't closing). */
  canAsk(): boolean;
  /** Every skill name Casper indexed: bundled, yours, the project's and the packs'. */
  taken(): readonly string[];
  /** Looks like a key, a token or one of Casper's own secrets. */
  holdsSecret(text: string): boolean;
  /** Prints rows for the person before the box, laid out again whenever the width changes. */
  show(rows: (width: number) => string[]): void;
  /** The yes/no box: true only for SKILL_ADD_YES picked by the person. Nothing answers it for them. */
  confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean>;
  /** A line for the person (not the AI). */
  tell(text: string): void;
  /** Index skills again. */
  reload(): Promise<void>;
  /** The skill is indexed as the person's own. */
  loaded(name: string): boolean;
}

interface SkillAdd { name: string; description: string; tags: string[]; text: string; source?: string }

const DESCRIPTION = "Add a skill for the user: instructions the AI reads whenever a later request fits them, in every project. Use it "
  + "when they ask to add, save or make a skill, or to install one they point you to (read it first with casper_read_untrusted "
  + "or web_fetch, then pass its name, description and text). Casper shows them the whole text and asks; nothing is written "
  + "before their yes. Don't write ~/.casper/skills yourself. Never put keys or tokens in a skill.";

/** The tool's arguments as a skill, with what can't be shown taken out, or why they can't be one. */
function toolAdd(args: Record<string, unknown>): SkillAdd | { error: string } {
  const { name, description, text, tags = [], source } = args;
  if (typeof name !== "string" || !SKILL_NAME.test(name) || name.length > 64) return { error: "name must be lowercase letters, numbers and single hyphens, at most 64" };
  const line = typeof description === "string" ? shownLine(description) : "";
  if (!line || line.length > 1024) return { error: "description must be one line of 1–1024 characters saying when the skill applies" };
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || tags.some((tag) => typeof tag !== "string" || !shownLine(tag) || shownLine(tag).length > 40)) {
    return { error: "tags must be a list of up to 12 short words" };
  }
  if (typeof text !== "string") return { error: "text must be a string" };
  const body = shownText(text).replace(/\r\n?/g, "\n").split("\n").map((row) => row.trimEnd()).join("\n").trim();
  if (!body) return { error: "text must hold the skill's instructions" };
  if (/^---[ \t]*\n/.test(body)) return { error: "give the text without its --- header; name, description and tags have their own fields" };
  if (Buffer.byteLength(body) > MAX_TEXT_BYTES) return { error: "the text is over 8 KB, more than a person reads in a box. Keep it short, or make it a pack (/pack add)" };
  const from = typeof source === "string" ? shownLine(source) : "";
  if (source !== undefined && (!from || from.length > 300)) return { error: "source must be one line saying where the skill came from" };
  return { name, description: line, tags: (tags as string[]).map(shownLine), text: body, ...(from ? { source: from } : {}) };
}

/** The SKILL.md, header written by Casper, so it always reads back as the skill shown. */
function skillFile(add: SkillAdd): string {
  const header = stringify({ name: add.name, description: add.description, ...(add.tags.length ? { tags: add.tags } : {}) }, { lineWidth: 0 });
  return `---\n${header.trimEnd()}\n---\n${add.text}\n`;
}

/** The whole file, every row behind the bar, wrapped by Casper at the screen's width so a long line keeps its bar. */
function fileRows(add: SkillAdd, file: string, shown: string): (width: number) => string[] {
  const head = `--- the skill ${add.name}: ${shown} ---`;
  const end = `--- end of the skill ${add.name} ---`;
  const lines = file.trimEnd().split("\n");
  return (width) => {
    const wrap = (text: string, columns: number) => text ? wrapTextWithAnsi(text, Math.max(1, columns)) : [""];
    return [...wrap(head, width), ...lines.flatMap((line) => wrap(line, width - BAR.length).map((row) => `${BAR}${row}`.trimEnd())), ...wrap(end, width)]
      .map((row) => truncateToWidth(row, Math.max(1, width), ""));
  };
}

/** The box above the question: what is added, from where, and what a yes means. */
function boxPreview(add: SkillAdd, shown: string): string {
  return [
    "The AI wants to add a skill (its whole text is above):",
    `  name         ${add.name}`,
    `  description  ${add.description}`,
    ...add.tags.length ? [`  tags         ${add.tags.join(", ")}`] : [],
    ...add.source ? [`  from         ${add.source}`] : [],
    `It goes in ${shown}. From then on the AI reads it whenever a request fits it, in every project, until you delete that folder.`,
    "",
  ].join("\n");
}

const there = (target: string) => stat(target).then(() => true, () => false);

export function skillAddTool(host: SkillAddHost): RuntimeTool {
  return {
    name: SKILL_ADD_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["name", "description", "text"],
      properties: {
        name: { type: "string", description: "lowercase-words-with-hyphens" },
        description: { type: "string", description: "One line: what it is for and when it applies (this picks it)" },
        text: { type: "string", description: "The instructions, in Markdown, without a --- header" },
        tags: { type: "array", items: { type: "string" }, description: "A few specific words that pick it" },
        source: { type: "string", description: "Where it came from, if the user pointed you to one: its address, at a commit" },
      },
    },
    // One box at a time, and never two adds racing for the same folder.
    sequential: true,
    async execute(args, signal) {
      const add = toolAdd(args);
      if ("error" in add) return { text: `Not added: ${add.error}.`, isError: true };
      // A built-in name stays Casper's, whatever the index holds now.
      if ([...host.taken(), ...allBundledSkills().map((skill) => skill.metadata.name)].includes(add.name)) {
        return { text: `Not added: ${add.name} is already a skill. Pick another name.`, isError: true };
      }
      const skills = path.join(host.homeDir, ".casper", "skills");
      const folder = path.join(skills, add.name);
      if (await there(folder)) return { text: `Not added: ~/.casper/skills/${add.name} is already there. Pick another name.`, isError: true };
      const file = skillFile(add);
      if (host.holdsSecret(file)) return { text: "Not added: the skill holds what looks like a key or token. A skill is instructions, never keys.", isError: true };
      if (!host.canAsk()) {
        host.tell(`[skills] The AI wanted to add the skill ${add.name}, and this run can't ask you, so nothing was added. Ask for it again in a Casper session.\n`);
        return { text: "Not added: this run can't ask the user. Tell them to ask for it again in a Casper session.", isError: true };
      }
      const shown = `~/.casper/skills/${add.name}/SKILL.md`;
      host.show(fileRows(add, file, shown));
      if (!await host.confirm(boxPreview(add, shown), `Add the skill ${add.name}?`, signal)) {
        return { text: "Not added: the user said no. Nothing was written.", isError: true };
      }
      try {
        await mkdir(skills, { recursive: true });
        // Not recursive, and the file only if it is new: something that appeared while the box was open is left alone.
        await mkdir(folder);
        await writeFile(path.join(folder, "SKILL.md"), file, { flag: "wx" });
      } catch (error) {
        return { text: `Not added: ${error instanceof Error && "code" in error && error.code === "EEXIST" ? `~/.casper/skills/${add.name} appeared while you were asked` : "the file couldn't be written"}. Nothing was changed.`, isError: true };
      }
      await host.reload();
      host.tell(`[skills] Added ${add.name}: ${shown}\n`);
      if (!host.loaded(add.name)) return { text: `Added ${shown}, but Casper didn't take it as a skill; /skills diagnostics says why.`, isError: true };
      return { text: `Added the skill ${add.name} (${shown}). It is used from the next request it fits.` };
    },
  };
}
