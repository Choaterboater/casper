import { afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { privateTmux } from "./support/private-tmux";

const INSTALLED = "✔ Update installed · restart to use it";
const SHORT = "✔ restart to update";

// Probe startup, not just installation. Unsupported hosts report a real skip, never a false pass.
const tmux = await privateTmux({ env: { NO_COLOR: "1" } });
afterAll(async () => { await tmux?.close(); });
test.skipIf(!tmux)("the real notice row stays above the prompt in a private tmux, idle/working, NO_COLOR and narrow", async () => {
  const { home, run } = tmux!;
  const capture = async () => (await run("capture-pane", "-p", "-t", "notice:0.0")).split("\n");
  const wait = async (predicate: (lines: string[]) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const lines = await capture();
      if (predicate(lines)) return lines;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`private tmux did not draw the notice:\n${(await capture()).join("\n")}`);
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
  for (const mode of ["idle", "work"]) {
    await run("new-session", "-d", "-s", "notice", "-x", "80", "-y", "24", process.execPath, script, mode);
    const lines = await wait(lines => lines.some(line => line.includes(INSTALLED)));
    const row = lines.findIndex(line => line.includes(INSTALLED));
    expect(lines[row]).toBe(" ".repeat(80 - visibleWidth(INSTALLED)) + INSTALLED);
    expect(lines[row + 1]).toMatch(/^─+$/);
    expect(lines[row + 2]).toContain("❯");
    expect(lines.filter(line => line.includes(INSTALLED))).toHaveLength(1);
    expect(lines[row + 4]).toContain("fixture");
    if (mode === "idle") expect(lines[row + 4]).toStartWith("idle ");
    if (mode === "work") expect(lines[row - 1]).toContain("Reading fixture.ts");
    await run("resize-window", "-t", "notice", "-x", "30", "-y", "24");
    const narrow = await wait(lines => lines.some(line => line.includes(SHORT)));
    expect(narrow.find(line => line.includes(SHORT))).toBe(" ".repeat(30 - visibleWidth(SHORT)) + SHORT);
    await run("resize-window", "-t", "notice", "-x", "10", "-y", "24");
    await wait(lines => !lines.some(line => line.includes("✔")));
    await run("kill-session", "-t", "notice");
  }
}, 30_000);
