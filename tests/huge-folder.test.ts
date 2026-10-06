import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext, type ProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { snapshotFailureReason, SNAPSHOT_FILE_LIMIT } from "../src/task/changes";
import { TaskObservations } from "../src/task/observations";
import { formatReceipt } from "../src/task/result";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const bash = (command: string) => ({ type: "tool_end" as const, toolName: "bash", toolCallId: "call", input: { command }, isError: false,
  output: { text: "ok", truncated: false } });
const unknownAfter = (...commands: string[]) => {
  const observations = new TaskObservations();
  for (const command of commands) observations.observeToolEnd(bash(command), {});
  return observations.snapshot(undefined).possibleMutations;
};

test("look commands and ssh to another machine don't by themselves make the folder's changes unknown", () => {
  expect(unknownAfter("ls -la", "cat ~/notes.md | grep vlan", "find . -name '*.py'", "grep -rn token docs")).toBe(false);
  expect(unknownAfter("ssh root@build-server 'pvesh get /nodes'", "ssh -i ~/.ssh/lab root@10.0.0.5 show version")).toBe(false);
  expect(unknownAfter("rm notes.md")).toBe(true);
  expect(unknownAfter("echo hi > notes.md")).toBe(true);
  expect(unknownAfter("find . -delete")).toBe(true);
  expect(unknownAfter("ssh -E ssh.log root@build-server uptime")).toBe(true);
  // ssh to this machine runs its command on this folder's files.
  expect(unknownAfter("ssh 127.0.0.1 rm -rf Documents/notes")).toBe(true);
  expect(unknownAfter("ssh root@localhost uptime")).toBe(true);
  expect(unknownAfter("ssh -p 2222 user@[::1] ls")).toBe(true);
  expect(unknownAfter(`ssh ${os.hostname()} ls`)).toBe(true);
  expect(unknownAfter("ls", "python3 build.py")).toBe(true);
});

test("the snapshot failure reason is plain words", () => {
  expect(snapshotFailureReason(new RangeError(`Workspace exceeds ${SNAPSHOT_FILE_LIMIT} files`))).toBe("this folder has over 20,000 files; open a project folder");
  expect(snapshotFailureReason(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe("Casper could not read this folder (EACCES)");
});

test("the receipt keeps the reason and lists what Casper's edit and write tools changed", () => {
  const text = formatReceipt({ execution: "completed", possibleMutations: true, observedEdits: ["/home/u/Documents/lab.md"],
    snapshotFailure: { reason: "this folder has over 20,000 files; open a project folder", edited: ["lab.md"] } }, { surface: "interactive" });
  expect(text).toContain("• Changes unknown: this folder has over 20,000 files; open a project folder");
  expect(text).toContain("• Changed (seen by Casper's edit and write tools): lab.md");
});

test("a task in a folder of over 20,000 files says why changes are unknown and names the files Casper's tools changed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-huge-")); dirs.push(root);
  const home = path.join(root, "home"); const docs = path.join(home, "Documents");
  await mkdir(docs, { recursive: true });
  for (let batch = 0; batch < 21; batch++) {
    const folder = path.join(docs, `photos-${batch}`);
    await mkdir(folder);
    await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(path.join(folder, `${index}.txt`), "")));
  }
  const runtime: AgentRuntime = {
    async start(options): Promise<RuntimeSession> {
      return { getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }), getState: () => ({ cwd: docs, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
        prompt: async () => {
          await writeFile(path.join(docs, "lab.md"), "# lab\n");
          await options.afterFileEdit?.(path.join(docs, "lab.md"), new AbortController().signal);
        } };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({ runtimeFactory: () => runtime, sessionHomeDir: home, output: { write: (text: string) => { output += text; } },
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context: ProjectContext) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  try {
    await app.runOnce("write up the lab in lab.md", docs);
    expect(output).toContain("• Changes unknown: this folder has over 20,000 files; open a project folder");
    expect(output).toContain("• Changed (seen by Casper's edit and write tools): lab.md");
  } finally { await app.close(); }
}, 180_000);
