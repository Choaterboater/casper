import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./support/temp-dir";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

test.skipIf(!hasTmux)("real tmux: /plan panel and choices at 80 columns, Ctrl+G editor and plain-word changes round-trip", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "casper-plan-tmux-"));
  const socket = path.join(temp, "sock"), project = path.join(temp, "project"), home = path.join(temp, "home");
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const capture = () => tmux("capture-pane", "-p", "-t", "plan", "-S", "-300").stdout;
  const wait = async (match: (text: string) => boolean) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { const text = capture(); if (match(text)) return text; await Bun.sleep(50); }
    throw new Error(`terminal did not match:\n${capture()}`);
  };
  try {
    await mkdir(project); await mkdir(home);
    await writeFile(path.join(project, "app.ts"), "export {};\n");
    const editor = path.join(temp, "editor.ts");
    await writeFile(editor, 'const file = process.argv[2]!; const text = await Bun.file(file).text(); await Bun.write(file, text.replace("A cleaner, animated header", "A hand-edited header"));');
    const runner = path.join(import.meta.dir, "fixtures/plan-terminal.ts");
    const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
    const command = `env -u NO_COLOR TERM=xterm-256color VISUAL=${quote(`${JSON.stringify(process.execPath)} ${JSON.stringify(editor)}`)} ${quote(process.execPath)} ${quote(runner)} ${quote(project)} ${quote(home)}`;
    expect(tmux("new-session", "-d", "-s", "plan", "-x", "80", "-y", "55", command).status).toBe(0);
    await wait(text => text.includes("idle"));
    tmux("send-keys", "-t", "plan", "-l", "/plan make the existing header cleaner and animated"); tmux("send-keys", "-t", "plan", "Enter");
    const screen = await wait(text => text.includes("Build this plan?") && text.includes("waiting for you"));
    expect(screen).toContain("╭─ Plan · A cleaner, animated header");
    expect(screen).toContain("Ctrl+T details · Ctrl+G edit");
    for (const text of ["Goal", "What I found", "What you'll see", "Steps", "Done means", "1. Stop", "2. Build", "3. Change the plan", "▄▄███▄▄  CASPER"]) expect(screen).toContain(text);
    const frame = screen.split("\n").filter(row => /^[╭│╰]/.test(row));
    expect(frame.every(row => Bun.stringWidth(row.trimEnd()) === 80)).toBe(true);
    const body = frame.map(row => row.slice(3, -3).trimEnd());
    for (const start of ["  - The header lives", "  - Should the reduced-motion"]) {
      const bullet = body.findIndex(row => row.startsWith(start));
      expect(bullet).toBeGreaterThan(0);
      expect(body[bullet + 1]).toMatch(/^ {4}\S/);
    }
    const art = body.findIndex(row => /^  ┌─+┐$/.test(row));
    expect(art).toBeGreaterThan(body.findIndex(row => row.includes("A brief fade-in reveals")));
    expect(body[art + 1]).toContain("│ ▄▄███▄▄  CASPER");
    expect(frame.find(row => row.includes("Draw the header in the accent colour"))).toEndWith("src/tui/banner.ts  │");
    expect(body.findIndex(row => row.includes("The renderer already keeps"))).toBeLessThan(body.findIndex(row => row === "Open questions"));
    await Bun.sleep(350); // Real input guard: keys typed before the box appeared cannot answer it.
    tmux("send-keys", "-t", "plan", "C-g");
    const edited = await wait(text => text.includes("╭─ Plan · A hand-edited header") && text.includes("Build this plan?"));
    expect(edited).toContain("3. Change the plan");
    await Bun.sleep(350);
    tmux("send-keys", "-t", "plan", "3");
    await wait(text => text.includes("What should change?") && text.replace(/\s+/g, " ").includes("Esc stops without building"));
    tmux("send-keys", "-t", "plan", "-l", "make it quieter"); tmux("send-keys", "-t", "plan", "Enter");
    await wait(text => text.includes("╭─ Plan · A revised header") && text.includes("Build this plan?"));
    await Bun.sleep(350);
    tmux("send-keys", "-t", "plan", "Enter");
    const stopped = await wait(text => text.includes("Stopped without building.") && text.includes("idle"));
    expect(stopped).not.toContain("Building the plan");
  } finally { tmux("kill-server"); await removeTempDir(temp); }
}, 60_000);
