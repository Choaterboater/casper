import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, HAND_OVER_BUSY, HAND_OVER_CANT, handedOverText, runtimeShell, TERMINAL_CANT_LINE, TERMINAL_RETRY_LINE, type SandboxHost, type TerminalLender } from "../src/app/sandbox";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { casperBashOperations } from "../src/runtime/pi";
import { withoutProviderKeys } from "../src/platform/environment";
import { SandboxStore } from "../src/sandbox/store";
import { forgetSshSecrets, type SshAnswer, type SshLoginHost } from "../src/ssh/login";
import { SUDO_CANT_ASK, SUDO_DECLINED, SUDO_QUESTION, sudoLoginHandler, SudoSessionMemory, usesLocalSudo } from "../src/ssh/sudo";
import { scrubToolOutput } from "../src/secrets/tool-output";
import { typedSecretValues } from "../src/secrets/typed";
import { terminalNeed } from "../src/terminal/needs-terminal";
import { screenTail, type AttachedRun } from "../src/terminal/hand-over";
import { typedRunRequest } from "../src/app/run-words";
import { keepGoingPrompt } from "../src/task/keep-going";
import { fakeEngine } from "./support/sandbox-fakes";
import { POSIX } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * sudo on this computer asks in Casper's hidden box, and a command that needs the person gets Casper's terminal. A fake
 * sudo on the PATH asks the way the real one does with -A (it runs $SUDO_ASKPASS with its prompt); passwords are made up.
 * The commands go through Pi's real local bash, so these are POSIX only, as the ssh ones are (tests/ssh-askpass.test.ts).
 */

