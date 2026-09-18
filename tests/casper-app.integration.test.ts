import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CasperApp } from "../src/app";
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

  constructor(private readonly cwd: string) {}

  async prompt(text: string): Promise<void> {
    this.emit({ type: "tool_start", toolName: "read" });
    this.emit({ type: "tool_end", toolName: "read", isError: false });
    this.emit({ type: "assistant_text_delta", delta: `Handled: ${text}` });
    this.emit({ type: "message_end" });
  }

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

  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.startOptions = options;
    return new FakeRuntimeSession(options.cwd);
  }

  async dispose(): Promise<void> {}
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CasperApp", () => {
  test("starts with a Casper banner, detects git branch, and streams runtime output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "casper-phase0-"));
    tempDirs.push(tempDir);

    await execFileAsync("git", ["init", "-b", "main"], { cwd: tempDir });

    const expectedRoot = await realpath(tempDir);

    const fakeRuntime = new FakeRuntime();
    let output = "";

    const app = new CasperApp({
      runtimeFactory: () => fakeRuntime,
      output: {
        write(text: string) {
          output += text;
        },
      },
    });

    await app.runOnce("fix this failing test", tempDir);
    await app.close();

    expect(fakeRuntime.startOptions?.cwd).toBe(expectedRoot);
    expect(output).toContain("CASPER");
    expect(output).toContain("your coding companion");
    expect(output).toContain("project");
    expect(output).toContain("branch   main");
    expect(output).toContain("> fix this failing test");
    expect(output).toContain("• read");
    expect(output).toContain("✓ read");
    expect(output).toContain("Handled: fix this failing test");
  });
});
