import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext, type ProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { snapshotFailureReason, SNAPSHOT_FILE_LIMIT } from "../src/task/changes";
import { TaskObservations } from "../src/task/observations";
import { formatReceipt } from "../src/task/result";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

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
  expect(snapshotFailureReason(new RangeError(`Workspace exceeds ${SNAPSHOT_FILE_LIMIT} files`))).toBe("not a project folder (over 20,000 files)");
  expect(snapshotFailureReason(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe("Casper could not read this folder (EACCES)");
});

test("the receipt keeps the reason and lists what Casper's edit and write tools changed", () => {
  const text = formatReceipt({ execution: "completed", possibleMutations: true, observedEdits: ["/home/u/Documents/lab.md"],
    snapshotFailure: { reason: "not a project folder (over 20,000 files)", edited: ["lab.md"] } }, { surface: "interactive" });
  expect(text).toContain("– Changes unknown: not a project folder (over 20,000 files)");
  expect(text).toContain("– Changed (seen by Casper's edit and write tools): lab.md");
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
    expect(output).toContain("– Changes unknown: not a project folder (over 20,000 files)");
    // Said once: no "Undo not available" line after it, and no wait for an undo copy.
    expect(output).not.toContain("Undo not available");
    expect(output).toContain("– Changed (seen by Casper's edit and write tools): lab.md");
  } finally { await app.close(); }
}, 180_000);

/** ~/Documents with a repository whose photos hold `before` thousand files. The task edits the site and adds `added`
 * thousand photos; another program saves notes.txt while it runs. Returns the output, /diff 1 and /undo 1. */
async function nestedRepoTask(before: number, added: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-huge-")); dirs.push(root);
  const home = path.join(root, "home"); const docs = path.join(home, "Documents"); const repo = path.join(docs, "Casper");
  await mkdir(path.join(repo, "site"), { recursive: true });
  await writeFile(path.join(docs, "notes.txt"), "v1\n");
  await writeFile(path.join(repo, "site", "index.html"), "<h1>old</h1>\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("add", "-A"); git("commit", "-qm", "first");
  const photos = async (from: number, to: number) => {
    for (let batch = from; batch < to; batch++) {
      const folder = path.join(repo, "photos", `photos-${batch}`);
      await mkdir(folder, { recursive: true });
      await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(path.join(folder, `${index}.txt`), "")));
    }
  };
  await photos(0, before);
  const runtime: AgentRuntime = {
    async start(options): Promise<RuntimeSession> {
      return { getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }), getState: () => ({ cwd: docs, isStreaming: false }),
        subscribe: () => () => {}, abort: async () => {}, setTools: () => {},
        prompt: async () => {
          await writeFile(path.join(repo, "site", "index.html"), "<h1>new</h1>\n");
          await options.afterFileEdit?.(path.join(repo, "site", "index.html"), new AbortController().signal);
          await photos(before, before + added);
          // Another program saves this file while the task runs.
          await writeFile(path.join(docs, "notes.txt"), "v2\n");
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
    await app.runOnce("build me a website in Casper/site", docs);
    const receipt = output;
    await app.runOnce("/diff 1", docs);
    const undone = await app.runOnce("/undo 1", docs).then(() => "", (error: unknown) => String(error));
    return { receipt, diff: output.slice(receipt.length), undone, notes: await readFile(path.join(docs, "notes.txt"), "utf8") };
  } finally { await app.close(); }
}

const noUndo = (result: Awaited<ReturnType<typeof nestedRepoTask>>) => {
  expect(result.receipt).toContain("– Changes unknown: not a project folder (over 20,000 files)");
  expect(result.receipt).not.toContain("Undo: casper");
  expect(result.diff).toContain("Casper kept no copy of task 1 (not a project folder), so it can't show its changes.");
  expect(result.undone).toContain("Task 1 can't be undone: not a project folder.");
  expect(result.notes).toBe("v2\n");
};

// Old code failed this one only when the undo copy finished before the first snapshot gave up (a few seconds here);
// the next one fails on old code every time.
test("a folder whose nested repository puts it over 20,000 files offers no undo or diff, so another program's change is never put back", async () => {
  noUndo(await nestedRepoTask(21, 0));
}, 180_000);

test("a task that makes the folder over 20,000 files offers no undo or diff either", async () => {
  noUndo(await nestedRepoTask(19, 2));
}, 180_000);
