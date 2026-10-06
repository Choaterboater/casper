import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./support/env";
import { removeTempDir } from "./support/temp-dir";

test("a real Pi conversation rewinds to the mark before a task at no cost, and refuses when the conversation moved on", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-pi-rewind-"));
  try {
    const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/pi-rewind.ts"), cwd], {
      cwd, env: cleanEnv({ HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1" }), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ moved: false, rewound: true, same: true, branch: ["BEFORE"], twoBack: true, backAtStart: true });
  } finally { await removeTempDir(root); }
}, 60_000);
