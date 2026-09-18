import readline from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import type { Writable, Readable } from "node:stream";
import { inspectProject, type ProjectInfo } from "./project/inspect";
import { PiRuntime } from "./runtime/pi";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeSession,
} from "./runtime/types";
import { renderBanner } from "./tui/banner";

export interface OutputWriter {
  write(text: string): void;
}

export interface CasperAppOptions {
  runtimeFactory?: () => AgentRuntime;
  inspectProject?: (cwd: string) => Promise<ProjectInfo>;
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
  private readonly output: OutputWriter;
  private readonly input: Readable;
  private runtime?: AgentRuntime;
  private session?: RuntimeSession;
  private unsubscribe?: () => void;
  private readline?: ReadlineInterface;
  private endedWithNewline = true;

  constructor(options: CasperAppOptions = {}) {
    this.runtimeFactory = options.runtimeFactory ?? (() => new PiRuntime());
    this.inspectProjectFn = options.inspectProject ?? inspectProject;
    this.output = options.output ?? process.stdout;
    this.input = options.input ?? process.stdin;
  }

  async start(cwd = process.cwd()): Promise<ProjectInfo> {
    const project = await this.inspectProjectFn(cwd);
    this.output.write(renderBanner(project));

    this.runtime = this.runtimeFactory();
    this.session = await this.runtime.start({
      cwd: project.root,
      systemPromptAppend: DEFAULT_SYSTEM_PROMPT_APPEND,
    });
    this.unsubscribe = this.session.subscribe((event) => this.handleRuntimeEvent(event));

    return project;
  }

  async runOnce(prompt: string, cwd = process.cwd()): Promise<void> {
    if (!this.session) {
      await this.start(cwd);
    }

    this.writePrompt(prompt);
    await this.session!.prompt(prompt);
  }

  async runInteractive(cwd = process.cwd()): Promise<void> {
    if (!this.session) {
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

      await this.session!.prompt(prompt);
    }
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.readline?.close();
    await this.runtime?.dispose();
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
