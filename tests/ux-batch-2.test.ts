import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { shownCommand, shellQuestion } from "../src/app/sandbox";
import { SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { readOnlyCommand, testRunKey } from "../src/sandbox/read-only";
import { routineCommand } from "../src/sandbox/routine";
import { AgentShellGuard, AGENT_SHELL_GUIDANCE } from "../src/runtime/agent-shell-guard";
import { casperBashOperations } from "../src/runtime/pi";
import { promptEcho } from "../src/tui/surface";
import { readableFooter } from "../src/tui/footer-layout";
import { tint } from "../src/tui/format";
import { formatFooterSpend } from "../src/task/spend";
import { interactiveTerminal } from "./support/tty";
import { removeTempDir } from "./support/temp-dir";
import { RuntimeEventView, type RuntimeEventCallbacks } from "../src/app/events";
import { updateFooter } from "../src/app/footer";
import type { CasperApp } from "../src/app";
import { TaskObservations } from "../src/task/observations";

const callbacks: RuntimeEventCallbacks = { updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false };

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function area() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-ux-")));
  cleanup.push(() => removeTempDir(base));
  const root = path.join(base, "project"), home = path.join(base, "home"), outside = path.join(base, "outside");
  for (const dir of [root, home, outside]) await mkdir(dir);
  await writeFile(path.join(root, "package.json"), '{"scripts":{"check":"tsc"}}');
  await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  return { root, home };
}
function tty(width: number) {
  const previous = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const f = interactiveTerminal();
  if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous;
  f.screen.writer.columns = width; f.screen.writer.rows = 45;
  f.terminal.start(); cleanup.push(() => f.close());
  return f;
}
function rows(f: ReturnType<typeof tty>, width: number) {
  return (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(width);
}

test("command previews retain eight head lines, three tail lines and every consequential middle line", () => {
  const lines = Array.from({ length: 30 }, (_, at) => `printf step-${at + 1}`);
  lines[29] = "git push";
  expect(shownCommand(lines.join("\n"))).toBe([...lines.slice(0, 8), "… 19 more lines", ...lines.slice(-3)].join("\n"));
  for (const risky of ["git push origin branch", "rm file", "del file", "curl https://example.com", "wget https://example.com", "irm https://example.com", "sudo id", "echo x > ../outside", "bun install", "npm ci", "pnpm add pkg", "DEL file", "IRM https://example.com"]) {
    lines[15] = risky;
    const preview = shownCommand(lines.join("\n"));
    expect(preview).toContain(`more lines\n${risky}\n`);
    expect(preview).toEndWith(lines.slice(-3).join("\n"));
  }
});

for (const width of [80, 160]) test(`ANSI approval at ${width} columns keeps the git push tail and risky middle`, async () => {
  const f = tty(width);
  const lines = Array.from({ length: 30 }, (_, at) => `printf step-${at + 1}`);
  lines[15] = "sudo custom-tool"; lines[29] = "git push";
  const answer = f.terminal.pick(shellQuestion(lines.join("\n")), [...SHELL_COMMAND_CHOICES]);
  await f.screen.until(text => text.includes("3. Yes, for this session"));
  const frame = rows(f, width);
  const plain = Bun.stripANSI(frame.join("\n"));
  expect(plain).toContain("git push"); expect(plain).toContain("sudo custom-tool");
  expect(plain.indexOf("sudo custom-tool")).toBeGreaterThan(plain.indexOf("more lines"));
  expect(plain).toContain("step-28"); expect(plain).toContain("step-29");
  expect(frame.find(line => line.includes("git push"))).toContain("\x1b[2m");
  for (const row of frame) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  f.input.write("1"); f.input.write("\r"); await answer;
});

test("allowlisted literal project assignments and set prefixes keep routines and test-session families", async () => {
  const where = await area();
  const key = testRunKey("bun test tests/a.test.ts", where);
  for (const name of ["TMPDIR", "HOME", "GIT_CEILING_DIRECTORIES", "CI", "NO_COLOR"]) {
    for (const value of ['"$PWD/x"', "$PWD/x", "./x", '"./x"']) {
      const command = `${name}=${value} bun test tests/b.test.ts | tail -5`;
      expect({ command, routine: routineCommand(command, where) }).toEqual({ command, routine: true });
      expect(testRunKey(command, where)).toBe(key);
    }
    expect(routineCommand(`${name}="$PWD/x" bun run check`, where)).toBe(true);
  }
  for (const prefix of ["set -o pipefail;", "set -e;", "set -e && set -o pipefail;"]) {
    for (const filter of ["grep pass", "tail -20"]) {
      const command = `${prefix} bun test tests/b.test.ts | ${filter}`;
      expect(routineCommand(command, where)).toBe(true);
      expect(testRunKey(command, where)).toBe(key);
    }
  }
});

test("other variables, expansions, escapes, set options and non-read filters still ask", async () => {
  const where = await area();
  for (const command of [
    'OTHER="$PWD/x" bun test a.test.ts', 'PATH="$PWD/x" bun test a.test.ts',
    'HOME="$HOME/x" bun test a.test.ts', 'HOME="${PWD}/x" bun test a.test.ts',
    'HOME="$(pwd)/x" bun test a.test.ts', "HOME='$PWD/x' bun test a.test.ts",
    'HOME="$PWD/../outside" bun test a.test.ts', 'HOME="$PWD/escape" bun test a.test.ts',
    'HOME="$PWD/x/../../outside" bun test a.test.ts', 'HOME="$PWD/x" custom-tool',
    'HOME="$PWD/x"; bun test a.test.ts', 'set +e; bun test a.test.ts', 'set -x; bun test a.test.ts',
    'set -o pipefail; bun test a.test.ts | sh', 'set -e; bun test a.test.ts | tail ../outside/file',
    'set -e; bun test a.test.ts && curl https://example.com',
  ]) {
    expect({ command, routine: routineCommand(command, where), key: testRunKey(command, where) }).toEqual({ command, routine: false, key: undefined });
  }
});

test("existence tests, literal printf and any bare program's version-only invocation are reads", async () => {
  const where = await area();
  for (const flag of ["-d", "-f", "-e"]) {
    expect(readOnlyCommand(`test ${flag} ./x`, where)).toBe(true);
    for (const file of ["../outside", "escape", ".env", "$HOME/x"]) expect(readOnlyCommand(`test ${flag} ${file}`, where)).toBe(false);
  }
  for (const command of ["printf 'literal text\\n'", 'printf "%s\\n" literal', "custom-tool --version", "custom-tool -V", "pip --version", "npm --version"]) expect(readOnlyCommand(command, where)).toBe(true);
  for (const command of ["custom-tool --version extra", "custom-tool -V extra", "custom-tool --help", "./tool --version", "test -r file", "test -e file extra", "printf -v PATH x", "printf '%n' PATH", 'printf "$HOME"']) expect(readOnlyCommand(command, where)).toBe(false);
});

test("command-line echo renders identically to typed request echo, including glyph and palette", () => {
  for (const width of [80, 160]) {
    const f = tty(width);
    const view = new RuntimeEventView(f.terminal, f.screen.writer, callbacks);
    view.writePrompt("initial request");
    const expected = promptEcho("initial request", true).render(width);
    for (const line of expected) expect(rows(f, width)).toContain(line);
    expect(Bun.stripANSI(expected.join("\n"))).toContain("❯ initial request");
  }
});

test("native bash guard refuses agents before approval/execution, including builders and wrappers", async () => {
  for (const builder of [false, true]) {
    const guard = new AgentShellGuard(builder, () => false);
    guard.task("Fix the project");
    let executed = false;
    const operations = casperBashOperations(undefined, { exec: async () => { executed = true; return { exitCode: 0 }; } }, undefined, guard);
    for (const command of ["claude task", "codex exec task", "pi -p task", "omp task", "cursor-agent task", "casper task", "env CI=1 claude task", "bash -lc 'codex exec task'", "/usr/local/bin/claude task", "npx claude task", "bunx codex exec task", "npm exec claude task", "sudo -u root claude task", "echo $(codex exec task)", "echo \"$(claude task)\"", "timeout 2 codex exec task", "npx --yes claude task", "bunx --bun codex exec task", "npm exec -- claude task", "npx -p example-agent-package claude task", "npx -c 'claude task'"]) {
      await expect(operations.exec(command, process.cwd(), { onData() {}, signal: new AbortController().signal })).rejects.toThrow("does not start another coding agent");
    }
    expect(executed).toBe(false);
    guard.task("Run codex to review this");
    expect(Boolean(guard.reason("codex exec review"))).toBe(builder);
  }
  expect(AGENT_SHELL_GUIDANCE).toContain("Builders too");
});

test("looking an agent up is not starting it: command -v, which, type, --version and --help run", () => {
  const guard = new AgentShellGuard(false, () => false);
  guard.task("Check what is installed");
  for (const command of ["command -v casper; command -v bash", "command -V claude", "which codex", "type -a casper", "whereis claude",
    "casper --version", "casper -v", "claude --help", "codex -h", "hash casper 2>/dev/null"]) expect([command, guard.reason(command)]).toEqual([command, undefined]);
  // Running it is still refused, even after a lookup on the same line.
  for (const command of ["command -v casper && casper task", "command casper task"]) expect(guard.reason(command)).toContain("does not start another coding agent");
});

test("tmux guard owns only successfully created named servers in the current task", () => {
  const guard = new AgentShellGuard(false, name => name === "existing");
  guard.task("Check terminal screens");
  for (const command of ["tmux list-sessions", "tmux capture-pane", "tmux -L other capture-pane", "tmux -S /tmp/socket new-session", "tmux -L existing new-session -d"]) expect(guard.reason(command)).toContain("private tmux -L");
  const start = "tmux -L own new-session -d";
  expect(guard.reason(start)).toBeUndefined();
  guard.finished(start, 1); expect(guard.reason("tmux -L own capture-pane")).toBeDefined();
  guard.finished(start, 0); expect(guard.reason("tmux -L own capture-pane")).toBeUndefined();
  guard.task("Check terminal screens"); expect(guard.reason("tmux -L own kill-server")).toBeUndefined();
  expect(guard.reason("tmux -L own capture-pane -p -S -200")).toBeUndefined();
  expect(guard.reason("tmux -L own -L other capture-pane")).toBeDefined();
  guard.finished("tmux -L own kill-server", 0); expect(guard.reason("tmux -L own capture-pane")).toBeDefined();
  guard.finished(start, 0); guard.task("Another task"); expect(guard.reason("tmux -L own capture-pane")).toBeDefined();
  guard.task("Capture the existing tmux server"); expect(guard.reason("tmux -L existing capture-pane")).toBeUndefined();
  guard.task("Do not launch claude"); expect(guard.reason("claude task")).toBeDefined();
  expect(guard.reason("claude --version")).toBeUndefined();
  guard.task("Do not change git. Run codex to review this"); expect(guard.reason("codex exec review")).toBeUndefined();
  guard.task("Never use codex"); expect(guard.reason("codex exec review")).toBeDefined();
  guard.task("Same words", {}); guard.finished(start, 0);
  guard.task("Same words", {}); expect(guard.reason("tmux -L own capture-pane")).toBeDefined();
});

for (const width of [80, 120, 202]) test(`readable ANSI footer at ${width} columns drops cost, context, model in order`, () => {
  const details = "sample │ provider/model-name · high │ ctx 72%~ │ task sub ≈$10.99";
  const state = tint("⠋ working 5h03m", "accent", true);
  const footer = readableFooter(state, details, width, true, "asking off");
  const plain = Bun.stripANSI(footer);
  expect(plain).toStartWith("⠋ working 5h03m · asking off");
  expect(footer).toContain(tint("asking off", "warning", true));
  expect(plain).not.toMatch(/checklist|building|repair|session|\n/);
  expect(visibleWidth(footer)).toBeLessThanOrEqual(width);
  if (width === 80) { expect(plain).not.toContain("task"); expect(plain).toContain("ctx"); }
  else expect(plain).toContain("task sub ≈$10.99");
  expect(Bun.stripANSI(readableFooter(state, details, 55, true))).not.toContain("ctx");
  expect(Bun.stripANSI(readableFooter(state, details, 30, true))).not.toContain("provider");
});

test("a long model name is shortened in the middle before the task's tokens or the context are dropped", () => {
  const details = "casper/main │ ollama/hf.co/mradermacher/Ornith-1.5-35B-A3B-i1-GGUF:Q3_K_M · high │ ctx 63%~ │ task 41.2k tok";
  for (const width of [80, 100]) {
    const plain = Bun.stripANSI(readableFooter("idle", details, width, true));
    expect(visibleWidth(plain)).toBeLessThanOrEqual(width);
    expect(plain).toContain("│ ctx 63%~ │ task 41.2k tok");
    expect(plain).toMatch(/│ ollama\/hf\.co\S*…\S* · high │/);
  }
  // Wide enough: the whole name; too narrow even for a shortened one: groups drop as before, with the name whole.
  expect(Bun.stripANSI(readableFooter("idle", details, 140, true))).toContain("ollama/hf.co/mradermacher/Ornith-1.5-35B-A3B-i1-GGUF:Q3_K_M · high");
  expect(Bun.stripANSI(readableFooter("idle", details, 70, true))).not.toContain("task");
  // A name already short is never cut.
  expect(Bun.stripANSI(readableFooter("idle", "sample │ provider/model-name · high │ ctx 72%~ │ task $1", 40, true))).not.toContain("…");
});

test("folder and branch are shown only once when their names match", () => {
  let status = "";
  updateFooter({ projectContext: { info: { name: "sample", gitBranch: "sample", root: process.cwd() } },
    homeDir: () => process.cwd(), terminal: { setTitle() {}, setBadge() {}, setUpdate() {}, setStatus(text: string) { status = text; } },
    observations: { spent: () => ({ tokens: 0, cost: 0 }) }, spentBefore: { tokens: 0, cost: 0 },
  } as unknown as CasperApp);
  expect(status).toStartWith("sample │ "); expect(status).not.toContain("sample/sample");
});

test("session-only native check outcomes are quiet notes, not failed or completed edits", () => {
  const f = tty(120);
  const view = new RuntimeEventView(f.terminal, f.screen.writer, callbacks);
  const event = { type: "tool_end" as const, toolName: "edit", input: { path: ".casper/project.yaml" }, isError: false, sessionOnlyCheck: true as const };
  view.handle(event); view.reset();
  const screen = Bun.stripANSI(rows(f, 120).join("\n"));
  expect(screen).toContain("– kept .casper/project.yaml as it is: session-only check in use");
  expect(screen).not.toMatch(/Couldn't edit|✗|Edited/);
  const observations = new TaskObservations();
  observations.observeToolEnd(event, {});
  expect(observations.snapshot(undefined).possibleMutations).toBe(false);
});

test("footer has the task figure, then the session total, and working input carries a dim queue hint", async () => {
  expect(formatFooterSpend({ tokens: 6_400_000, cost: 10.99 }, { tokens: 53_500_000, cost: 90 }, true, true, "subscription")).toBe("task 6.4M tok · sub ≈$10.99 │ session 53.5M tok · sub ≈$90.00");
  expect(formatFooterSpend({ tokens: 12, cost: 0 }, { tokens: 100, cost: 0 }, false, false)).toBe("task 12 tok │ session 100 tok");
  const f = tty(120);
  const pending = f.terminal.readCommand();
  f.input.write("request\r"); await pending;
  f.terminal.setSteps("checklist skipped · building ✓ · checks · repair");
  f.terminal.setStatus("sample │ provider/model · high │ ctx 72%~ │ task $1");
  await f.screen.until(text => text.includes("type to queue a message"));
  expect(f.screen.output).toContain(tint("type to queue a message", "muted", true));
  const footer = Bun.stripANSI(f.terminal.footerLine(120)!);
  expect(footer).toMatch(/working/); expect(footer).not.toMatch(/checklist|building|checks|repair/);
});
