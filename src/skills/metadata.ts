import { open } from "node:fs/promises";
import { parse } from "yaml";

export const MAX_SKILL_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

export interface SkillMetadata {
  name: string;
  description: string;
  tags: string[];
  stacks: string[];
  intents: string[];
  disableModelInvocation: boolean;
  extra: Record<string, unknown>;
}

export function splitSkill(source: string): { header: string; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match || Buffer.byteLength(match[0]) > MAX_HEADER_BYTES) {
    throw new Error("expected YAML frontmatter within the first 16 KiB");
  }
  return { header: match[1], body: source.slice(match[0].length).trim() };
}

export async function readSkillHeader(filePath: string, standalone: true): Promise<string | undefined>;
export async function readSkillHeader(filePath: string, standalone?: false): Promise<string>;
export async function readSkillHeader(filePath: string, standalone = false): Promise<string | undefined> {
  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("skill must be a regular file");
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const source = buffer.subarray(0, bytesRead).toString("utf8");
    // Standalone skills declare name or description in frontmatter. Ordinary
    // docs (including title-only frontmatter) are not rejected skill candidates.
    // Detect intent before YAML parsing so malformed declared skills still warn.
    const opening = /^\uFEFF?---\r?\n/.exec(source);
    const frontmatter = opening ? source.slice(opening[0].length).split(/\r?\n---(?:\r?\n|$)/, 1)[0]! : "";
    if (standalone) {
      let declared = /(?:^|[\n{,])\s*["']?(?:name|description)["']?\s*:/m.test(frontmatter);
      try {
        const value: unknown = parse(frontmatter);
        declared ||= Boolean(value && typeof value === "object" && ("name" in value || "description" in value));
      } catch { /* malformed declared skills are still validated below */ }
      if (!declared) return undefined;
    }
    if (info.size > MAX_SKILL_BYTES) throw new Error("skill must be a regular file no larger than 256 KiB");
    // Only frontmatter is retained in the index, never the instruction body.
    return splitSkill(source).header;
  } finally {
    await file.close();
  }
}

export function parseSkillMetadata(header: string): SkillMetadata {
  const value: unknown = parse(header);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("frontmatter must be a mapping");
  }
  const fields = value as Record<string, unknown>;
  const { name, description, tags, stacks, intents, ...extra } = fields;
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("name must be 1–64 lowercase letters, numbers, or single hyphens");
  }
  if (typeof description !== "string" || !description.trim() || description.length > 1024) {
    throw new Error("description must contain 1–1024 characters");
  }
  const strings = (field: unknown, label: string): string[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) {
      throw new Error(`${label} must be a list of strings`);
    }
    return field.map((item) => item.trim()).filter(Boolean);
  };
  return {
    name,
    description: description.trim(),
    tags: strings(tags, "tags"),
    stacks: strings(stacks, "stacks"),
    intents: strings(intents, "intents"),
    disableModelInvocation: fields["disable-model-invocation"] === true,
    extra,
  };
}
