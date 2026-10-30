import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { privateTmux } from "./support/private-tmux";

const tmux = await privateTmux();
afterAll(async () => { await tmux?.close(); });
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
(tmux ? test : test.skip)("real private tmux: arrow selection, dim approval regions across themes, NO_COLOR and 80/160/202-column boxes", async () => {
  const { run } = tmux!;
  const capture = () => run("capture-pane", "-e", "-p", "-t", "screen:0.0");
  const until = async (text: string) => {
    let output = "";
    for (let i = 0; i < 200; i++) { output = await capture(); if (Bun.stripANSI(output).includes(text)) return output; await Bun.sleep(50); }
    throw new Error(`Missing ${text} in private fixture screen: ${Bun.stripANSI(output)}`);
  };
  try {
    for (const { color, highContrast } of [{ color: true, highContrast: false }, { color: true, highContrast: true }, { color: false, highContrast: true }]) {
      const fixture = path.join(import.meta.dir, "fixtures/box-polish-tmux.ts");
      const command = `${color ? "env -u NO_COLOR" : "env NO_COLOR=1"} ${quote(process.execPath)} ${quote(fixture)}${highContrast ? " --high-contrast" : ""}`;
      await run("new-session", "-d", "-s", "screen", "-x", "202", "-y", "40", command);
      const wide = await until("4. Yes to everything this session");
      // Short rows: nothing beside them, and no hint under an approval.
      expect(Bun.stripANSI(wide)).not.toContain("the command does not run");
      expect(Bun.stripANSI(wide)).not.toContain("Enter to choose");
      expect(Bun.stripANSI(wide)).toContain("❯ 1. No");
      expect(Bun.stripANSI(wide)).toContain("✗ 1 of 130 tests failed");
      expect(Bun.stripANSI(wide)).toContain("(fail) validates input");
      expect(Bun.stripANSI(wide)).not.toContain("(pass) case");
      expect(Bun.stripANSI(wide)).toContain("│ printf first");
      expect(Bun.stripANSI(wide)).toContain("The model says: Check the result.");
      expect(Bun.stripANSI(wide)).not.toContain("Earlier context");
      expect(Bun.stripANSI(wide)).not.toMatch(/^\s*\?\s*$/m);
      expect(Bun.stripANSI(wide).indexOf("✓ read")).toBeLessThan(Bun.stripANSI(wide).indexOf("── Approval"));
      expect(Bun.stripANSI(wide).split("\n").find(row => row.includes("── Approval"))!.trimEnd().length).toBe(122);
      if (color) {
        if (!highContrast) {
          expect(wide).toMatch(/\x1b\[2m[^\n]*The model says: Check the result/);
          expect(wide).toMatch(/\x1b\[2m[^\n]*path not found/);
        }
        for (const region of ["╭─ Command"]) {
          expect(wide).toMatch(new RegExp(`\\x1b\\[(?:0;)?2m[^\\n\\x1b]*${region}`));
        }
        expect(wide).toMatch(/\x1b\[(?:36|96)m❯/);
        // A failed step is amber while the AI works (decision 23); red is kept for the result.
        expect(wide).toMatch(/\x1b\[(?:33|93)m[^\n]*✗ 1 of 130 tests failed/);
        expect(wide).not.toMatch(/\x1b\[(?:31|91)m[^\n]*✗ 1 of 130 tests failed/);
      } else expect(wide).not.toMatch(/\x1b\[[\d;]*m/);
      await run("resize-window", "-t", "screen:0", "-x", "160", "-y", "40");
      await Bun.sleep(350);
      const medium = await until("4. Yes to everything this session");
      expect(Bun.stripANSI(medium).split("\n").every(row => visibleWidth(row) <= 160)).toBe(true);
      await run("resize-window", "-t", "screen:0", "-x", "80", "-y", "40");
      await Bun.sleep(350);
      await run("send-keys", "-t", "screen:0.0", "Down");
      const narrow = await until("❯ 2. Yes, this once");
      expect(Bun.stripANSI(narrow).split("\n").every(row => visibleWidth(row) <= 80)).toBe(true);
      // The real guard ignores stale keys only in the first 300 ms after the box appeared.
      await Bun.sleep(350); await run("send-keys", "-t", "screen:0.0", "Enter");
      await until("Fixture answer: Yes, this once");
      await run("kill-session", "-t", "screen");
    }
  } finally { await run("kill-session", "-t", "screen").catch(() => {}); }
}, 60000);