const roots: string[] = [];
afterEach(async () => {
  forgetSshSecrets();
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

const viaBash = test.skipIf(!POSIX || process.platform === "win32");
const PASSWORD = "s3cr3t-Sudo!";

async function tempDir(): Promise<string> {
  // Short: a Unix socket's path is limited to about 100 characters.
  const dir = await realpath(await mkdtemp(process.platform === "win32" ? path.join(os.tmpdir(), "casper-sudo-") : "/tmp/cs-"));
  roots.push(dir);
  return dir;
}

function typing(answers: Array<SshAnswer | undefined>, canType = true) {
  const asked: Array<{ question: string; label: string; canKeep: boolean }> = [];
  const value: SshLoginHost = { canTypePrivately: () => canType, ask: async (ask) => { asked.push(ask); return answers.shift(); }, write: () => {} };
  return { value, asked };
}

function lender(can = true) {
  const notes: string[] = [];
  const value: TerminalLender = { can: () => can, lend: async (note, run) => { notes.push(note); return run(); } };
  return { value, notes };
}

interface WorldOptions { sudo?: SshLoginHost | null; handOver?: TerminalLender | null; answers?: Array<string | undefined>; sudoMode?: "asks" | "cached" }

/** A project with no sandbox, a fake `sudo` on the PATH, and the shell the AI's bash runs through. */
async function world(options: WorldOptions = {}) {
  const base = await tempDir();
  const home = path.join(base, "home"), project = path.join(base, "project"), bin = path.join(base, "bin");
  await mkdir(home); await mkdir(project); await mkdir(bin);
  const sudo = path.join(bin, "sudo");
  // "asks": like a sudo with no cached sign-in; "cached": a NOPASSWD rule or a sudo still signed in (never asks).
  await writeFile(sudo, options.sudoMode === "cached" ? "#!/bin/sh\n[ \"$1\" = -A ] && shift\necho \"sudo ran: $*\"\nexec \"$@\"\n" : [
    "#!/bin/sh",
    // The real sudo refuses -A with -S; a command's own -S (here, alone or bundled) is told apart.
    "for a in \"$@\"; do case \"$a\" in -*S*) [ \"$1\" = -A ] && { echo 'sudo: the -A and -S options may not be used together' >&2; exit 1; }; echo \"sudo -S as asked: $*\"; exit 0;; esac; done",
    "if [ \"$1\" != -A ]; then echo 'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper' >&2; exit 1; fi",
    "shift",
    "if [ -z \"$SUDO_ASKPASS\" ]; then echo 'sudo: no askpass program specified, try setting SUDO_ASKPASS' >&2; exit 1; fi",
    "tries=0",
    "while [ $tries -lt 3 ]; do",
    "  tries=$((tries+1))",
    "  pw=$(\"$SUDO_ASKPASS\" '[sudo] password for casper: ') || { echo 'sudo: no password was provided' >&2; exit 1; }",
    // Compared reversed, so this file never holds the password.
    `  if [ "$(printf %s "$pw" | rev)" = '${[...PASSWORD].reverse().join("")}' ]; then echo "sudo saw: $pw"; exec "$@"; fi`,
    "  echo 'Sorry, try again.' >&2",
    "done",
    "echo 'sudo: 3 incorrect password attempts' >&2; exit 1",
    "",
  ].join("\n"));
  await chmod(sudo, 0o755);
  // A fake ssh too, so the one the PATH finds is never the machine's own (it would really dial the address).
  await writeFile(path.join(bin, "ssh"), "#!/bin/sh\necho \"ssh ran: $*\"\n");
  await chmod(path.join(bin, "ssh"), 0o755);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  const answers = options.answers ?? [];
  const picked: Array<{ question: string; options: string[] }> = [];
  const written: string[] = [];
  const sudoHost = options.sudo === undefined ? typing([{ secret: PASSWORD, keep: "once" }]).value : options.sudo ?? undefined;
  const handOver = options.handOver === undefined ? lender().value : options.handOver ?? undefined;
  const terminal: SandboxHost = {
    canAsk: () => true,
    pick: async (question, choices) => { picked.push({ question, options: choices.map((choice) => choice.label) }); return answers.shift(); },
    write: (text) => { written.push(text); },
    planning: () => false,
    ...(sudoHost ? { sudo: sudoHost } : {}),
    ...(handOver ? { handOver } : {}),
  };
  const sandbox = createSessionSandbox(terminal, context, { root: () => project, home,
    seams: { engine: fakeEngine(), problem: () => undefined, platform: "win32", tempDirs: [], searchPath: bin } });
  const attached: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
  const shell = runtimeShell(terminal, sandbox, new SandboxStore(context.stateDirectory), {
    attach: async (command, _cwd, env) => { attached.push({ command, env }); return { exitCode: 3, tail: "hello from the terminal" }; },
  });
  const inherited = withoutProviderKeys(process.env);
  const env = { ...inherited, PATH: `${bin}${path.delimiter}${inherited.PATH ?? ""}` };
  const operations = casperBashOperations(shell);
  const run = async (command: string) => {
    let raw = "";
    const { exitCode } = await operations.exec(command, project, { onData: (data) => { raw += data.toString("utf8"); }, env, timeout: 60 });
    const scrubber = { scrubText: async (text: string) => ({ text, hidden: 0, kinds: [], netconan: "ok" as const }) };
    const scrubbed = await scrubToolOutput(scrubber as never, "bash", { command }, [raw], undefined, { configs: false });
    return { raw, seen: scrubbed?.texts[0] ?? raw, exitCode };
  };
  return { run, picked, written, home, project, shell, attached, close: () => sandbox.close() };
}

// ---------------------------------------------------------------------------------------------------------------
// sudo on this computer

test("sudo on this computer is told from sudo over ssh, from a word that mentions it, and in pipes and nested shells", () => {
  for (const command of ["sudo apt update", "echo x | sudo tee /etc/hosts", "cd /tmp && sudo -u root ls", "FOO=1 sudo make install", "bash -c 'sudo id'", "env sudo id", "/usr/bin/sudo id"]) {
    expect([command, usesLocalSudo(command)]).toEqual([command, true]);
  }
  for (const command of ["ssh nas sudo apt update", "echo sudo", "grep sudo /etc/group", "man sudo", "ls"]) expect([command, usesLocalSudo(command)]).toEqual([command, false]);
});

viaBash("sudo that needs a password asks (the numbered question, then the box) and runs; the password reaches sudo and never the AI", async () => {
  const box = typing([{ secret: PASSWORD, keep: "once" }]);
  const w = await world({ sudo: box.value, answers: ["Yes, this once"] });
  const command = "sudo printf 'root ok\\n'";
  const result = await w.run(command);
  expect(result.exitCode).toBe(0);
  expect(result.raw).toContain("root ok");
  // Without hiding it the output would hold it (the fake prints what it was given); what the AI reads doesn't.
  expect(result.raw).toContain(`sudo saw: ${PASSWORD}`);
  expect(result.seen).toContain("sudo saw: <secret hidden>");
  expect(result.seen).not.toContain(PASSWORD);
  // The approval box first (sudo always asks), then Casper's own sudo question; nothing else.
  expect(w.picked.map((pick) => pick.question.split(/\s{2}|\n/)[0])).toEqual(["Run this command?"]);
  expect(box.asked).toEqual([{ question: SUDO_QUESTION, label: "[sudo] password for casper:", canKeep: true }]);
  expect(JSON.stringify([w.picked, w.written])).not.toContain(PASSWORD);
  // The private folder (socket and the PATH's sudo) is gone.
  expect(existsSync(path.join(w.home, ".casper", "run")) ? await readdir(path.join(w.home, ".casper", "run")) : []).toEqual([]);
  await w.close();
}, 30_000);

viaBash("a command that puts its own folder first on PATH still reaches the real sudo once, and asks", async () => {
  const box = typing([{ secret: PASSWORD, keep: "once" }, { secret: PASSWORD, keep: "once" }]);
  const w = await world({ sudo: box.value, answers: ["Yes, this once", "Yes, this once"] });
  for (const command of ["PATH=\"/nonexistent:$PATH\" sudo printf 'first ok\\n'", "export PATH=/nonexistent:$PATH; sudo printf 'second ok\\n'"]) {
    const result = await w.run(command);
    expect([command, result.exitCode, result.seen.includes("ok")]).toEqual([command, 0, true]);
  }
  expect(box.asked).toHaveLength(2);
  await w.close();
}, 30_000);

viaBash("a command's own -S (after an option's value, or bundled) is left alone: sudo gets no -A and no box shows", async () => {
  const box = typing([{ secret: PASSWORD, keep: "once" }]);
  const w = await world({ sudo: box.value, answers: ["Yes, this once", "Yes, this once"] });
  for (const command of ["sudo -u root -S printf x", "sudo -kS printf x"]) {
    const result = await w.run(command);
    expect([command, result.exitCode, result.raw]).toEqual([command, 0, expect.stringContaining("sudo -S as asked")]);
  }
  expect(box.asked).toEqual([]);
  await w.close();
}, 30_000);

viaBash("a sudo that is still signed in, or a NOPASSWD rule, never calls the program: no box at all", async () => {
  const box = typing([{ secret: PASSWORD, keep: "once" }]);
  const w = await world({ sudo: box.value, answers: ["Yes, this once"], sudoMode: "cached" });
  const result = await w.run("sudo printf 'root ok\\n'");
  expect(result.exitCode).toBe(0);
  expect(result.raw).toContain("root ok");
  expect(box.asked).toEqual([]);
  await w.close();
}, 30_000);

viaBash("Yes, for this session: the next sudo command doesn't ask again", async () => {
  const box = typing([{ secret: PASSWORD, keep: "session" }]);
  const w = await world({ sudo: box.value, answers: ["Yes, this once", "Yes, this once"] });
  expect((await w.run("sudo printf 'first\\n'")).exitCode).toBe(0);
  const second = await w.run("sudo printf 'second\\n'");
  expect(second.exitCode).toBe(0);
  expect(second.seen).toContain("second");
  expect(second.seen).not.toContain(PASSWORD);
  expect(box.asked).toHaveLength(1);
  await w.close();
}, 30_000);

viaBash("a run with nobody to ask (one-shot, --json, a builder) refuses with a plain line and no box", async () => {
  const box = typing([], false);
  const w = await world({ sudo: box.value, answers: ["Yes, this once"] });
  const result = await w.run("sudo printf 'root ok\\n'");
  expect(result.exitCode).not.toBe(0);
  expect(result.raw).toContain(SUDO_CANT_ASK);
  expect(result.raw).not.toContain("root ok");
  expect(box.asked).toEqual([]);
  expect(SUDO_CANT_ASK).not.toMatch(/yourself|another terminal|outside Casper/);
  await w.close();
}, 30_000);

test("a sudo handler: No gives sudo nothing and isn't asked again in the command; a wrong session password is forgotten and asked for", async () => {
  const never = new AbortController().signal;
  const no = typing(["no"]);
  const handler = sudoLoginHandler(no.value, new SudoSessionMemory());
  expect(await handler("[sudo] password for casper: ", never)).toEqual({ refuse: SUDO_DECLINED });
  expect(await handler("[sudo] password for casper: ", never)).toEqual({ refuse: SUDO_DECLINED });
  expect(no.asked).toHaveLength(1);
  expect(typedSecretValues()).toEqual([]);
  const memory = new SudoSessionMemory();
  memory.set("old-wrong");
  const again = typing([{ secret: PASSWORD, keep: "session" }]);
  const next = sudoLoginHandler(again.value, memory);
  expect(await next("Password:", never)).toEqual({ secret: "old-wrong" });
  expect(await next("Password:", never)).toEqual({ secret: PASSWORD });
  expect(again.asked).toHaveLength(1);
  expect(memory.get()).toBe(PASSWORD);
});

viaBash("a task with no sudo and nothing interactive asks exactly as before: one box per command that changes things, none for reads", async () => {
  const box = typing([{ secret: PASSWORD, keep: "once" }]);
  const handOver = lender();
  const w = await world({ sudo: box.value, handOver: handOver.value, answers: ["Yes, this once", "Yes, this once"] });
  for (const command of ["ls", "cat README.md || true", "touch made.txt", "echo hi > note.txt"]) await w.run(command);
  expect(w.picked.map((pick) => pick.question.split(/\s{2}|\n/)[0])).toEqual(["Run this command?", "Run this command?"]);
  expect(box.asked).toEqual([]);
  expect(handOver.notes).toEqual([]);
  expect(w.attached).toEqual([]);
  await w.close();
}, 30_000);

// ---------------------------------------------------------------------------------------------------------------
// Commands that need the person at the terminal

test("which commands need the terminal: editors, pagers alone, REPLs alone, -it, login flows, y/n installs, ssh -t; remote sudo", () => {
  const interactive = ["vim notes.txt", "nano /etc/hosts", "sudo vim /etc/hosts", "less app.log", "man ls", "top", "htop", "python3", "node",
    "psql mydb", "docker exec -it web sh", "docker run --rm -i -t alpine sh", "kubectl exec -it pod -- sh", "gh auth login", "npm login",
    "docker login", "passwd", "su -", "git rebase -i HEAD~3", "git add -p", "crontab -e", "sudo apt install nginx", "ssh -t 192.0.2.10 top", "aws configure", "tmux attach -t work", "tmux"];
  for (const command of interactive) expect([command, terminalNeed(command)]).toEqual([command, "interactive"]);
  for (const command of ["ssh 192.0.2.10 sudo apt update", "ssh admin@192.0.2.10 'sudo systemctl restart nginx'"]) {
    expect([command, terminalNeed(command)]).toEqual([command, "remote-sudo"]);
  }
  const not = ["ls -la", "man ls | col -b", "cat log | less", "top -l 1", "python3 script.py", "node -e 'console.log(1)'", "psql -c 'select 1' mydb",
    "docker exec web ls", "docker login -u me --password-stdin", "gh auth login --with-token", "sudo apt install -y nginx", "apt list --installed",
    "ssh 192.0.2.10 uptime", "ssh 192.0.2.10", "ssh -o BatchMode=yes 192.0.2.10", "git add -A", "git rebase main", "echo vim", "bun test", "npm test", "sudo systemctl restart nginx", "sqlite3 db.sqlite 'select 1'", "command -v tmux", "command -V bun", "tmux ls", "tmux new -d -s x", "tmux send-keys -t x ls Enter", "screen -ls"];
  for (const command of not) expect([command, terminalNeed(command)]).toEqual([command, undefined]);
});

viaBash("an interactive command gets the terminal right after its usual box, with a one-line note; the AI reads its exit code and last lines", async () => {
  const handOver = lender();
  const w = await world({ handOver: handOver.value, answers: ["Yes, this once"] });
  const result = await w.run("vim notes.txt");
  expect(result.exitCode).toBe(3);
  expect(result.seen).toBe(handedOverText({ exitCode: 3, tail: "hello from the terminal" }));
  expect(w.picked).toHaveLength(1);
  expect(handOver.notes).toEqual(["[terminal] vim notes.txt has the terminal now; Casper comes back when it exits."]);
  expect(w.attached.map((run) => run.command)).toEqual(["vim notes.txt"]);
  await w.close();
}, 30_000);

viaBash("with no box (allowed earlier) it still hands over, and the note says what starts", async () => {
  const handOver = lender();
  const w = await world({ handOver: handOver.value, answers: ["Yes, for this session"] });
  await w.run("vim notes.txt");
  await w.run("vim notes.txt");
  expect(w.picked).toHaveLength(1);
  expect(handOver.notes).toHaveLength(2);
  expect(w.attached).toHaveLength(2);
  await w.close();
}, 30_000);

viaBash("a command that failed for want of a terminal is handed one when the AI sends it again", async () => {
  const handOver = lender();
  const w = await world({ handOver: handOver.value, answers: ["Yes, this once", "Yes, this once"] });
  const command = "echo 'error: the input device is not a TTY' >&2; exit 1";
  const first = await w.run(command);
  expect(first.seen).toContain(TERMINAL_RETRY_LINE);
  expect(w.attached).toEqual([]);
  const second = await w.run(command);
  expect(w.attached.map((run) => run.command)).toEqual([command]);
  expect(second.exitCode).toBe(3);
  await w.close();
}, 30_000);

viaBash("a screen that is busy for a moment is not 'nobody here': the command is told to come again, not that this run can't", async () => {
  const busy: TerminalLender = { can: () => true, lend: async () => { throw new Error("Terminal input is unavailable."); } };
  const w = await world({ handOver: busy, answers: ["Yes, this once"] });
  const result = await w.run("vim notes.txt");
  expect(result.seen).toBe(HAND_OVER_BUSY);
  expect(result.seen).not.toContain(HAND_OVER_CANT);
  await w.close();
}, 30_000);

viaBash("ssh nas sudo …: the terminal is handed over with -t and no password box of Casper's", async () => {
  const box = typing([{ secret: PASSWORD, keep: "once" }]);
  const handOver = lender();
  const w = await world({ sudo: box.value, handOver: handOver.value, answers: ["Yes, this once"] });
  await w.run("ssh admin@192.0.2.10 sudo apt update");
  expect(w.picked[0]!.question).toStartWith("Reach 192.0.2.10?");
  expect(w.attached.map((run) => run.command)).toEqual(["ssh -t admin@192.0.2.10 sudo apt update"]);
  // ssh and sudo there ask at their own prompts: no pointer to Casper's box.
  expect(w.attached[0]!.env.CASPER_ASKPASS_ENDPOINT).toBeUndefined();
  expect(w.attached[0]!.env.SSH_ASKPASS_REQUIRE).not.toBe("force");
  expect(box.asked).toEqual([]);
  await w.close();
}, 30_000);

viaBash("with nobody at a terminal, an interactive command is refused before any box, plainly; a terminal failure says why too", async () => {
  const w = await world({ handOver: null, answers: ["Yes, this once"] });
  await expect(w.run("vim notes.txt")).rejects.toThrow(HAND_OVER_CANT);
  expect(w.picked).toEqual([]);
  const failed = await w.run("echo 'stdin is not a tty' >&2; exit 1");
  expect(failed.seen).toContain(TERMINAL_CANT_LINE);
  for (const line of [HAND_OVER_CANT, TERMINAL_CANT_LINE, TERMINAL_RETRY_LINE]) expect(line).not.toMatch(/yourself|another terminal window|exit Casper/);
  await w.close();
}, 30_000);

test("the tail the AI reads: no colours, cursor moves, overwritten progress or script's own lines; at most 40 lines", () => {
  expect(screenTail("Script started on 2026-10-30\r\n\x1b[1mbold\x1b[0m\r\n10%\r50%\r100%\r\nab\bc\r\nScript done on 2026-10-30\r\n")).toBe("bold\n100%\nac");
  expect(screenTail(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")).split("\n")).toHaveLength(40);
  expect(handedOverText({ exitCode: 0 } as AttachedRun)).toContain("not kept");
});

// ---------------------------------------------------------------------------------------------------------------
// The person's own commands

test("! and 'let me run' run the person's own typed command; pasted, or not naming a program, they are ordinary requests", () => {
  const cwd = process.cwd();
  expect(typedRunRequest("!sudo apt update", [], cwd)).toBe("sudo apt update");
  expect(typedRunRequest("  ! ls -la", [], cwd)).toBe("ls -la");
  expect(typedRunRequest("let me run ls -la", [], cwd)).toBe("ls -la");
  expect(typedRunRequest("I'll run `ls -la`", [], cwd)).toBe("ls -la");
  expect(typedRunRequest("ok, let me run ls", [], cwd)).toBe("ls");
  // Ordinary requests stay requests.
  for (const line of ["let me run the tests", "please run ls", "can you run ls", "!", "let me run", "I ran ls and it failed"]) {
    expect([line, typedRunRequest(line, [], cwd)]).toEqual([line, undefined]);
  }
  // A paste never counts: the whole line, or the words that would make it a command.
  expect(typedRunRequest("let me run ls -la", ["let me run ls -la"], cwd)).toBeUndefined();
  expect(typedRunRequest("let me run ls", ["let me run"], cwd)).toBeUndefined();
  expect(typedRunRequest("!ls", ["!ls"], cwd)).toBeUndefined();
  // Typed words with a pasted command are the person's own.
  expect(typedRunRequest("!ls -la", ["ls -la"], cwd)).toBe("ls -la");
});

test("when the AI stops with work open, Casper's nudge says sudo and prompts run in place, never outside Casper", () => {
  expect(keepGoingPrompt({ items: ["restart nginx with sudo"], next: false }, [])).toContain("sudo and prompts too: Casper asks the person in place, so never send them out of Casper to run one");
});
