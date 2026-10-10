import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeEventView } from "../src/app/events";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import type { RuntimeEvent } from "../src/runtime/types";
import { inlineDiff, nextDisplay, type DisplayLevel } from "../src/tui/display";
import { GLYPHS } from "../src/tui/glyphs";
import { renderFold, type FoldView, type InteractiveTerminal } from "../src/tui/terminal";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
// A box's top-left corner as this terminal draws it: square on the old Windows console.
const [CORNER] = GLYPHS.corners;
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function view(rich: boolean, level: DisplayLevel, homeDir?: string) {
  const screen: string[] = [];
  const terminal = {
    rich, columns: 100, questionsShown: 0, questionOpen: false,
    setWork() {}, endAssistant() {}, assistant() {},
    write(value: string) { screen.push(...value.split("\n").filter(Boolean)); },
    writeFold(fold: FoldView) { screen.push(...renderFold(fold, 100, false, false)); },
  };
  const events = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write: value => terminal.write(value) }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    projectRoot: () => "/work/app", display: () => level, ...(homeDir ? { homeDir: () => homeDir } : {}),
  });
  return { events, screen, handle: (...list: RuntimeEvent[]) => { for (const event of list) events.handle(event); } };
}

test("a read outside the project shows ~ for the session's home, not the real one", () => {
  const s = view(false, "normal", "/session/home");
  const input = { path: "/session/home/notes/a.txt" };
  s.handle({ type: "tool_start", toolName: "read", toolCallId: "1", input }, { type: "tool_end", toolName: "read", toolCallId: "1", input, isError: false },
    { type: "message_end" });
  expect(s.screen.filter(line => line.startsWith("[read]"))).toEqual(["[read] outside this project: ~/notes"]);
});

const PATCH = "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export const a = 1;\n-export const b = 2;\n+export const b = 3;\n";
const work: RuntimeEvent[] = [
  { type: "tool_start", toolName: "read", toolCallId: "1", input: { path: "src/math.ts" } },
  { type: "tool_end", toolName: "read", toolCallId: "1", input: { path: "src/math.ts" }, isError: false },
  { type: "tool_start", toolName: "edit", toolCallId: "2", input: { path: "src/math.ts" } },
  { type: "tool_end", toolName: "edit", toolCallId: "2", input: { path: "src/math.ts" }, isError: false, lines: { added: 1, removed: 1 }, diff: PATCH },
  { type: "tool_start", toolName: "bash", toolCallId: "3", input: { command: "bun test" } },
  { type: "tool_end", toolName: "bash", toolCallId: "3", input: { command: "bun test" }, isError: true, output: { text: "1 fail", truncated: false } },
  { type: "message_end" },
];

/** A box's rows without the frame: what it says. */
const inside = (screen: string[]) => screen.map(line => line.replace(/^│ ?|│$/g, "").trimEnd());

test("normal folds steps into one row naming them, the edit into a box with its diff, and the failure into a box", () => {
  const s = view(true, "normal");
  s.handle(...work);
  expect(s.screen[0]).toBe("● read src/math.ts");
  expect(s.screen[1]).toStartWith(`${CORNER}─ Edited 1 file ─`);
  expect(inside(s.screen.slice(2, 5))).toEqual(["src/math.ts  +1 -1", "  - export const b = 2;", "  + export const b = 3;"]);
  expect(s.screen[6]).toStartWith(`${CORNER}─ ✗ bash · bun test — failed ─`);
  expect(inside([s.screen[7]!])).toEqual(["1 fail"]);
  // The plain terminal keeps one line per step.
  const plain = view(false, "normal");
  plain.handle(...work);
  expect(plain.screen.filter(line => /^[✓✗]/.test(line)).map(line => line.split(" · ")[0])).toEqual(["✓ read", "✓ edit", "✗ bash"]);
});

test("quiet shows failures only, on the rich and the plain terminal", () => {
  const rich = view(true, "quiet");
  rich.handle(...work);
  expect(rich.screen[0]).toStartWith(`${CORNER}─ ✗ bash · bun test — failed ─`);
  expect(rich.screen.join("\n")).not.toMatch(/read|Edited|✓/);
  const plain = view(false, "quiet");
  plain.handle(...work);
  expect(plain.screen.filter(line => /^[✓✗•]/.test(line)).map(line => line.slice(0, 17))).toEqual(["✗ bash · bun test"]);
});

