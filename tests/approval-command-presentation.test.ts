import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { CasperApp } from "../src/app";
import { githubLoginQuestion, reachQuestion, runtimeShell, SHELL_DECLINED, shellQuestion, shownCommand } from "../src/app/sandbox";
import { NO, SHELL_COMMAND_CHOICES, YES_SESSION } from "../src/app/safe-choices";
import { sandboxHost } from "../src/app/wiring";
import { ShellSandbox } from "../src/sandbox/manager";
import { remoteTargets } from "../src/sandbox/remote";
import { SandboxStore } from "../src/sandbox/store";
import { toolReason, withToolReason } from "../src/runtime/tool-reason";
import { tint } from "../src/tui/format";
import { renderPanel } from "../src/tui/presentation";
import { InteractiveTerminal, styleLine } from "../src/tui/terminal";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";
import { interactiveTerminal } from "./support/tty";
import { waitUntil } from "./support/wait";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempDir)); });

test("Casper's question stays first even when the model calls a destructive command just reading files", () => {
  expect(shellQuestion("rm -rf build", "just reading files").split("\n")[0]).toBe("Run this command?");
});

test("the preceding last sentence is labelled as the model's words after Casper's question", () => {
  expect(shellQuestion("custom-tool --check", "Earlier context.\n\nCheck the generated output.\n\n"))
    .toBe("Run this command?\nThe model says: Check the generated output.\ncustom-tool --check");
  expect(shellQuestion("custom-tool --check", " \n\t")).toBe("Run this command?  custom-tool --check");
});

test("multiline commands preserve indentation, blank lines and heredoc boundaries", () => {
  const command = "python - <<'PY'\nif True:\n    print('first')\n\n    print('second')\nPY";
  expect(shownCommand(command)).toBe(command);
  expect(shellQuestion(command, "Run the small reproduction.")).toBe(`Run this command?\nThe model says: Run the small reproduction.\n${command}`);
  expect(shellQuestion(command)).toBe(`Run this command?\n${command}`);
  expect(shownCommand(command.replaceAll("\n", "\r\n") + "\r\n")).toBe(command);
});

test("previews keep the head and tail with the exact number omitted, including blank lines", () => {
  const lines = Array.from({ length: 15 }, (_, index) => index === 13 ? "" : `step ${index + 1}`);
  expect(shownCommand(lines.slice(0, 12).join("\n"))).toBe(lines.slice(0, 12).join("\n"));
  expect(shownCommand(lines.slice(0, 13).join("\n"))).toBe(`${lines.slice(0, 8).join("\n")}\n… 2 more lines\n${lines.slice(10, 13).join("\n")}`);
  expect(shownCommand(lines.join("\n"))).toBe(`${lines.slice(0, 8).join("\n")}\n… 4 more lines\n${lines.slice(-3).join("\n")}`);
});

test("both reason and command hide typed secrets and terminal controls", () => {
  const question = shellQuestion("custom-tool --password 'fixture-command-password'\nnext-step\u001b[2J", "Use password=fixture-reason-password\u001b[31m");
  expect(question).not.toContain("fixture-command-password");
  expect(question).not.toContain("fixture-reason-password");
  expect(question).not.toContain("\u001b");
  expect(question).toMatch(/secret hidden/);
  expect(question).toContain("\nnext-step");
});

test("a reason never replaces the remote target or GitHub login consent", () => {
  const command = "ssh user@192.0.2.10 uptime";
  const target = remoteTargets(command, path.join(process.cwd(), "fixture-home"))[0]!;
  expect(reachQuestion(target, command, "Check the remote clock.")).toBe(`Reach 192.0.2.10?\nThe model says: Check the remote clock.\n${command}`);
  expect(githubLoginQuestion("git fetch origin", "Refresh the remote branches."))
    .toBe("Run outside the sandbox with your GitHub login?\nThe model says: Refresh the remote branches.\ngit fetch origin");
});

async function fixture(terminal: unknown, preceding: string) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-approval-presentation-")));
  roots.push(base);
  const project = path.join(base, "project"), home = path.join(base, "home");
  await mkdir(project); await mkdir(home);
  const app = { interactive: true, closing: false, planning: false, approvalQueue: Promise.resolve(), terminal,
    responseText: preceding, projectContext: { routineCommands: false }, output: { write() {} } } as unknown as CasperApp;
  const host = sandboxHost(app);
  const store = new SandboxStore(path.join(base, "state"));
  const sandbox = new ShellSandbox({ root: () => project, home, store, offByDefault: true,
    engine: fakeEngine(), platform: "linux", problem: () => undefined, tempDirs: [] });
  const shell = runtimeShell(host, sandbox, store);
  return { app, shell, sandbox };
}

