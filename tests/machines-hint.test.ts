import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { machineNames, rememberMachines } from "../src/app/machines";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatTaskPrompt } from "../src/task/classify";
import { removeTempDir } from "./support/temp-dir";

/**
 * An AI asked "install Home Assistant" after working on a NAS over ssh wrote the compose file in the project folder and
 * tried to copy it over. Each request now names the machines the conversation worked on, so work for one happens there.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

const CONFIG = "Host nas\n  HostName 192.0.2.31\n  User admin\n  IdentityFile ~/.ssh/id_fixture_nas\n";

async function home(config: string) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-machines-")));
  roots.push(base);
  await mkdir(path.join(base, "project"));
  await mkdir(path.join(base, ".ssh")); await writeFile(path.join(base, ".ssh", "config"), config);
  return base;
}

test("each request names the machines the conversation worked on over ssh, by their ssh config name; none before the first", async () => {
  const where = await home(CONFIG);
  const machines: string[] = [];
  const app = { machines };
  rememberMachines(app, [{ host: "192.0.2.31" }]);
  rememberMachines(app, [{ host: "192.0.2.50" }, { host: "192.0.2.31" }, { host: "192.0.2.60" }, { host: "192.0.2.70" }]);
  // At most three, newest last, each once.
  expect(app.machines).toEqual(["192.0.2.31", "192.0.2.60", "192.0.2.70"]);
  expect(machineNames(["192.0.2.31", "192.0.2.60"], where)).toEqual(["nas (192.0.2.31)", "192.0.2.60"]);
  const model = { commands: {} } as never;
  const classification = { intent: "implement", mode: "modify", verification: [] } as never;
  const prompt = formatTaskPrompt("install home assistant and get it running", classification, model, { machines: ["nas (192.0.2.31)"] });
  expect(prompt).toContain("- machines: this conversation worked on nas (192.0.2.31) over ssh. Work meant for one of them happens there (its files, its services), not in this folder, unless the request asks for files here. Check a change there where the person will see it (its web page in the browser tool, or its API) before you call it done or go on; if you can't, say it is not checked.");
  expect(formatTaskPrompt("install home assistant", classification, model)).not.toContain("- machines:");
  expect(formatTaskPrompt("install home assistant", classification, model, { machines: [] })).not.toContain("- machines:");
});

test("after a task that ran commands on a machine over ssh, the next request says so; /clear forgets it", async () => {
  const where = await home(CONFIG);
  const root = path.join(where, "project");
  const prompts: string[] = [];
  let first = true;
  const runtime: AgentRuntime = {
    async start(): Promise<RuntimeSession> {
      const listeners = new Set<(event: Parameters<Parameters<RuntimeSession["subscribe"]>[0]>[0]) => void>();
      return {
        async prompt(text) {
          prompts.push(text);
          if (!first) return;
          first = false;
          for (const listener of listeners) {
            listener({ type: "assistant_response_start" });
            listener({ type: "tool_end", toolName: "bash", toolCallId: "c1", isError: false, output: { text: "", truncated: false },
              input: { command: "ssh admin@192.0.2.31 'ls /volume1/docker'" } });
            listener({ type: "assistant_response_end", stopReason: "stop" });
          }
        },
        async abort() {}, setTools() {}, async clearConversation() {}, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        getState: () => ({ cwd: root, isStreaming: false }),
      };
    },
    async dispose() {},
  };
  const app = new CasperApp({
    verificationMode: "off", runtimeFactory: () => runtime, output: { write: () => {} }, sessionHomeDir: where,
    loadProjectContext: (project) => loadProjectContext(project, { homeDir: where }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: where }),
  });
  try {
    await app.runOnce("is home assistant installed under /volume1/docker?", root);
    await app.runOnce("can you install home assistant and get it running?", root);
    expect(prompts[0]).not.toContain("- machines:");
    expect(prompts[1]).toContain("- machines: this conversation worked on nas (192.0.2.31) over ssh.");
    await app.runOnce("/clear", root);
    await app.runOnce("now write a readme", root);
    expect(prompts.at(-1)).not.toContain("- machines:");
  } finally { await app.close(); }
});