test("detailed shows every step and every edit's diff", () => {
  for (const rich of [true, false]) {
    const s = view(rich, "detailed");
    s.handle(...work);
    const text = s.screen.join("\n");
    expect(text).toContain("✓ read · src/math.ts");
    if (rich) expect(inside(s.screen.slice(2, 5))).toEqual(["src/math.ts  +1 -1", "  - export const b = 2;", "  + export const b = 3;"]);
    else expect(text).toContain("✓ edit · src/math.ts · +1 -1\n    - export const b = 2;\n    + export const b = 3;");
    expect(text).toContain("✗ bash · bun test");
  }
});

test("ctrl+t expands the last finished step: an edit's whole diff, a command's output", () => {
  const s = view(true, "normal");
  s.handle(...work.slice(0, 4));
  expect(s.events.lastStep()).toEqual({ title: "edit · src/math.ts", body: PATCH, diff: true });
  s.handle(...work.slice(4));
  expect(s.events.lastStep()).toEqual({ title: "bash · bun test · failed", body: "1 fail", diff: false });
});

test("the inline diff keeps the changed lines only, at most twelve, then says how many more", () => {
  expect(inlineDiff(PATCH)).toEqual(["    - export const b = 2;", "    + export const b = 3;"]);
  const big = `@@ -1,20 +1,20 @@\n${Array.from({ length: 20 }, (_, i) => `+line ${i}`).join("\n")}`;
  const shown = inlineDiff(big);
  expect(shown.length).toBe(13);
  // Ctrl+T shows only the last step (and the plain terminal has none): /diff after the task has them all.
  expect(shown.at(-1)).toBe("    … 8 more lines · /diff after the task shows them all");
});

test("/details with no word goes round quiet, normal, detailed", () => {
  expect(nextDisplay("quiet")).toBe("normal");
  expect(nextDisplay("normal")).toBe("detailed");
  expect(nextDisplay("detailed")).toBe("quiet");
});

test("display: loads from your own config or a profile and is refused in a project file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-display-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper", "profiles", "work"), { recursive: true });
  await mkdir(path.join(project, ".casper"), { recursive: true });
  expect((await loadConfiguration({ projectRoot: project, homeDir: home })).display).toBeUndefined();
  await writeFile(path.join(home, ".casper/config.yaml"), "display: quiet\n");
  const loaded = await loadConfiguration({ projectRoot: project, homeDir: home });
  expect(loaded.display).toBe("quiet");
  expect(loaded.warnings).toEqual([]);
  expect((await loadProjectContext({ root: project } as never, { homeDir: home })).display).toBe("quiet");
  await writeFile(path.join(home, ".casper/profiles/work/config.yaml"), "display: detailed\n");
  expect((await loadConfiguration({ projectRoot: project, homeDir: home, profileName: "work" })).display).toBe("detailed");
  await writeFile(path.join(home, ".casper/config.yaml"), "display: loud\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("display must be quiet, normal or detailed");
  await writeFile(path.join(home, ".casper/config.yaml"), "display: normal\n");
  await writeFile(path.join(project, ".casper/project.yaml"), "display: detailed\n");
  await expect(loadConfiguration({ projectRoot: project, homeDir: home })).rejects.toThrow("display is a user setting");
});

test("a read outside the project gets its own line, once per folder, on the rich and the plain terminal", () => {
  const home = os.homedir();
  for (const rich of [true, false]) {
    for (const level of ["quiet", "normal"] as const) {
      const s = view(rich, level);
      const read = (id: string, toolName: string, input: Record<string, unknown>): RuntimeEvent[] => [
        { type: "tool_start", toolName, toolCallId: id, input }, { type: "tool_end", toolName, toolCallId: id, input, isError: false }];
      s.handle(
        ...read("1", "ls", { path: path.join(home, "Projects") }),
        ...read("2", "read", { path: path.join(home, "Projects", "other", "README.md") }),
        ...read("3", "find", { path: path.join(home, "Projects") }),
        ...read("4", "read", { path: "src/math.ts" }),
        ...read("5", "read", { path: "/work/app/src/a.ts" }),
        ...read("6", "grep", { path: path.join(os.tmpdir(), "scratch") }),
        { type: "message_end" },
      );
      const notes = s.screen.filter(line => line.startsWith("[read]"));
      expect(notes).toEqual(["[read] outside this project: ~/Projects, ~/Projects/other"]);
      // The same folders again later: already said.
      s.handle(...read("7", "ls", { path: path.join(home, "Projects") }), { type: "message_end" });
      expect(s.screen.filter(line => line.startsWith("[read]"))).toHaveLength(1);
    }
  }
});

test("the startup ghost uses the terminal's own text color (bold), so it shows on light and dark themes", async () => {
  const { wordmarkHeader } = await import("../src/tui/banner");
  const lines = wordmarkHeader(true).render(120).join("\n");
  expect(lines).not.toContain("\x1b[1;37m");
  expect(lines).toContain("\x1b[1m");
});
