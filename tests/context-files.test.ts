import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { containedContextFile } from "../src/runtime/pi";
import { needsSymlinks } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

needsSymlinks("context files: a hostile ancestor link is refused while ordinary and dotfiles links load", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-context-files-"));
  try {
    const secret = path.join(root, "outside", "credentials");
    const dotfiles = path.join(root, "dotfiles", "AGENTS.md");
    const parent = path.join(root, "hostile-tree");
    const cwd = path.join(parent, "nested", "checkout");
    const agentDir = path.join(root, "agent");
    for (const dir of [path.dirname(secret), path.dirname(dotfiles), cwd, agentDir]) await mkdir(dir, { recursive: true });
    await writeFile(secret, "SECRET"); await writeFile(dotfiles, "DOTFILES");

    // A parent directory of the opened checkout links its AGENTS.md at a secret: refused.
    await symlink(secret, path.join(parent, "AGENTS.md"));
    expect(containedContextFile(path.join(parent, "AGENTS.md"), cwd, agentDir)).toBe(false);
    // An ancestor link to another context file (a dotfiles checkout) still loads.
    await symlink(dotfiles, path.join(parent, "nested", "CLAUDE.md"));
    expect(containedContextFile(path.join(parent, "nested", "CLAUDE.md"), cwd, agentDir)).toBe(true);
    // Plain ancestor files and the engine store's own file are ordinary context.
    await writeFile(path.join(root, "AGENTS.md"), "PLAIN");
    expect(containedContextFile(path.join(root, "AGENTS.md"), cwd, agentDir)).toBe(true);
    await symlink(secret, path.join(agentDir, "AGENTS.md"));
    expect(containedContextFile(path.join(agentDir, "AGENTS.md"), cwd, agentDir)).toBe(true);
    // The workspace's own file must stay inside the workspace, even when it names a context file.
    await symlink(dotfiles, path.join(cwd, "AGENTS.md"));
    expect(containedContextFile(path.join(cwd, "AGENTS.md"), cwd, agentDir)).toBe(false);
    // A missing target is refused rather than guessed.
    expect(containedContextFile(path.join(root, "missing", "AGENTS.md"), cwd, agentDir)).toBe(false);
  } finally { await removeTempDir(root); }
});
