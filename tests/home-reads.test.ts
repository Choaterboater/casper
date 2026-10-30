import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, runtimeShell, type SandboxHost } from "../src/app/sandbox";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { readOnlyCommand } from "../src/sandbox/read-only";
import { SandboxStore } from "../src/sandbox/store";
import { posixOnly } from "./support/platform";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/**
 * With no sandbox, a plain read in your own folders (Documents, Desktop, Projects…) runs without the "Run this command?"
 * box, as the AI's read tool already reads there. Private places, hidden folders, app data (~/Library, AppData), your home
 * folder itself, other places on the machine, and anything that is not a plain read still ask
 * (docs/adr/0002/46-home-reads.md).
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-home-reads-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "home", "Projects", "app");
  for (const folder of [project, path.join(home, "Documents", "lab", "src"), path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".casper"),
    path.join(home, "Library", "Cookies"), path.join(home, "Documents", "keys"), path.join(home, ".config")]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(home, "Documents", "lab", "src", "client.py"), "token = read_token()\n");
  await writeFile(path.join(home, "Documents", "notes.txt"), "notes\n");
  await writeFile(path.join(home, "Documents", "keys", ".env"), "API_TOKEN=x\n");
  await writeFile(path.join(home, ".ssh", "config"), "Host x\n");
  await writeFile(path.join(home, ".aws", "credentials"), "[default]\n");
  await writeFile(path.join(home, ".casper", "config.yaml"), "x: 1\n");
  await writeFile(path.join(home, ".config", "tool.yaml"), "x: 1\n");
  await writeFile(path.join(home, "Library", "Cookies", "c.binarycookies"), "x\n");
  await writeFile(path.join(base, "outside.txt"), "x\n");
  return { base, home, project, where: { root: project, home, homeReads: true } };
}

test("a plain read in your own folders is a read: a cd into ~/Documents with a grep piped to head, or cat ~/Documents/notes.txt", async () => {
  const { home, where } = await fixture();
  for (const command of ["cd ~/Documents/lab && grep -rn token src | cut -c1-80 | head", "cat ~/Documents/notes.txt",
    // A full path as the shell writes it (forward slashes on Windows too: a backslash word can't be checked).
    `cat ${path.join(home, "Documents", "notes.txt").split(path.sep).join("/")}`, "grep -rn token ~/Documents/lab/src", "ls -la ~/Documents/lab", "head -n 5 ~/Documents/lab/src/client.py"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: true });
  }
});

test("without homeReads (the reader, checks, routine work) the same reads still count only inside the project", async () => {
  const { project, home } = await fixture();
  for (const command of ["cat ~/Documents/notes.txt", "cd ~/Documents/lab && grep -rn token src | head"]) {
    expect({ command, read: readOnlyCommand(command, { root: project, home }) }).toEqual({ command, read: false });
  }
});

test("private places, hidden folders, app data, home itself, other places and anything not a plain read still ask", async () => {
  const { base, home, where } = await fixture();
  for (const command of ["cat ~/.ssh/config", "cat ~/.aws/credentials", "cat ~/.casper/config.yaml", "cat ~/.config/tool.yaml",
    "cat ~/Library/Cookies/c.binarycookies", "cat ~/Documents/keys/.env", "grep -r TOKEN ~/Documents/keys", "grep -r TOKEN ~/Documents",
    "ls ~", "cat ~", "cd ~ && ls", `cat ${path.join(base, "outside.txt").split(path.sep).join("/")}`, "cat /etc/hosts", 'cat "~/Documents/notes.txt"',
    "cat ~/Documents/notes.txt > ~/Documents/copy.txt", "cd ~/Documents/lab && rm -rf src", "cat ~root/x", "cat ~/Documents/../.ssh/config"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: false });
  }
  expect(home).toBeTruthy();
});

posixOnly("a link in your folders that leads to a private place or out of home asks", async () => {
  const { base, home, where } = await fixture();
  await symlink(path.join(home, ".ssh"), path.join(home, "Documents", "ssh-link"));
  await symlink(path.join(base, "outside.txt"), path.join(home, "Documents", "out-link.txt"));
  for (const command of ["cat ~/Documents/ssh-link/config", "cat ~/Documents/out-link.txt", "cd ~/Documents/ssh-link && cat config"]) {
    expect({ command, read: readOnlyCommand(command, where) }).toEqual({ command, read: false });
  }
});

test("with no sandbox the AI's shell runs a plain read in your folders without the box, and says where it read", async () => {
  const { home, project } = await fixture();
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  const asked: string[] = [];
  const written: string[] = [];
  const host: SandboxHost = { canAsk: () => true, pick: async (question) => { asked.push(question); return undefined; }, write: (text) => { written.push(text); }, planning: () => false,
    homeReads: () => true };
  const sandbox = createSessionSandbox(host, context, { root: () => project, home, seams: { engine: fakeEngine(), platform: "win32" } });
  const shell = runtimeShell(host, sandbox, new SandboxStore(context.stateDirectory));
  try {
    expect(await shell.approve!("cd ~/Documents/lab && grep -rn token src | head")).toBeUndefined();
    expect(asked).toEqual([]);
    expect(written.join("")).toContain("[read] outside this project, no box (a plain read in your own folders): cd ~/Documents/lab && grep -rn token src | head");
    // A private place still asks (and nobody said yes here, so it doesn't run).
    expect(await shell.approve!("cat ~/.ssh/config")).toBeDefined();
    // A shell whose host doesn't turn it on (a builder's, which keeps to its copy) asks as before.
    const builder = runtimeShell({ ...host, homeReads: undefined }, sandbox, new SandboxStore(context.stateDirectory));
    expect(await builder.approve!("cat ~/Documents/notes.txt")).toBeDefined();
    expect(asked).toHaveLength(2);
    await builder.close();
  } finally { await shell.close(); await sandbox.close(); }
});
