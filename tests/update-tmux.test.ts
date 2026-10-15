import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { visibleWidth } from "@earendil-works/pi-tui";
import { removeTempDir } from "./support/temp-dir";

const INSTALLED = "✔ Update installed · restart to use it";
const SHORT = "✔ restart to update";

// Never reach an existing server: every invocation names a random private socket, with a throwaway HOME.
const tmux = process.platform === "win32" ? null : Bun.which("tmux");
test.skipIf(!tmux)("the real notice row stays above the prompt in a private tmux, idle/working, NO_COLOR and narrow", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-notice-tmux-"));
  const server = `casper-update-${randomUUID()}`;
  const env = { PATH: process.env.PATH, HOME: home, TERM: "xterm-256color", NO_COLOR: "1" };
  const call = (...args: string[]) => Bun.spawnSync([tmux!, "-L", server, "-f", os.devNull, ...args], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
  const run = (...args: string[]) => {
    const result = call(...args);
    if (result.exitCode !== 0) throw new Error(`private tmux: ${result.stderr}`);
    return result.stdout.toString();
  };
  const capture = () => run("capture-pane", "-p", "-t", "notice:0.0").split("\n");
  const wait = async (predicate: (lines: string[]) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const lines = capture();
      if (predicate(lines)) return lines;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`private tmux did not draw the notice:\n${capture().join("\n")}`);
  };
  const script = path.join(home, "notice.ts");
  await writeFile(script, `
import { TerminalSurface } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/tui/surface.ts"))};
const surface = new TerminalSurface({ input: process.stdin, output: process.stdout, color: !process.env.NO_COLOR, onEOF() {} }, () => {}, () => {});
surface.start();
surface.setStatus("fixture │ idle", process.cwd());
surface.setUpdate(${JSON.stringify(INSTALLED)});
if (process.argv[2] === "work") surface.setWork({ rows: ["• read · fixture.ts"], status: "Reading fixture.ts" });
setInterval(() => {}, 1000);
`);
  try {
    for (const mode of ["idle", "work"]) {
      run("new-session", "-d", "-s", "notice", "-x", "80", "-y", "24", process.execPath, script, mode);
      const lines = await wait(lines => lines.some(line => line.includes(INSTALLED)));
      const row = lines.findIndex(line => line.includes(INSTALLED));
      expect(lines[row]).toBe(" ".repeat(80 - visibleWidth(INSTALLED)) + INSTALLED);
      expect(lines[row + 1]).toMatch(/^─+$/);
      expect(lines[row + 2]).toContain("❯");
      expect(lines.filter(line => line.includes(INSTALLED))).toHaveLength(1);
      expect(lines[row + 4]).toContain(mode === "idle" ? "fixture │ idle" : "fixture");
      if (mode === "work") expect(lines[row - 1]).toContain("Reading fixture.ts");
      run("resize-window", "-t", "notice", "-x", "30", "-y", "24");
      const narrow = await wait(lines => lines.some(line => line.includes(SHORT)));
      expect(narrow.find(line => line.includes(SHORT))).toBe(" ".repeat(30 - visibleWidth(SHORT)) + SHORT);
      run("resize-window", "-t", "notice", "-x", "10", "-y", "24");
      await wait(lines => !lines.some(line => line.includes("✔")));
      run("kill-session", "-t", "notice");
    }
  } finally { call("kill-server"); await removeTempDir(home); }
}, 30_000);
