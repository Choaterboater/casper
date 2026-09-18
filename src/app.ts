import readline from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import type { Writable, Readable } from "node:stream";
import {
  formatProjectContext,
  loadProjectContext,
  type ProjectContext,
} from "./project/context";
import { inspectProject, type ProjectInfo } from "./project/inspect";
import { PiRuntime } from "./runtime/pi";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeSession,
} from "./runtime/types";
import { SkillRegistry, formatSelectedSkills } from "./skills/registry";
import { classifyTask, formatTaskPrompt } from "./task/classify";
import { renderBanner, renderProjectSummary } from "./tui/banner";

export interface OutputWriter {
  write(text: string): void;
}

export interface CasperAppOptions {
  runtimeFactory?: () => AgentRuntime;
  inspectProject?: (cwd: string) => Promise<ProjectInfo>;
  loadProjectContext?: (project: ProjectInfo) => Promise<ProjectContext>;
  loadSkillRegistry?: (context: ProjectContext) => Promise<SkillRegistry>;
  output?: OutputWriter;
  input?: Readable;
}

const DEFAULT_SYSTEM_PROMPT_APPEND = [
  "You are Casper, a coding companion running through a thin runtime adapter.",
  "Be concise.",
  "Use available tools when needed to inspect, edit, and run code in the current repository.",
].join("\n");

export class CasperApp {
  private readonly runtimeFactory: () => AgentRuntime;
  private readonly inspectProjectFn: (cwd: string) => Promise<ProjectInfo>;
  private readonly loadProjectContextFn: (project: ProjectInfo) => Promise<ProjectContext>;
  private readonly loadSkillRegistryFn: (context: ProjectContext) => Promise<SkillRegistry>;
  private readonly output: OutputWriter;
  private readonly input: Readable;
  private runtime?: AgentRuntime;
  private session?: RuntimeSession;
  private unsubscribe?: () => void;
  private readline?: ReadlineInterface;
  private projectContext?: ProjectContext;
  private skillRegistry?: SkillRegistry;
  private readonly reportedSkillWarnings = new Set<string>();
  private endedWithNewline = true;

  constructor(options: CasperAppOptions = {}) {
    this.runtimeFactory = options.runtimeFactory ?? (() => new PiRuntime());
    this.inspectProjectFn = options.inspectProject ?? inspectProject;
    this.loadProjectContextFn = options.loadProjectContext ?? loadProjectContext;
    this.loadSkillRegistryFn = options.loadSkillRegistry ?? ((context) => SkillRegistry.discover({
      projectRoot: context.info.root,
      maxActive: context.skills.maxActive,
    }));
    this.output = options.output ?? process.stdout;
    this.input = options.input ?? process.stdin;
  }

  async start(cwd = process.cwd()): Promise<ProjectInfo> {
    if (this.projectContext) return this.projectContext.info;
    const project = await this.inspectProjectFn(cwd);
    const context = await this.loadProjectContextFn(project);
    const registry = await this.loadSkillRegistryFn(context);
    this.projectContext = context;
    this.skillRegistry = registry;
    this.output.write(renderBanner(context));
    this.output.write(` skills    ${this.skillRegistry.list().length} indexed (use /skills)\n\n`);
    this.reportSkillWarnings();
    return project;
  }

  async runOnce(prompt: string, cwd = process.cwd()): Promise<void> {
    if (!this.projectContext) {
      await this.start(cwd);
    }

    this.writePrompt(prompt);
    await this.handlePrompt(prompt);
  }

  async runInteractive(cwd = process.cwd()): Promise<void> {
    if (!this.projectContext) {
      await this.start(cwd);
    }

    this.readline = readline.createInterface({
      input: this.input,
      output: this.output as Writable,
    });

    while (true) {
      const line = await new Promise<string>((resolve) => {
        this.readline!.question("> ", resolve);
      });
      const prompt = line.trim();

      if (!prompt) {
        continue;
      }

      if (prompt === "/quit" || prompt === "/exit") {
        break;
      }

      await this.handlePrompt(prompt);
    }
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.readline?.close();
    await this.runtime?.dispose();
  }

