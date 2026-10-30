import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { receiptEvent } from "../src/app/json-events";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeStartOptions } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt, taskExitCode } from "../src/task/result";
import { checkCommand } from "./support/check-command";
import { removeTempDir } from "./support/temp-dir";

/**
 * Casper ran in ~/Documents/home-app and the AI fixed and released a sibling repository, ~/Documents/sensor-lib:
 * a python script through bash, a commit, a tag, a push and a GitHub release. The receipt listed none of it and said
 * "only documentation changed". It now says where the work was, what was sent out, and that Casper didn't check it.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

const PUSHED = "To https://github.com/example/sensor-lib.git\n   0f1e2d3..1a2b3c4  main -> main\n * [new tag]         v0.3.5 -> v0.3.5\n";
const RELEASED = "https://github.com/example/sensor-lib/releases/tag/v0.3.5\n";

test("work in a sibling repository: the receipt names it and what was pushed, and never says only documentation changed", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-outside-")));
  roots.push(root);
  const home = path.join(root, "home"), project = path.join(home, "Documents/home-app"), sibling = path.join(home, "Documents/sensor-lib");
  await mkdir(path.join(project, ".casper"), { recursive: true }); await mkdir(path.join(sibling, "src"), { recursive: true });
  await writeFile(path.join(project, "notes.py"), "x = 1\n");
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand())}\n`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: sibling, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  await writeFile(path.join(sibling, "src/api.py"), "a = 1\n"); git("add", "-A"); git("commit", "-qm", "first");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  let shell: RuntimeStartOptions["shell"];
  /** One bash call as the real runtime makes it: wrapped by Casper's shell first, then run (here: `run`). */
  const bash = async (id: string, command: string, run: () => Promise<void> | void, output = "") => {
    emit({ type: "tool_start", toolName: "bash", toolCallId: id, input: { command } });
    await shell?.wrap(command, project);
    await run();
    emit({ type: "tool_end", toolName: "bash", toolCallId: id, isError: false, input: { command }, output: { text: output, truncated: false } });
  };
  const runtime: AgentRuntime = {
    async start(options) {
      shell = options.shell;
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async () => {
          await bash("b1", "cd ~/Documents/sensor-lib && python3 - <<'EOF'\nfix()\nEOF", async () => {
            await writeFile(path.join(sibling, "src/api.py"), "a = 2\n");
            await writeFile(path.join(sibling, "src/sensor.py"), "s = 1\n");
          });
          await bash("b2", "cd ~/Documents/sensor-lib && python3 -m pytest -q", () => {}, "67 passed in 4.27s\n");
          await bash("b3", "cd ~/Documents/sensor-lib && git add -A && git commit -qm 'Release 0.3.5' && git tag v0.3.5 && git push origin main --tags",
            () => { git("add", "-A"); git("commit", "-qm", "Release 0.3.5"); git("tag", "v0.3.5"); }, PUSHED);
          await bash("b4", "cd ~/Documents/sensor-lib && gh release create v0.3.5 --latest --title 0.3.5 --notes 'Switch sensors'", () => {}, RELEASED);
          emit({ type: "assistant_text_delta", delta: "Released 0.3.5." });
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  try {
    await app.runOnce("fix the switch sensors in sensor-lib and release it", project);
    const task = app.getLastTaskResult()!;
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: sibling, encoding: "utf8" }).trim();
    const receipt = formatReceipt(task, { surface: "interactive" });
    expect(receipt.split("\n")[0]).toBe("– Not verified — the work was in ~/Documents/sensor-lib, outside this folder; Casper didn't run its checks");
    expect(receipt).toContain(`– Changed outside this folder: ~/Documents/sensor-lib: 2 files (api.py, sensor.py); committed ${commit}`);
    expect(receipt).toContain("– The AI ran tests in ~/Documents/sensor-lib itself (not counted)");
    expect(receipt).toContain("– Published: pushed main and tag v0.3.5 to example/sensor-lib; created GitHub release v0.3.5 (can't be undone with /undo)");
    expect(receipt).not.toContain("only documentation");
    expect(receipt).not.toContain("No files changed");
    // Nothing in this folder is the task's, so Casper ran none of this folder's checks.
    expect(output).not.toContain("Casper checking");
    // Its checks are its own: Casper says where to run them.
    expect(output).toContain("[folder] The work is in ~/Documents/sensor-lib. To work there: cd ~/Documents/sensor-lib && casper");
    const event = receiptEvent(undefined, task, taskExitCode(undefined, task));
    expect(event.outcome).toBe("not_verified");
    expect(event.published).toEqual(["pushed main and tag v0.3.5 to example/sensor-lib", "created GitHub release v0.3.5"]);
    expect(event.outside).toEqual([{ place: "~/Documents/sensor-lib", repository: true, files: ["src/api.py", "src/sensor.py"], commits: [expect.stringMatching(new RegExp(`^${commit}`))], unknown: null }]);
  } finally { await app.close(); }
}, 60_000);
