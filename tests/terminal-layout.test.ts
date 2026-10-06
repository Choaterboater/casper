import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { posixOnly } from "./support/platform";
import { PTY_TEST_MS, runPtyFixture } from "./support/pty";

// python3 runs the standard-library PTY fixture through a bounded VT emulator; Windows has no equivalent here.
posixOnly("bounded PTY: popups, pickers and streaming never creep the footer or wipe scrollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-layout-pty-"));
  try {
    const { exit, stdout, stderr } = await runPtyFixture("layout-pty.py", [], { cwd: root });
    expect({ exit, stderr, stdout }).toMatchObject({ exit: 0, stderr: "" });
    expect(stdout).toContain("LAYOUT PTY PASS");
  } finally { await rm(root, { recursive: true, force: true }); }
}, PTY_TEST_MS);
