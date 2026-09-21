import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CasperApp } from "../src/app";
import { leadingFlag } from "../src/cli";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { ProjectMemory } from "../src/memory/store";
import { HELP_TEXT } from "../src/tui/help";
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeSession,
  RuntimeStartOptions,
} from "../src/runtime/types";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

class FakeRuntimeSession implements RuntimeSession {
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(
    private readonly cwd: string,
    private readonly prompts: string[],
  ) {}

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.emit({ type: "tool_start", toolName: "read" });
    this.emit({ type: "tool_end", toolName: "read", isError: false });
    this.emit({ type: "assistant_text_delta", delta: `Handled: ${text}` });
    this.emit({ type: "message_end" });
  }

  setTools(): void {}
  async abort(): Promise<void> {}

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return { cwd: this.cwd, isStreaming: false };
  }

  private emit(event: Parameters<RuntimeEventListener>[0]): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeRuntime implements AgentRuntime {
  public startOptions?: RuntimeStartOptions;
  public readonly prompts: string[] = [];

  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.startOptions = options;
    return new FakeRuntimeSession(options.cwd, this.prompts);
  }

  async dispose(): Promise<void> {}
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CasperApp", () => {
  test.each(["/help", "/help all", "/status", "/login", "/skills diagnostics", "/exit", "/quit", "/nope", "/verfy typecheck", "  /nope  "])("%s stays local without runtime startup or outcomes", async (prompt) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-command-project-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "casper-command-home-"));
    tempDirs.push(root, homeDir);
    const runtime = new FakeRuntime();
    let starts = 0;
    let stateDirectory = "";
    let output = "";
    const app = new CasperApp({
      runtimeFactory: () => { starts++; return runtime; },
      loadProjectContext: async (project) => {
        const context = await loadProjectContext(project, { homeDir });
        stateDirectory = context.stateDirectory;
        return context;
      },
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
      output: { write: (text) => { output += text; } },
    });
    try {
      if (["/help", "/help all", "/status", "/login", "/skills diagnostics", "/exit", "/quit"].includes(prompt.trim())) {
        expect(await app.runOnce(prompt, root)).toBeUndefined();
        if (prompt === "/help") expect(output).toContain(HELP_TEXT);
      } else {
        await expect(app.runOnce(prompt, root)).rejects.toThrow("Unknown command");
      }
      expect(starts).toBe(0);
      expect(runtime.prompts).toHaveLength(0);
      expect(app.getLastTaskResult()).toBeUndefined();
      expect(await new ProjectMemory(stateDirectory).outcomes()).toEqual([]);
    } finally { await app.close(); }
  });

  test("CLI help and exit commands succeed locally while unknown commands exit 1", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-command-cli-"));
    tempDirs.push(root);
    const cli = path.resolve(import.meta.dir, "../src/cli.ts");
    for (const command of ["--help", "/help", "/exit", "/quit", "/verfy typecheck"]) {
      const child = Bun.spawn([process.execPath, cli, command], {
        cwd: root, env: { ...process.env, HOME: root, CASPER_PROFILE: "default" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code).toBe(command.startsWith("/verfy") ? 1 : 0);
      if (command.includes("help")) expect(stdout).toContain(HELP_TEXT);
      if (command.startsWith("/verfy")) expect(stderr).toContain('Unknown command "/verfy"');
    }
  });

  test("CLI flags are read only from a leading argument, never from a prompt", async () => {
    // A one-character flag must not be swallowed out of a multi-word prompt.
    expect(leadingFlag(["explain", "the", "-v", "flag"])).toBeUndefined();
    expect(leadingFlag(["what", "does", "--version", "print"])).toBeUndefined();
    expect(leadingFlag(["fix", "--help", "output"])).toBeUndefined();
    expect(leadingFlag(["--version"])).toBe("version");
    expect(leadingFlag(["-v"])).toBe("version");
    expect(leadingFlag(["--help"])).toBe("help");
    expect(leadingFlag(["-h"])).toBe("help");
    expect(leadingFlag([])).toBeUndefined();

    const root = await mkdtemp(path.join(os.tmpdir(), "casper-command-flags-"));
    tempDirs.push(root);
    const cli = path.resolve(import.meta.dir, "../src/cli.ts");
    for (const args of [["--version"], ["-v"]]) {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        cwd: root, env: { ...process.env, HOME: root, CASPER_PROFILE: "default" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect({ leading: stdout.trim().startsWith("casper "), code }).toEqual({ leading: true, code: 0 });
      expect(stdout).not.toContain("Casper — your coding companion");
    }
  });

test("local skill commands work without starting an unavailable runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-local-project-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "casper-local-home-"));
    tempDirs.push(root, homeDir);
    const directory = path.join(root, ".casper/skills/mcp");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), "---\nname: mcp\ndescription: MCP authoring.\n---\nLOCAL_BODY");
    let output = "";
    const app = new CasperApp({
      runtimeFactory: () => { throw new Error("Runtime unavailable"); },
      loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
      output: { write: (text) => { output += text; } },
    });
    try {
      await app.runOnce("/skills", root);
      const id = output.match(/mcp@[a-f0-9]+/)![0];
      await app.runOnce(`/skills inspect ${id}`);
      const digest = output.match(/SHA256: ([a-f0-9]{64})/)![1];
      await app.runOnce(`/skills trust ${id} ${digest}`);
      await app.runOnce(`/skills block ${id}`);
      await app.runOnce("/project");
      expect(output).toContain("LOCAL_BODY");
      expect(output).toContain("Trusted reviewed content");
      expect(output).toContain("Blocked");
      expect(output.match(/CASPER/g)).toHaveLength(1);
      await expect(app.runOnce("Add an MCP tool")).rejects.toThrow("Runtime unavailable");
    } finally {
      await app.close();
    }
  });

  test("selects relevant skill bodies per task and handles inspection/trust commands without model calls", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-skills-app-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "casper-skills-home-"));
    tempDirs.push(root, homeDir);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { typescript: "latest" } }));
    const fixtures = [
      [path.join(homeDir, ".casper/skills/mcp"), "mcp-tools", "tags: [mcp]\nstacks: [typescript]\n", "MCP_INSTRUCTIONS"],
      [path.join(homeDir, ".casper/skills/ts"), "typescript", "tags: [typescript]\n", "TS_INSTRUCTIONS"],
      [path.join(homeDir, ".casper/skills/ui"), "react-ui", "tags: [react, layout]\n", "UNRELATED_INSTRUCTIONS"],
      [path.join(root, ".casper/skills/project"), "project-mcp", "tags: [mcp]\n", "PROJECT_INSTRUCTIONS"],
    ];
    for (const [directory, name, fields, body] of fixtures) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Guidance for ${name}\n${fields}---\n${body}`);
    }
    const runtime = new FakeRuntime();
    let output = "";
    const app = new CasperApp({
      runtimeFactory: () => runtime,
      loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir, maxActive: context.skills.maxActive }),
      output: { write: (text) => { output += text; } },
    });
    try {
      await app.runOnce("/skills", root);
      expect(runtime.prompts).toHaveLength(0);
      expect(output).toContain("4 indexed");
      expect(output).toContain("[project; untrusted]");
      expect(output).not.toContain("_INSTRUCTIONS");
      expect(runtime.startOptions).toBeUndefined();
      await app.runOnce("Add a TypeScript MCP tool");
      expect(runtime.startOptions?.systemPromptAppend).not.toContain("_INSTRUCTIONS");
      expect(runtime.prompts[0]).toContain("MCP_INSTRUCTIONS");
      expect(runtime.prompts[0]).toContain("TS_INSTRUCTIONS");
      expect(runtime.prompts[0]).not.toContain("UNRELATED_INSTRUCTIONS");
      expect(runtime.prompts[0]).not.toContain("PROJECT_INSTRUCTIONS");
      expect(runtime.prompts[0]).toContain("User request:\nAdd a TypeScript MCP tool");

      const id = output.match(/project-mcp@[a-f0-9]+/)![0];
      output = "";
      await app.runOnce(`/skills inspect ${id}`);
      expect(output).toContain("PROJECT_INSTRUCTIONS");
      expect(runtime.prompts).toHaveLength(1);
      const digest = output.match(/SHA256: ([a-f0-9]{64})/)![1];
      await app.runOnce(`/skills trust ${id} incorrect`);
      expect(output).toContain("digest is incorrect");
      await app.runOnce(`/skills trust ${id} ${digest}`);
      expect(runtime.prompts).toHaveLength(1);
      await app.runOnce("Add a TypeScript MCP tool");
      expect(runtime.prompts[1]).toContain("PROJECT_INSTRUCTIONS");
      await app.runOnce(`/skills block ${id}`);
      await app.runOnce("Add a TypeScript MCP tool");
      expect(runtime.prompts[2]).not.toContain("PROJECT_INSTRUCTIONS");
      output = "";
      await app.runOnce("Hello there");
      expect(output).not.toContain("[task]");
      expect(runtime.prompts[3]).not.toContain("_INSTRUCTIONS");
      expect(app.getLastTaskResult()).toBeDefined();
      await app.runOnce("/help");
      expect(app.getLastTaskResult()).toBeUndefined();
      await expect(app.runOnce("/nope")).rejects.toThrow("Unknown command");
      expect(app.getLastTaskResult()).toBeUndefined();
      await app.runOnce("/skills nonsense");
      expect(output).toContain("Usage: /skills");
      expect(runtime.prompts).toHaveLength(4);
    } finally {
      await app.close();
    }
  });

  test("starts with a Casper banner, detects git branch, and streams runtime output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "casper-phase1-project-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "casper-phase1-home-"));
    tempDirs.push(tempDir, homeDir);

    await execFileAsync("git", ["init", "-b", "main"], { cwd: tempDir });
    await mkdir(path.join(tempDir, ".casper"));
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        packageManager: "bun@1.4.0",
        scripts: { build: "tsc", test: "bun test", typecheck: "tsc --noEmit" },
        dependencies: { react: "latest" },
        devDependencies: { typescript: "latest" },
      }),
    );
    await writeFile(path.join(tempDir, "tsconfig.json"), "{}");
    await writeFile(path.join(tempDir, "bun.lock"), "");
    await writeFile(path.join(tempDir, ".casper", "project.yaml"), "profile: integration\n");
    await writeFile(path.join(tempDir, ".casper", "rules.md"), "Keep runtime adapters isolated.");

    const expectedRoot = await realpath(tempDir);

    const fakeRuntime = new FakeRuntime();
    let output = "";

    const app = new CasperApp({
      runtimeFactory: () => fakeRuntime,
      loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
      output: {
        write(text: string) {
          output += text;
        },
      },
    });

    await app.runOnce("fix this failing test", tempDir);
    expect(output).not.toContain("stack     ");
    await app.runOnce("/project");
    await app.close();

    expect(fakeRuntime.startOptions?.cwd).toBe(expectedRoot);
    expect(output).toContain("CASPER");
    expect(output).toContain("your coding companion");
    expect(output).toContain("project");
    expect(output).toContain("stack     typescript · react");
    expect(output).toContain("package   bun");
    expect(output).toContain("build     bun run build");
    expect(output).toContain("test      bun run test");
    expect(output).toContain("profile   integration");
    expect(output).toContain("branch    main");
    expect(output).toContain("> fix this failing test");
    expect(output).toContain("• read");
    expect(output).toContain("✓ read");
    expect(output).toContain("User request:\nfix this failing test");
    expect(fakeRuntime.startOptions?.systemPromptAppend).toContain("Keep runtime adapters isolated.");
    expect(fakeRuntime.prompts[0]).toContain("intent: fix");
    expect(fakeRuntime.prompts[0]).toContain("test=bun run test");
  });
});