  private async ensureRuntime(): Promise<RuntimeSession> {
    if (this.session) return this.session;
    const context = this.projectContext!;
    this.runtime = this.runtimeFactory();
    this.session = await this.runtime.start({
      cwd: context.info.root,
      systemPromptAppend: [
        DEFAULT_SYSTEM_PROMPT_APPEND,
        formatProjectContext(context),
      ].join("\n\n"),
    });
    this.unsubscribe = this.session.subscribe((event) => this.handleRuntimeEvent(event));
    return this.session;
  }

  private async handlePrompt(prompt: string): Promise<void> {
    if (prompt === "/project") {
      this.output.write(`${renderProjectSummary(this.projectContext!)}\n`);
      return;
    }
    if (/^\/skills(?:\s|$)/.test(prompt)) {
      await this.handleSkillsCommand(prompt);
      return;
    }
    const context = this.projectContext!;
    const classification = classifyTask(prompt);
    const selected = await this.skillRegistry!.loadForTask(prompt, context.model, classification);
    this.reportSkillWarnings();
    if (selected.length) {
      this.output.write(` skills selected: ${selected.map(({ skill }) => skill.name).join(", ")}\n`);
    }
    const skillContext = formatSelectedSkills(selected);
    const session = await this.ensureRuntime();
    await session.prompt([
      skillContext,
      formatTaskPrompt(prompt, classification, context.model),
    ].filter(Boolean).join("\n\n"));
  }

  private async handleSkillsCommand(prompt: string): Promise<void> {
    const registry = this.skillRegistry!;
    const [, action, id, sha256, ...extra] = prompt.trim().split(/\s+/);
    try {
      if (!action) {
        const skills = registry.list();
        this.output.write(skills.length ? skills.map((skill) => [
          `${skill.id} [${skill.source}; ${skill.trust}${skill.disableModelInvocation ? "; manual-only" : ""}]`,
          `  ${JSON.stringify(skill.description)}`,
          `  ${skill.filePath}`,
        ].join("\n")).join("\n\n") + "\n" : "No skills discovered.\n");
      } else if (action === "inspect" && id && !sha256) {
        const inspected = await registry.inspect(id);
        this.output.write([
          `Skill: ${inspected.skill.id}`,
          `File: ${inspected.skill.filePath}`,
          `Source: ${inspected.skill.source}; trust: ${inspected.skill.trust}`,
          `Metadata: ${JSON.stringify({
            ...inspected.skill.extra,
            tags: inspected.skill.tags,
            stacks: inspected.skill.stacks,
            intents: inspected.skill.intents,
          })}`,
          inspected.body,
          `SHA256: ${inspected.sha256}`,
          `After reviewing: /skills trust ${id} ${inspected.sha256}`,
          "",
        ].join("\n"));
      } else if (action === "trust" && id && sha256 && !extra.length) {
        await registry.trust(id, sha256);
        this.output.write(`Trusted reviewed content for ${id}.\n`);
      } else if (action === "block" && id && !sha256) {
        await registry.block(id);
        this.output.write(`Blocked ${id} for future prompts.\n`);
      } else {
        this.output.write("Usage: /skills | /skills inspect <id> | /skills trust <id> <sha256> | /skills block <id>\n");
      }
    } catch (error) {
      this.output.write(`[skills] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private reportSkillWarnings(): void {
    for (const warning of this.skillRegistry!.diagnostics) {
      if (this.reportedSkillWarnings.has(warning)) continue;
      this.reportedSkillWarnings.add(warning);
      this.output.write(`[skills] ${warning}\n`);
    }
  }

  private writePrompt(prompt: string): void {
    if (!this.endedWithNewline) {
      this.output.write("\n");
    }

    this.output.write(`> ${prompt}\n`);
    this.endedWithNewline = true;
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case "assistant_text_delta":
        this.output.write(event.delta);
        this.endedWithNewline = event.delta.endsWith("\n");
        break;
      case "tool_start":
        this.ensureLineBreak();
        this.output.write(`• ${event.toolName}\n`);
        this.endedWithNewline = true;
        break;
      case "tool_end":
        this.output.write(`${event.isError ? "✗" : "✓"} ${event.toolName}\n`);
        this.endedWithNewline = true;
        break;
      case "message_end":
        this.ensureLineBreak();
        break;
      case "error":
        this.ensureLineBreak();
        this.output.write(`[error] ${event.message}\n`);
        this.endedWithNewline = true;
        break;
    }
  }

  private ensureLineBreak(): void {
    if (!this.endedWithNewline) {
      this.output.write("\n");
      this.endedWithNewline = true;
    }
  }
}
