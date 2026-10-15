import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./support/temp-dir";

const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;

test.skipIf(!hasTmux)("real tmux: lone suggestion is 1, arrow-first check approval shows old → new, session override leaves files alone", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "casper-check-box-tmux-"));
  const socket = path.join(temp, "sock"), root = path.join(temp, "project");
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8", timeout: 5000 });
  const capture = () => tmux("capture-pane", "-p", "-t", "checks", "-S", "-200").stdout;
  const wait = async (match: (screen: string) => boolean) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { const screen = capture(); if (match(screen)) return screen; await Bun.sleep(50); }
    throw new Error(`terminal did not match:\n${capture()}`);
  };
  const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
  try {
    await mkdir(path.join(root, ".casper"), { recursive: true });
    const original = "commands:\n  test: bun .casper/quick-test.ts\n";
    await writeFile(path.join(root, ".casper/project.yaml"), original);
    await writeFile(path.join(root, ".casper/quick-test.ts"), "throw new Error('real check');\n");
    const runner = path.join(import.meta.dir, "fixtures/check-changes-terminal.ts");
    const command = `env -u NO_COLOR TERM=xterm-256color ${quote(process.execPath)} ${quote(runner)} ${quote(root)}`;
    expect(tmux("new-session", "-d", "-s", "checks", "-x", "80", "-y", "40", command).status).toBe(0);
    const next = await wait(screen => screen.includes("Next: 1 Save junos-syntax (free)"));
    expect(next).not.toContain("Next: 3");
    tmux("send-keys", "-t", "checks", "1");
    const box = await wait(screen => screen.includes("Change the test check for this project?") && screen.includes("3. Use this command"));
    for (const text of ["Picked: /verify add junos-syntax", "Old → new", "--- old", "bun .casper/quick-test.ts", "+++ new", "test: bun test", "❯ 1. No", "2. Yes, save this change", "Enter to choose · Esc to skip"]) expect(box).toContain(text);
    if (process.env.SHOW_SCREEN) console.log(`CHECK BOX (80 columns):\n${box}`);
    await Bun.sleep(350); // Answer only after the real box's input guard.
    tmux("send-keys", "-t", "checks", "Down", "Down");
    await wait(screen => screen.includes("❯ 3. Use this command for this session only"));
    tmux("send-keys", "-t", "checks", "Enter");
    const script = await wait(screen => screen.includes("File unchanged: true") && screen.includes("console.log('skip')"));
    expect(script).toContain("Active command: bun test");
    // The original script is still protected after the session command changes.
    await Bun.sleep(350);
    tmux("send-keys", "-t", "checks", "Enter");
    const end = await wait(screen => screen.includes("Terminal check complete"));
    expect(end).toContain("Script change declined");
    expect(await readFile(path.join(root, ".casper/project.yaml"), "utf8")).toBe(original);
    expect(await readFile(path.join(root, ".casper/quick-test.ts"), "utf8")).toContain("real check");
  } finally { tmux("kill-server"); await removeTempDir(temp); }
}, 90_000);
