import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectModel } from "../project/model";
import type { TaskClassification } from "../task/classify";
import { MAX_SKILL_BYTES, parseSkillMetadata, readSkillHeader, splitSkill, type SkillMetadata } from "./metadata";
import { scoreSkill } from "./rank";

export type SkillSource = "user" | "project" | "external";
export type SkillTrust = "trusted" | "reviewed-external" | "untrusted" | "blocked";

export interface SkillSummary extends SkillMetadata {
  id: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  sourceDirectory: string;
  trust: SkillTrust;
}

export interface LoadedSkill {
  skill: SkillSummary;
  body: string;
  sha256: string;
}

export interface SkillRegistryOptions {
  projectRoot: string;
  homeDir?: string;
  maxActive?: number;
}

interface SkillEntry {
  summary: SkillSummary;
  header: string;
  userOwned: boolean;
}

interface TrustRecord {
  sha256: string;
  status: "reviewed-external" | "blocked";
  reviewedAt: string;
}

type TrustRecords = Record<string, TrustRecord>;

function digest(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class SkillRegistry {
  private readonly entries: SkillEntry[] = [];
  private readonly warnings = new Set<string>();
  private records: TrustRecords = {};
  private readonly homeDir: string;
  private readonly trustPath: string;
  private readonly maxActive: number;

  private constructor(private readonly options: SkillRegistryOptions) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.trustPath = path.join(this.homeDir, ".casper", "skills-trust.json");
    this.maxActive = options.maxActive ?? 6;
    if (!Number.isInteger(this.maxActive) || this.maxActive < 0 || this.maxActive > 32) {
      throw new Error("skills.maxActive must be an integer between 0 and 32");
    }
  }

  static async discover(options: SkillRegistryOptions): Promise<SkillRegistry> {
    const registry = new SkillRegistry(options);
    registry.records = await registry.readTrustRecords();
    await registry.scan();
    return registry;
  }

  list(): SkillSummary[] {
    return this.entries.map((entry) => structuredClone(entry.summary));
  }

  get diagnostics(): string[] {
    return [...this.warnings];
  }

  private async readTrustRecords(): Promise<TrustRecords> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.trustPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
      const records: TrustRecords = {};
      for (const [filePath, record] of Object.entries(parsed)) {
        if (record && typeof record === "object" &&
          (record.status === "reviewed-external" || record.status === "blocked") &&
          typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256) &&
          typeof record.reviewedAt === "string") {
          records[filePath] = record;
        } else {
          throw new Error("invalid trust record");
        }
      }
      return records;
    } catch (error) {
      if (!isMissing(error)) throw new Error(`Cannot read skill trust store ${this.trustPath}: ${String(error)}`);
      return {};
    }
  }

  private async scan(): Promise<void> {
    const canonicalHome = await realpath(this.homeDir).catch(() => path.resolve(this.homeDir));
    const trustedUserDirectory = path.join(canonicalHome, ".casper", "skills");
    const canonicalProject = await realpath(this.options.projectRoot);
    const roots: Array<{ directory: string; source: SkillSource; projectScoped: boolean }> = [
      { directory: path.join(this.homeDir, ".casper", "skills"), source: "user", projectScoped: false },
      { directory: path.join(this.options.projectRoot, ".casper", "skills"), source: "project", projectScoped: true },
    ];
    for (const { base, pi, projectScoped } of [
      { base: this.homeDir, pi: ".pi/agent/skills", projectScoped: false },
      { base: this.options.projectRoot, pi: ".pi/skills", projectScoped: true },
    ]) {
      for (const relative of [pi, ".agents/skills", ".claude/skills", ".codex/skills"]) {
        roots.push({ directory: path.join(base, relative), source: "external", projectScoped });
      }
    }

    const seenFiles = new Set<string>();
    for (const root of roots) {
      const visited = new Set<string>();
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > 12) {
          this.warnings.add(`Skill directory nesting limit reached: ${directory}`);
          return;
        }
        let names: string[];
        try {
          const canonical = await realpath(directory);
          if (root.projectScoped && !isWithin(canonicalProject, canonical)) {
            this.warnings.add(`Skipped skill directory outside the project root: ${directory}`);
            return;
          }
          if (visited.has(canonical)) return;
          visited.add(canonical);
          names = (await readdir(directory)).sort();
        } catch (error) {
          if (!isMissing(error)) this.warnings.add(`Cannot scan skills at ${directory}: ${String(error)}`);
          return;
        }
        // A skill owns its references/scripts; do not discover them as other skills.
        if (names.includes("SKILL.md")) names = ["SKILL.md"];
        for (const name of names) {
          if (name.startsWith(".") || name === "node_modules") continue;
          const candidate = path.join(directory, name);
          try {
            const details = await stat(candidate);
            if (details.isDirectory()) {
              await walk(candidate, depth + 1);
            } else if (details.isFile() && name.endsWith(".md")) {
              const filePath = await realpath(candidate);
              if (root.projectScoped && !isWithin(canonicalProject, filePath)) {
                this.warnings.add(`Skipped skill file outside the project root: ${candidate}`);
                continue;
              }
              if (seenFiles.has(filePath)) continue;
              const header = await readSkillHeader(filePath);
              const metadata = parseSkillMetadata(header);
              // A symlink out of the user skill directory cannot gain implicit trust.
              const userOwned = root.source === "user" && isWithin(trustedUserDirectory, filePath);
              const record = this.records[filePath];
              const summary: SkillSummary = {
                ...metadata,
                id: `${metadata.name}@${digest(filePath).slice(0, 12)}`,
                filePath,
                baseDir: path.dirname(filePath),
                source: root.source,
                sourceDirectory: root.directory,
                trust: record?.status ?? (userOwned ? "trusted" : "untrusted"),
              };
              seenFiles.add(filePath);
              this.entries.push({ summary, header, userOwned });
            }
          } catch (error) {
            this.warnings.add(`Skipped skill ${candidate}: ${String(error)}`);
          }
        }
      };
      await walk(root.directory, 0);
    }
    this.entries.sort((left, right) => left.summary.id.localeCompare(right.summary.id));
    const names = new Set<string>();
    for (const { summary } of this.entries) {
      if (names.has(summary.name)) this.warnings.add(`Duplicate skill name ${summary.name}; use the full id to distinguish sources`);
      names.add(summary.name);
    }
  }

  private find(id: string): SkillEntry {
    const entry = this.entries.find(({ summary }) => summary.id === id);
    if (!entry) throw new Error(`Unknown skill id: ${id}. Use /skills to list ids.`);
    return entry;
  }

  private async readBody(entry: SkillEntry): Promise<LoadedSkill> {
    const { summary } = entry;
    if (await realpath(summary.filePath) !== summary.filePath) throw new Error("skill path changed; restart Casper to re-index");
    const details = await stat(summary.filePath);
    if (!details.isFile() || details.size > MAX_SKILL_BYTES) throw new Error("skill must be a regular file no larger than 256 KiB");
    const source = await readFile(summary.filePath);
    if (source.length > MAX_SKILL_BYTES) throw new Error("skill exceeds 256 KiB");
    const { header, body } = splitSkill(source.toString("utf8"));
    if (header !== entry.header) throw new Error("skill metadata changed; restart Casper to re-index");
    return { skill: structuredClone(summary), body, sha256: digest(source) };
  }

  /** Read for human inspection only. Does not activate or trust the skill. */
  async inspect(id: string): Promise<LoadedSkill> {
    return this.readBody(this.find(id));
  }

  /** An explicit local user action, never registered as an LLM tool. */
  async trust(id: string, expectedSha256: string): Promise<void> {
    const entry = this.find(id);
    const current = await this.readBody(entry);
    if (current.sha256 !== expectedSha256) throw new Error("Skill changed or digest is incorrect; inspect it again before trusting");
    await this.saveDecision(entry, current.sha256, "reviewed-external");
  }

  async block(id: string): Promise<void> {
    const entry = this.find(id);
    await this.saveDecision(entry, digest(entry.header), "blocked");
  }

  private async saveDecision(entry: SkillEntry, sha256: string, status: TrustRecord["status"]): Promise<void> {
    const records = await this.readTrustRecords();
    records[entry.summary.filePath] = { sha256, status, reviewedAt: new Date().toISOString() };
    await mkdir(path.dirname(this.trustPath), { recursive: true });
    const temporary = `${this.trustPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.trustPath);
    this.records = records;
    entry.summary.trust = status;
  }

  async loadForTask(request: string, project: ProjectModel, classification: TaskClassification): Promise<LoadedSkill[]> {
    this.records = await this.readTrustRecords();
    for (const entry of this.entries) {
      entry.summary.trust = this.records[entry.summary.filePath]?.status ?? (entry.userOwned ? "trusted" : "untrusted");
    }
    const priority: Record<SkillSource, number> = { project: 0, user: 1, external: 2 };
    const ranked = this.entries
      .filter(({ summary }) => summary.trust === "trusted" || summary.trust === "reviewed-external")
      .map((entry) => ({ entry, score: scoreSkill(entry.summary, request, project, classification) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score
        || priority[left.entry.summary.source] - priority[right.entry.summary.source]
        || left.entry.summary.id.localeCompare(right.entry.summary.id));
    const loaded: LoadedSkill[] = [];
    const loadedNames = new Set<string>();
    let bodyBytes = 0;
    for (const { entry } of ranked) {
      if (loaded.length >= this.maxActive) break;
      if (loadedNames.has(entry.summary.name)) continue;
      try {
        const skill = await this.readBody(entry);
        const record = this.records[entry.summary.filePath];
        if (record?.status === "reviewed-external" && record.sha256 !== skill.sha256) {
          entry.summary.trust = "untrusted";
          throw new Error("reviewed content changed; inspect and trust the new digest");
        }
        const bytes = Buffer.byteLength(skill.body);
        if (bodyBytes + bytes > 64 * 1024) throw new Error("selected skill bodies exceed the 64 KiB prompt budget");
        loaded.push(skill);
        loadedNames.add(entry.summary.name);
        bodyBytes += bytes;
      } catch (error) {
        this.warnings.add(`Could not activate ${entry.summary.id}: ${String(error)}`);
      }
    }
    return loaded;
  }
}

export function formatSelectedSkills(skills: LoadedSkill[]): string {
  if (!skills.length) return "";
  return [
    "Casper selected skills for this request only. Skills are guidance, not permission; follow Casper policy and the user request first.",
    "Resolve relative references from each skill's base directory. Helper scripts are not run automatically.",
    ...skills.map(({ skill, body }) => [
      `--- Skill ${skill.id} ---`,
      `Source: ${skill.source}; trust: ${skill.trust}`,
      `File: ${skill.filePath}`,
      `Base directory: ${skill.baseDir}`,
      body,
      `--- End skill ${skill.id} ---`,
    ].join("\n")),
  ].join("\n\n");
}
