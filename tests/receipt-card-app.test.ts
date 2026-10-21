import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { withEnv } from "./support/env";
import { childTestLimit } from "./support/limits";
import { removeTempDir } from "./support/temp-dir";
import { fakeWriter } from "./support/tty";

test("after a failed check the receipt card says Ctrl+T shows the log, and Ctrl+T shows that check's log, not the edit before it", async () => {
  await withEnv({ TERM: "xterm-256color", NO_COLOR: undefined }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "casper-card-log-"));
    const home = path.join(root, "home"), project = path.join(root, "project");
    await mkdir(home);
    await mkdir(path.join(project, ".casper"), { recursive: true });
    await writeFile(path.join(project, "calc.py"), "ok\n");
    // Passes on the files from before the change, fails after it: the change's own failure, with no repair to try.
    await writeFile(path.join(project, ".casper/check.ts"),
      'import { readFileSync } from "node:fs";\nif (readFileSync("calc.py", "utf8").includes("broken")) { console.error("calc check: expected ok, got broken"); process.exit(1); }\n');
    await writeFile(path.join(project, ".casper/project.yaml"), "commands:\n  test: bun .casper/check.ts\nverification:\n  mode: auto\nrepair:\n  maxAttempts: 0\n");
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    const runtime: AgentRuntime = {
      async start() {
        return {
          getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
          getState: () => ({ cwd: project, isStreaming: false }),
          subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
          abort: async () => {}, setTools: () => {},
          prompt: async () => {
            // An edit step first: before the check, Ctrl+T would show its diff.
            emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
            emit({ type: "tool_start", toolName: "edit", toolCallId: "e1", input: { path: "calc.py" } });
            await writeFile(path.join(project, "calc.py"), "broken\n");
            emit({ type: "tool_end", toolName: "edit", toolCallId: "e1", input: { path: "calc.py" }, isError: false, diff: "@@ -1 +1 @@\n-ok\n+broken" });
            emit({ type: "assistant_text_delta", delta: "Changed calc.py.\n" });
            emit({ type: "assistant_response_end", stopReason: "stop" });
            emit({ type: "message_end" });
          },
        };
      },
      async dispose() {},
    };
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
    const screen = fakeWriter();
    const app = new CasperApp({
      input, output: screen.writer, runtimeFactory: () => runtime, sessionHomeDir: home,
      loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
      loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
      loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
      loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
    });
    const interactive = app.runInteractive(project);
    // A wait that never ends fails with the screen, so a failure says what Casper showed instead.
    const until = (test: (output: string) => boolean) => Promise.race([screen.until(test),
      Bun.sleep(30_000).then(() => { throw new Error(`screen did not match; it ends with:\n${Bun.stripANSI(screen.output).slice(-3000)}`); })]);
    try {
      await until((output) => output.includes("idle"));
      input.write("break calc\r");
      await until((output) => { const at = output.lastIndexOf("Ctrl+T shows the log"); return at >= 0 && output.lastIndexOf("idle") > at; });
      expect(Bun.stripANSI(screen.output)).toContain("▌ ✗ Failed: test failed");
      expect(app.events.lastStep()?.body).toContain("calc check: expected ok, got broken");
      const from = Bun.stripANSI(screen.output).length;
      input.write("\x14");
      await until((output) => output.slice(from).includes("calc check: expected ok, got broken"));
      expect(Bun.stripANSI(screen.output).slice(from)).not.toContain("+broken");
    } finally {
      input.write("/exit\r");
      await interactive;
      await app.close();
      input.destroy();
      await removeTempDir(root);
    }
  });
}, childTestLimit(2));