test("a tool's reason survives the approval queue; presentation never changes the remembered command", async () => {
  const asked: string[] = [];
  const terminal = { canAsk: true, pick: async (question: string) => { asked.push(question); return YES_SESSION; } };
  const { app, shell, sandbox } = await fixture(terminal, "Some context.\nValidate the custom output.");
  const { promise, resolve } = Promise.withResolvers<void>();
  app.approvalQueue = promise;
  const command = Array.from({ length: 15 }, (_, index) => `custom-tool step-${index}`).join("\n");
  try {
    const approval = withToolReason("Validate the custom output.", () => shell.approve!(command));
    app.responseText = "A later response must not title this box.";
    resolve();
    expect(await approval).toBeUndefined();
    expect(asked).toEqual([shellQuestion(command, "Validate the custom output.")]);
    expect(await shell.approve!(command)).toBeUndefined();
    expect(asked).toHaveLength(1);
    // An unseen tail differs: the truncated preview is never used as an approval key.
    expect(await shell.approve!(`${command}\ncustom-tool different-tail`)).toBeUndefined();
    expect(asked).toHaveLength(2);
    // Outside a tool context, even a nonempty response must not supply a title.
    expect(await shell.approve!("custom-tool another")).toBeUndefined();
    expect(asked[2]).toBe("Run this command?  custom-tool another");
  } finally { resolve(); await shell.close(); await sandbox.close(); }
});

test("interleaved async tool calls keep their own reason and do not leak it after execution", async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const first = withToolReason("Reason A.", async () => { await promise; return toolReason(); });
  expect(await withToolReason("Reason B.", async () => { await Bun.sleep(0); return toolReason(); })).toBe("Reason B.");
  resolve();
  expect(await first).toBe("Reason A.");
  expect(toolReason()).toBeUndefined();
});

test("the rich numbered box dims the labelled model reason after Casper's question",  async () => {
  const term = process.env.TERM;
  process.env.TERM = "xterm-256color";
  const session = interactiveTerminal();
  if (term === undefined) delete process.env.TERM; else process.env.TERM = term;
  try {
    session.terminal.start();
    const command = Array.from({ length: 15 }, (_, index) => `custom-tool step-${index}`).join("\n");
    const answer = session.terminal.pick(shellQuestion(command, "Check the custom steps."), [...SHELL_COMMAND_CHOICES]);
    expect(await waitUntil(() => Bun.stripANSI(session.screen.output).includes("4. Yes to everything"))).toBe(true);
    const visible = Bun.stripANSI(session.screen.output).replaceAll("\r", "");
    const commandRows = renderPanel("Command", [...command.split("\n").slice(0, 8), "… 4 more lines", ...command.split("\n").slice(-3)], session.screen.writer.columns, false, "muted");
    // At the left edge, nothing beside the command: a mouse copy takes only the command.
    expect(visible).toContain(`\nRun this command?\nThe model says: Check the custom steps.\n${commandRows.join("\n")}\n`);
    expect(session.screen.output).toContain(tint("The model says: Check the custom steps.", "muted", true));
    expect(session.screen.output).not.toContain(tint("The model says: Check the custom steps.", "accent", true));
    // The entire command row, including omitted-line text, padding and border, is one faint span.
    for (const row of commandRows) expect(session.screen.output).toContain(`\x1b[2m${row}\x1b[0m`);
    expect(visible).not.toContain("custom-tool step-10");
    session.input.write("1"); session.input.write("\r");
    expect(await answer).toBe(NO);
  } finally { session.close(); }
});

test("the plain terminal dims the explicitly labelled model reason when colour is enabled", () => {
  const reason = "The model says: just reading files";
  expect(styleLine(reason, true)).toBe(tint(reason, "muted", true));
  expect(styleLine(reason, false)).toBe(reason);
});

test("the plain numbered box displays the title above preserved command lines; Enter remains No", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  let screen = "";
  const terminal = new InteractiveTerminal(input, { isTTY: false, write: (text: string) => { screen += text; return true; } } as never, () => {}, () => {});
  terminal.start();
  const command = "custom-tool <<'END'\n  indented input\nEND";
  const { shell, sandbox } = await fixture(terminal, "Validate the multiline input.");
  try {
    const answer = withToolReason("Validate the multiline input.", () => shell.approve!(command));
    expect(await waitUntil(() => screen.includes("1 No"))).toBe(true);
    expect(screen).toContain(`Run this command?\nThe model says: Validate the multiline input.\n${command}\n  1 No`);
    for (const choice of SHELL_COMMAND_CHOICES) expect(screen).toContain(choice.label);
    input.write("\n");
    expect(await answer).toBe(SHELL_DECLINED);
    expect(screen).toContain(`Run this command? → ${NO}`);
  } finally { terminal.close(); input.destroy(); await shell.close(); await sandbox.close(); }
});
