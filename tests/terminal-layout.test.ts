import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { posixOnly } from "./support/platform";

// python3 runs the standard-library PTY fixture through a bounded VT emulator; Windows has no equivalent here.
posixOnly("bounded PTY: popups, pickers and streaming never creep the footer or wipe scrollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-layout-pty-"));
  const child = Bun.spawn(["python3", path.join(import.meta.dir, "fixtures/layout-pty.py"), process.execPath], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr, stdout }).toMatchObject({ exit: 0, stderr: "" });
    expect(stdout).toContain("LAYOUT PTY PASS");
  } finally { clearTimeout(timer); child.kill(); await rm(root, { recursive: true, force: true }); }
}, 70_000);
