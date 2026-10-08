import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createSessionSandbox, runtimeShell, SSH_BATCH_MODE_LINE, SSH_NOT_STARTED_LINE, type SandboxHost } from "../src/app/sandbox";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { casperBashOperations } from "../src/runtime/pi";
import { withoutProviderKeys } from "../src/platform/environment";
import { SandboxStore } from "../src/sandbox/store";
import { startAskpass, type AskpassHandler } from "../src/ssh/askpass";
import { ASKPASS_ENDPOINT_ENV, ASKPASS_TOKEN_ENV, askpassRequested, promptFromArguments, runAskpassHelper } from "../src/ssh/askpass-helper";
import { forgetSshSecrets, notSshQuestion, parsePrompt, promptKind, sshCantAsk, sshDeclined, sshLoginHandler, sshQuestion, SshSessionMemory, sshUnanswered, sshWrongMachine, type ApprovedMachine, type SshAnswer, type SshLoginHost } from "../src/ssh/login";
import { scrubExactValues } from "../src/secrets/assignments";
import { hideCommandSecrets, scrubPlainSecrets } from "../src/secrets/files";
import { scrubToolOutput } from "../src/secrets/tool-output";
import { trustedProgram } from "../src/sandbox/remote";
import { forgetOnceSecrets, forgetTypedSecrets, rememberTypedSecret, typedSecretValues } from "../src/secrets/typed";
import { checkResultForModel } from "../src/verify/model-output";
import { privatePathCommand } from "../src/platform/project-paths";
import { withLoginDisplay } from "../src/tui/login";
import { fakeEngine } from "./support/sandbox-fakes";
import { withLoginSurface } from "./support/login-surface";
import { needsPosixModes, POSIX, posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

/**
 * The private ssh login: ssh you allowed asks for a password, Casper shows its own hidden box, and what you type goes to
 * ssh and nowhere else. Fixtures use documentation addresses (192.0.2.x) and made-up passwords. Where a test runs a
 * shell script as a fake ssh it goes through Pi's real local bash (Git Bash on Windows); the helper is started as
 * `bun src/cli.ts <prompt>`, the same code a release binary runs, so no .cmd launcher is needed.
 */

const roots: string[] = [];
afterEach(async () => {
  forgetSshSecrets();
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

/**
 * Tests that run a command through Pi's real bash with a fake `ssh` found on the PATH. On Windows that bash is Git Bash,
 * whose own /usr/bin/ssh comes before any folder the test adds (its profile puts /usr/bin first), so the fake would never run:
 * these are POSIX only. The same steps are covered on Windows by the socket, helper, handler and wrap() tests, none of which
 * needs a shell.
 */
const viaBash = test.skipIf(!POSIX);

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const PROMPT = "admin@192.0.2.10's password: ";

async function tempDir(): Promise<string> {
  // Short on macOS and Linux: a Unix socket's path is limited to about 100 characters, and macOS's temp folder is long.
  const dir = await realpath(await mkdtemp(process.platform === "win32" ? path.join(os.tmpdir(), "casper-ssh-login-") : "/tmp/cs-"));
  roots.push(dir);
  return dir;
}

function helperIO() {
  const seen = { out: "", err: "" };
  return { seen, io: { out: async (text: string) => { seen.out += text; }, err: async (text: string) => { seen.err += text; } } };
}

// ---------------------------------------------------------------------------------------------------------------
// The socket (a Unix socket, or a named pipe on Windows) between the helper and Casper

test("the helper gets the answer from Casper over the local socket, whatever it holds: spaces, accents, three characters", async () => {
  const home = await tempDir();
  const asked: string[] = [];
  const handler: AskpassHandler = async (prompt) => { asked.push(prompt); return { secret: secrets.shift()! }; };
  const secrets = ["pässw rd☃ \"q\" 'x'", "x9!", "plain"];
  const run = (await startAskpass(handler, { home, program: "unused" }))!;
  try {
    for (const expected of [...secrets]) {
      const { seen, io } = helperIO();
      expect(await runAskpassHelper([PROMPT], run.env, io)).toBe(0);
      expect(seen).toEqual({ out: `${expected}\n`, err: "" });
    }
    expect(asked).toEqual([PROMPT, PROMPT, PROMPT]);
  } finally { await run.close(); }
});

test("a refusal prints Casper's plain line on the error output and exits 1 with nothing on the output", async () => {
  const home = await tempDir();
  const run = (await startAskpass(async () => ({ refuse: "The user chose not to type it." }), { home, program: "unused" }))!;
  try {
    const { seen, io } = helperIO();
    expect(await runAskpassHelper([PROMPT], run.env, io)).toBe(1);
    expect(seen).toEqual({ out: "", err: "The user chose not to type it.\n" });
  } finally { await run.close(); }
});

test("another program that knows the socket name but not the token gets nothing, and Casper is not even asked", async () => {
  const home = await tempDir();
  let calls = 0;
  const run = (await startAskpass(async () => { calls++; return { secret: "never" }; }, { home, program: "unused" }))!;
  try {
    const { seen, io } = helperIO();
    expect(await runAskpassHelper([PROMPT], { ...run.env, [ASKPASS_TOKEN_ENV]: "0".repeat(48) }, io)).toBe(1);
    expect(seen.out).toBe("");
    // Not even valid JSON: dropped.
    await new Promise<void>((resolve) => {
      const socket = net.connect(run.endpoint, () => socket.write("hello\n"));
      socket.on("error", () => resolve());
      socket.on("close", () => resolve());
    });
    expect(calls).toBe(0);
  } finally { await run.close(); }
});

test("the socket is closed after the run: nothing listens and the private folder is gone", async () => {
  const home = await tempDir();
  const run = (await startAskpass(async () => ({ secret: "x" }), { home, program: "unused" }))!;
  expect(run.dir && existsSync(run.dir)).toBe(true);
  await run.close();
  expect(existsSync(run.dir!)).toBe(false);
  const { seen, io } = helperIO();
  expect(await runAskpassHelper([PROMPT], run.env, io)).toBe(1);
  expect(seen.out).toBe("");
  expect(await readdir(path.join(home, ".casper", "run"))).toEqual([]);
});

needsPosixModes("the socket folder is private to you (0700), the socket 0600, and the folder is on the private-places list", async () => {
  // A short home, so the socket stays under the Unix path limit and lives in ~/.casper/run (a long one falls back to the temp folder).
  const home = await mkdtemp("/tmp/cs-");
  roots.push(home);
  const run = (await startAskpass(async () => ({ secret: "x" }), { home, program: "unused" }))!;
  try {
    expect((await stat(run.dir!)).mode & 0o777).toBe(0o700);
    expect((await stat(run.endpoint)).mode & 0o777).toBe(0o600);
    expect(path.dirname(run.dir!)).toBe(path.join(home, ".casper", "run"));
  } finally { await run.close(); }
});

test("a command that names the socket folder is refused like ~/.ssh, even with the sandbox off", () => {
  const home = os.homedir();
  expect(privatePathCommand("ls ~/.casper/run", { root: path.join(home, "project"), home })).toBeDefined();
  expect(privatePathCommand("cat ~/.casper/run/ask-abc/s", { root: path.join(home, "project"), home })).toBeDefined();
});

test("the environment names the program, forces it, and carries a name and a token, never the password", async () => {
  const home = await tempDir();
  const run = (await startAskpass(async () => ({ secret: "hunter22" }), { home, program: "/opt/casper/askpass" }))!;
  try {
    expect(run.env.SSH_ASKPASS).toBe("/opt/casper/askpass");
    expect(run.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(askpassRequested(run.env)).toBe(true);
    expect(askpassRequested({})).toBe(false);
    expect(JSON.stringify(run.env)).not.toContain("hunter22");
  } finally { await run.close(); }
});

test("Casper started as ssh's askpass program (a separate process) prints the answer; its output is only the answer", async () => {
  const home = await tempDir();
  const run = (await startAskpass(async (prompt) => ({ secret: prompt.includes("passphrase") ? "pässphrase one" : "abc" }), { home, program: "unused" }))!;
  try {
    for (const [prompt, expected] of [[PROMPT, "abc"], ["Enter passphrase for key '/home/user/.ssh/id_ed25519': ", "pässphrase one"]] as const) {
      const child = Bun.spawn([process.execPath, CLI, prompt], { env: { ...process.env, ...run.env }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ out, err, code }).toEqual({ out: `${expected}\n`, err: "", code: 0 });
    }
  } finally { await run.close(); }
}, 30_000);

posixOnly("from a source checkout, the program ssh runs is a launcher that does the same (a .cmd file on Windows is checked by CI only)", async () => {
  const home = await tempDir();
  const run = (await startAskpass(async () => ({ secret: "from-launcher" }), { home }))!;
  try {
    expect(path.basename(run.env.SSH_ASKPASS!)).toBe("askpass.sh");
    expect((await stat(run.env.SSH_ASKPASS!)).mode & 0o777).toBe(0o700);
    const child = Bun.spawn([run.env.SSH_ASKPASS!, PROMPT], { env: { ...process.env, ...run.env }, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("from-launcher\n");
    expect(await child.exited).toBe(0);
  } finally { await run.close(); }
}, 30_000);

test("the prompt ssh passes is read as one line; a launcher's quotes are taken off", () => {
  expect(promptFromArguments([PROMPT])).toBe(PROMPT);
  expect(promptFromArguments([`"${PROMPT}"`])).toBe(PROMPT);
  expect(promptFromArguments(["Enter", "passphrase"])).toBe("Enter passphrase");
});

// ---------------------------------------------------------------------------------------------------------------
// What gets answered

function host(answers: Array<SshAnswer | undefined>, canType = true) {
  const asked: Array<{ question: string; label: string; canKeep: boolean }> = [];
  const value: SshLoginHost = {
    canTypePrivately: () => canType,
    ask: async (ask) => { asked.push(ask); return answers.shift(); },
    write: () => {},
  };
  return { value, asked };
}
const never = new AbortController().signal;

const APPROVED: ApprovedMachine[] = [{ typed: "192.0.2.10", host: "192.0.2.10", user: "admin" }];
const handlerFor = (terminal: { value: SshLoginHost }, memory: SshSessionMemory, approved = APPROVED) => sshLoginHandler(terminal.value, memory, "192.0.2.10", approved);

test("only password and passphrase prompts are answered: a host-key question, a one-time code and a PIN get no secret", async () => {
  for (const prompt of ["Are you sure you want to continue connecting (yes/no/[fingerprint])? ", "Verification code: ", "Enter PIN for ED25519-SK key /home/u/.ssh/id: ", "Touch your security key"]) {
    expect([prompt, promptKind(prompt)]).toEqual([prompt, undefined]);
    const terminal = host([{ secret: "should-not-be-asked", keep: "once" }]);
    const reply = await handlerFor(terminal, new SshSessionMemory())(prompt, never);
    expect(reply).toEqual({ refuse: notSshQuestion });
    expect(terminal.asked).toEqual([]);
  }
  expect(promptKind(PROMPT)).toBe("password");
  expect(promptKind("Password: ")).toBe("password");
  expect(promptKind("(admin@192.0.2.10) Password: ")).toBe("password");
  expect(promptKind("Enter passphrase for key '/home/u/.ssh/id_rsa': ")).toBe("passphrase");
  expect(promptKind("Enter passphrase for /home/u/.ssh/id_rsa:")).toBe("passphrase");
});

test("a prompt is matched by its shape, not by the word password: a server's sentence that mentions one gets no box", async () => {
  for (const prompt of ["Please type your password for gmail: ", "Your password has expired. Enter the password again: ", "Type the passphrase from your bank: ", "Password: yes\nPassword: ",
    "admin@192.0.2.10's password: \nAre you sure (yes/no)? ", "Enter passphrase for key: send it to evil.example", "Old password:"]) {
    expect([prompt, promptKind(prompt)]).toEqual([prompt, undefined]);
    const terminal = host([{ secret: "never", keep: "once" }]);
    expect(await handlerFor(terminal, new SshSessionMemory())(prompt, never)).toEqual({ refuse: notSshQuestion });
    expect(terminal.asked).toEqual([]);
  }
  expect(parsePrompt(PROMPT)).toEqual({ kind: "password", user: "admin", host: "192.0.2.10" });
});

test("a password prompt asks the person in Casper's words, and the answer goes to ssh and is hidden from the AI from then on", async () => {
  const terminal = host([{ secret: "q7!", keep: "once" }]);
  const reply = await handlerFor(terminal, new SshSessionMemory())(PROMPT, never);
  expect(reply).toEqual({ secret: "q7!" });
  expect(terminal.asked).toEqual([{ question: sshQuestion("192.0.2.10", "password"), label: PROMPT.trim(), canKeep: true }]);
  expect(terminal.asked[0]!.question).toBe("ssh to 192.0.2.10 asks for a password. Type it in Casper's hidden box? The AI never sees it.");
  expect(terminal.asked[0]!.question).not.toContain("The AI asks");
  expect(typedSecretValues()).toEqual(["q7!"]);
});

test("No, and no answer at all, give ssh nothing and tell the AI not to ask in chat", async () => {
  const no = host(["no"]);
  expect(await handlerFor(no, new SshSessionMemory())(PROMPT, never)).toEqual({ refuse: sshDeclined("192.0.2.10") });
  expect(sshDeclined("192.0.2.10")).toContain("Don't ask for it in chat");
  const nobody = host([undefined]);
  expect(await handlerFor(nobody, new SshSessionMemory())(PROMPT, never)).toEqual({ refuse: sshUnanswered("192.0.2.10") });
  expect(typedSecretValues()).toEqual([]);
});

test("a run that can't show a hidden box (one-shot, piped input) refuses with a plain line and asks nobody", async () => {
  const terminal = host([{ secret: "x", keep: "once" }], false);
  const reply = await handlerFor(terminal, new SshSessionMemory())(PROMPT, never);
  expect(reply).toEqual({ refuse: sshCantAsk("192.0.2.10") });
  expect(sshCantAsk("192.0.2.10")).toContain("this run can't ask you");
  expect(terminal.asked).toEqual([]);
});

test("Yes, for this session keeps it in memory for that login only; the next command uses it once, and a second ask in one command (it was wrong) asks you again", async () => {
  const memory = new SshSessionMemory();
  const terminal = host([{ secret: "first-pass", keep: "session" }, { secret: "second-pass", keep: "session" }, { secret: "third-pass", keep: "once" }]);
  // Command 1: asked; ssh asks again in the same command (wrong password): asked again, not the remembered one.
  const one = handlerFor(terminal, memory);
  expect(await one(PROMPT, never)).toEqual({ secret: "first-pass" });
  expect(await one(PROMPT, never)).toEqual({ secret: "second-pass" });
  expect(terminal.asked).toHaveLength(2);
  // Command 2: the remembered one goes in without a box.
  const two = handlerFor(terminal, memory);
  expect(await two(PROMPT, never)).toEqual({ secret: "second-pass" });
  expect(terminal.asked).toHaveLength(2);
  // It was wrong this time: ssh asks again in that command, so it is forgotten and you are asked.
  expect(await two(PROMPT, never)).toEqual({ secret: "third-pass" });
  expect(terminal.asked).toHaveLength(3);
  expect(memory.get(parsePrompt(PROMPT)!)).toBeUndefined();
});

test("a remembered password is never given to a prompt for another user or machine, a bare Password:, or a passphrase", async () => {
  const memory = new SshSessionMemory();
  const first = host([{ secret: "kept-pass", keep: "session" }]);
  expect(await handlerFor(first, memory)(PROMPT, never)).toEqual({ secret: "kept-pass" });
  for (const prompt of ["root@192.0.2.10's password: ", "admin@198.51.100.7's password: ", "admin@evil.example's password: "]) {
    const terminal = host([{ secret: "other", keep: "once" }]);
    expect([prompt, await handlerFor(terminal, memory)(prompt, never)]).toEqual([prompt, { refuse: sshWrongMachine("192.0.2.10") }]);
    expect(terminal.asked).toEqual([]);
  }
  // No machine in the prompt: asked, and neither kept nor served from memory.
  const bare = host([{ secret: "bare-1", keep: "session" }, { secret: "bare-2", keep: "once" }]);
  expect(await handlerFor(bare, memory)("Password: ", never)).toEqual({ secret: "bare-1" });
  expect(await handlerFor(bare, memory)("Password: ", never)).toEqual({ secret: "bare-2" });
  expect(bare.asked.map((ask) => ask.canKeep)).toEqual([false, false]);
  // A passphrase: asked every time, "for this session" is not offered.
  const phrase = host([{ secret: "phrase-1", keep: "session" }, { secret: "phrase-2", keep: "once" }]);
  const prompt = "Enter passphrase for key '/home/u/.ssh/id_ed25519': ";
  expect(await handlerFor(phrase, memory)(prompt, never)).toEqual({ secret: "phrase-1" });
  expect(await handlerFor(phrase, memory)(prompt, never)).toEqual({ secret: "phrase-2" });
  expect(phrase.asked.map((ask) => ask.canKeep)).toEqual([false, false]);
  // The user the command named is the one that counts; with none named, the prompt's user is taken.
  const unnamed = host([{ secret: "any-user", keep: "once" }]);
  expect(await handlerFor(unnamed, new SshSessionMemory(), [{ typed: "build-server", host: "198.51.100.20" }])("ops@198.51.100.20's password: ", never)).toEqual({ secret: "any-user" });
});

test("Yes, this once is not kept: the next command asks again", async () => {
  const memory = new SshSessionMemory();
  const terminal = host([{ secret: "one", keep: "once" }, { secret: "two", keep: "once" }]);
  expect(await handlerFor(terminal, memory)(PROMPT, never)).toEqual({ secret: "one" });
  expect(await handlerFor(terminal, memory)(PROMPT, never)).toEqual({ secret: "two" });
  expect(terminal.asked).toHaveLength(2);
  expect(memory.get(parsePrompt(PROMPT)!)).toBeUndefined();
  forgetSshSecrets();
});

test("a run asks at most a few times, so ssh retrying can't keep opening boxes", async () => {
  const terminal = host(Array.from({ length: 10 }, () => "no" as const));
  const handler = handlerFor(terminal, new SshSessionMemory());
  for (let attempt = 0; attempt < 8; attempt++) await handler(PROMPT, never);
  expect(terminal.asked.length).toBe(4);
});

// ---------------------------------------------------------------------------------------------------------------
// The hidden box itself

test("the ssh password box has its own title, takes spaces and accents, shows only a count, and a key box still takes plain ASCII only", async () => {
  const typed = async (text: string, options?: { title?: string; hint?: string; password?: boolean }) => {
    const input = new PassThrough();
    const controller = new AbortController();
    let screen = "";
    const pending = withLoginSurface({ input, output: { write(chunk) { screen += chunk; } }, color: false, onEOF() {} }, (io) => withLoginDisplay(io, controller.signal,
      (display) => display.privateInput("admin@192.0.2.10's password:", undefined, options)));
    pending.catch(() => {});
    try {
      await waitFor(() => screen.includes("password:"));
      input.write(`\x1b[200~${text}\x1b[201~`);
      await Bun.sleep(20);
      input.write("\r");
      const value = await pending.catch((error: Error) => error.message);
      return { value, screen: Bun.stripANSI(screen) };
    } finally { controller.abort(); await pending.catch(() => {}); input.destroy(); }
  };
  const ssh = await typed("pässw rd☃ é", { title: "Enter ssh password", password: true, hint: "It goes to ssh only." });
  expect(ssh.value).toBe("pässw rd☃ é");
  expect(ssh.screen).toContain("Enter ssh password");
  expect(ssh.screen).toContain("It goes to ssh only.");
  expect(ssh.screen).not.toContain("pässw");
  expect(ssh.screen).toContain("characters (hidden)");
  expect((await typed("has space")).value).toBe("Invalid private input");
  expect((await typed("line\nbreak", { password: true })).value).toBe("Invalid private input");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("The box did not appear");
    await Bun.sleep(5);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Hiding what was typed

test("a typed secret of any length is hidden in tool output, command previews, check replies and plain scrubs", () => {
  rememberTypedSecret("x9!");
  rememberTypedSecret("pässw rd☃");
  expect(scrubPlainSecrets("server saw: x9! and pässw rd☃ here").text).toBe("server saw: <secret hidden> and <secret hidden> here");
  expect(hideCommandSecrets("echo x9!").text).toBe("echo <secret hidden>");
  const check = checkResultForModel({ name: "build", ok: false, exitCode: 1, stdout: "got x9!", stderr: "pässw rd☃", durationMs: 1 } as never);
  expect(JSON.stringify(check)).not.toContain("x9!");
  expect(JSON.stringify(check)).not.toContain("pässw rd☃");
});

test("an empty secret hides nothing, and forgetting stops hiding", () => {
  rememberTypedSecret("");
  expect(typedSecretValues()).toEqual([]);
  rememberTypedSecret("abc");
  forgetTypedSecrets();
  expect(scrubPlainSecrets("abc").text).toBe("abc");
});

test("the output the AI reads is scrubbed of a typed secret by the same pass every shell result goes through", async () => {
  rememberTypedSecret("x9!");
  const scrubber = { scrubText: async (text: string) => ({ text, hidden: 0, kinds: [], netconan: "ok" as const }) };
  const result = await scrubToolOutput(scrubber as never, "bash", { command: "ssh admin@192.0.2.10 uptime" }, ["server saw: x9!\n"], undefined, { configs: false });
  expect(result?.texts).toEqual(["server saw: <secret hidden>\n"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Which commands get it: the shell

async function world(options: { ssh?: SshLoginHost | null; on?: boolean; system?: boolean | "project"; sandbox?: "held" | "off"; answers?: Array<string | undefined> } = {}) {
  const base = await tempDir();
  const home = path.join(base, "home"), project = path.join(base, "project"), bin = path.join(base, "bin");
  await mkdir(home); await mkdir(project); await mkdir(bin);
  // A fake ssh: it asks the program ssh would run (SSH_ASKPASS) the way OpenSSH does, and shows what the server "saw".
  const fake = path.join(bin, "ssh");
  await writeFile(fake, [
    "#!/bin/sh",
    "if [ -z \"$CASPER_ASKPASS_ENDPOINT\" ]; then echo \"askpass: none\"; echo \"Permission denied (publickey,password).\"; exit 255; fi",
    "echo \"askpass: set force=$SSH_ASKPASS_REQUIRE\"",
    "reply=$(\"$CASPER_TEST_BUN\" \"$CASPER_TEST_CLI\" \"$FAKE_SSH_PROMPT\")",
    "code=$?",
    "if [ $code -ne 0 ]; then echo \"Permission denied (password).\"; exit 255; fi",
    "echo \"server saw: $reply\"",
    "",
  ].join("\n"));
  await chmod(fake, 0o755);
  // The programs a test command names are fakes too, so none depends on what the machine has installed (sshpass is not
  // on a stock Linux runner).
  const sshpass = path.join(bin, "sshpass");
  await writeFile(sshpass, "#!/bin/sh\nshift 2\nexec \"$@\"\n");
  await chmod(sshpass, 0o755);
  const context = await loadProjectContext(await inspectProject(project), { homeDir: home });
  const answers = options.answers ?? ["Yes, this once"];
  const picked: Array<{ question: string; options: string[] }> = [];
  const written: string[] = [];
  const typing = options.ssh === undefined ? host([{ secret: "x9!", keep: "once" }]).value : options.ssh ?? undefined;
  const terminal: SandboxHost = {
    canAsk: () => true,
    pick: async (question, choices) => { picked.push({ question, options: choices.map((choice) => choice.label) }); return answers.shift(); },
    write: (text) => { written.push(text); },
    planning: () => false,
    ...(typing ? { ssh: typing } : {}),
  };
  const sandbox = createSessionSandbox(terminal, context, { root: () => project, home,
    seams: { engine: fakeEngine(), problem: () => undefined, platform: options.sandbox === "off" ? "win32" : "linux", tempDirs: [],
      // Where the shell finds ssh: the fake's folder (outside the project), the project's own folder, or a folder with none.
      searchPath: options.system === false ? path.join(base, "nobin") : options.system === "project" ? path.join(project, "bin") : bin } });
  // `start` gives ssh a program name without the launcher, which a Windows source checkout doesn't have.
  const shell = runtimeShell(terminal, sandbox, new SandboxStore(context.stateDirectory), {
    ...(options.on === undefined ? {} : { on: () => options.on! }),
    start: (handler, startOptions) => startAskpass(handler, { ...startOptions, program: "casper-askpass" }),
  });
  // Windows spells it Path: a second PATH key would lose to it and the machine's own ssh.exe would run instead of the fake.
  const inherited = withoutProviderKeys(process.env);
  const pathKey = Object.keys(inherited).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const env = { ...inherited, [pathKey]: `${bin}${path.delimiter}${inherited[pathKey] ?? ""}`, CASPER_TEST_BUN: process.execPath, CASPER_TEST_CLI: CLI, FAKE_SSH_PROMPT: PROMPT };
  const operations = casperBashOperations(shell);
  /** Runs a command as the AI's bash tool does and returns the text the model reads, scrubbed like a tool result. */
  const run = async (command: string, extraEnv: Record<string, string> = {}) => {
    let raw = "";
    const { exitCode } = await operations.exec(command, project, { onData: (data) => { raw += data.toString("utf8"); }, env: { ...env, ...extraEnv }, timeout: 60 });
    const scrubber = { scrubText: async (text: string) => ({ text, hidden: 0, kinds: [], netconan: "ok" as const }) };
    const scrubbed = await scrubToolOutput(scrubber as never, "bash", { command }, [raw], undefined, { configs: false });
    return { raw, seen: scrubbed?.texts[0] ?? raw, exitCode };
  };
  return { run, picked, written, home, project, shell, sandbox, close: () => sandbox.close() };
}

for (const sandbox of ["held", "off"] as const) {
  viaBash(`a plain ssh you allowed gets the private login (sandbox ${sandbox}): the password reaches ssh and never the AI, the command, the questions or the saved result`, async () => {
    const w = await world({ sandbox });
    const command = "ssh admin@192.0.2.10 uptime";
    const result = await w.run(command);
    // Without hiding it, the output would hold the password (the fake server prints what it was given).
    expect(result.raw).toContain("askpass: set force=force");
    expect(result.raw).toContain("server saw: x9!");
    expect(result.exitCode).toBe(0);
    // What the model reads (and what the session saves) does not.
    expect(result.seen).toContain("server saw: <secret hidden>");
    expect(result.seen).not.toContain("x9!");
    // Not in the command, the Reach question, or any line Casper wrote.
    expect(command).not.toContain("x9!");
    expect(JSON.stringify(w.picked)).not.toContain("x9!");
    expect(w.written.join("")).not.toContain("x9!");
    expect(w.picked[0]!.question).toBe(`Reach 192.0.2.10?  ${command}`);
    // The socket folder is gone.
    expect(existsSync(path.join(w.home, ".casper", "run")) ? await readdir(path.join(w.home, ".casper", "run")) : []).toEqual([]);
    await w.close();
  }, 30_000);
}

viaBash("a host-key question gets no password and no answer: ssh fails and the AI reads why", async () => {
  const typing = host([{ secret: "x9!", keep: "once" }]);
  const w = await world({ ssh: typing.value });
  const result = await w.run("ssh admin@192.0.2.10 uptime", { FAKE_SSH_PROMPT: "Are you sure you want to continue connecting (yes/no/[fingerprint])? " });
  expect(result.exitCode).toBe(255);
  expect(result.raw).toContain(notSshQuestion);
  expect(result.raw).not.toContain("x9!");
  expect(typing.asked).toEqual([]);
  await w.close();
}, 30_000);

viaBash("a compound, piped, tunnelled or prefixed ssh, and any other command, get no askpass at all", async () => {
  const w = await world({ answers: Array.from({ length: 12 }, () => "Yes, this once") });
  for (const command of [
    "ssh admin@192.0.2.10 uptime | cat", "ssh admin@192.0.2.10 uptime; echo done", "ssh admin@192.0.2.10 uptime && echo done",
    "ssh -L 8080:127.0.0.1:80 admin@192.0.2.10 uptime", "ssh -o ProxyCommand=true admin@192.0.2.10 uptime",
    "FOO=1 ssh admin@192.0.2.10 uptime", "sshpass -p nope ssh admin@192.0.2.10 uptime",
  ]) {
    const result = await w.run(command);
    expect([command, result.raw.includes("askpass: set")]).toEqual([command, false]);
    expect(result.raw).toContain("askpass: none");
  }
  // Not ssh at all: SSH_ASKPASS is not there (a stray one in the environment is not ours to remove, but ours is).
  const other = await w.run("echo \"[${SSH_ASKPASS:-nothing}][${CASPER_ASKPASS_ENDPOINT:-nothing}][${CASPER_ASKPASS_TOKEN:-nothing}]\"");
  expect(other.raw.trim()).toBe("[nothing][nothing][nothing]");
  await w.close();
}, 60_000);

test("Casper's pointer is stripped from the environment of any other command, your own SSH_ASKPASS is left alone", () => {
  const ours = withoutProviderKeys({ PATH: "/bin", SSH_ASKPASS: "/opt/casper", SSH_ASKPASS_REQUIRE: "force", CASPER_ASKPASS_ENDPOINT: "/x/s", CASPER_ASKPASS_TOKEN: "t" });
  expect(ours).toEqual({ PATH: "/bin" });
  expect(withoutProviderKeys({ PATH: "/bin", SSH_ASKPASS: "/usr/bin/my-askpass", SSH_ASKPASS_REQUIRE: "prefer" })).toEqual({ PATH: "/bin", SSH_ASKPASS: "/usr/bin/my-askpass", SSH_ASKPASS_REQUIRE: "prefer" });
});

viaBash("No in the box: ssh fails, the AI is told not to ask in chat, and no secret exists", async () => {
  const typing = host(["no"]);
  const w = await world({ ssh: typing.value });
  const result = await w.run("ssh admin@192.0.2.10 uptime");
  expect(result.exitCode).toBe(255);
  expect(result.raw).toContain(sshDeclined("192.0.2.10"));
  expect(typedSecretValues()).toEqual([]);
  await w.close();
}, 30_000);

viaBash("a one-shot run (no full terminal) refuses with a plain line instead of asking", async () => {
  const typing = host([{ secret: "x9!", keep: "once" }], false);
  const w = await world({ ssh: typing.value });
  const result = await w.run("ssh admin@192.0.2.10 uptime");
  expect(result.exitCode).toBe(255);
  expect(result.raw).toContain("this run can't ask you");
  expect(typing.asked).toEqual([]);
  await w.close();
}, 30_000);

viaBash("a shell with no way to ask at all (a builder's) refuses the same way", async () => {
  const w = await world({ ssh: null });
  const result = await w.run("ssh admin@192.0.2.10 uptime");
  expect(result.raw).toContain("this run can't ask you");
  await w.close();
}, 30_000);

viaBash("ssh_login: off removes the private login: ssh gets no askpass and nothing is asked", async () => {
  const typing = host([{ secret: "x9!", keep: "once" }]);
  const w = await world({ ssh: typing.value, on: false });
  const result = await w.run("ssh admin@192.0.2.10 uptime");
  expect(result.raw).toContain("askpass: none");
  expect(typing.asked).toEqual([]);
  await w.close();
}, 30_000);

viaBash("a command that sets BatchMode=yes keeps it (ssh then never asks); the AI is told why and what to do", async () => {
  const typing = host([{ secret: "x9!", keep: "once" }]);
  const w = await world({ ssh: typing.value, answers: ["Yes, this once", "Yes, this once", "Yes, this once"] });
  for (const command of ["ssh -o BatchMode=yes admin@192.0.2.10 uptime", "ssh -oBatchMode=yes admin@192.0.2.10 uptime"]) {
    const result = await w.run(command);
    expect(result.raw).toContain("askpass: none");
    expect(result.raw).toContain(SSH_BATCH_MODE_LINE);
    expect(result.exitCode).toBe(255);
  }
  expect(typing.asked).toEqual([]);
  // BatchMode=no is the same as nothing.
  expect((await w.run("ssh -o BatchMode=no admin@192.0.2.10 uptime")).raw).toContain("askpass: set");
  await w.close();
}, 60_000);

viaBash("the program never sees the AI's own SSH_ASKPASS: a command can't point ssh's password program elsewhere and keep the box", async () => {
  // A plain ssh the AI sent with its own variable in front is "FOO=1 ssh ...": not alone, no askpass from Casper.
  const w = await world({ answers: ["Yes, this once"] });
  const result = await w.run("SSH_ASKPASS=/tmp/evil ssh admin@192.0.2.10 uptime");
  expect(result.raw).not.toContain("askpass: set");
  expect(result.raw).not.toContain("server saw");
  await w.close();
}, 30_000);

test("the shell's wrap gives the login to nothing that was not approved first", async () => {
  const w = await world();
  // wrap without the question having been answered for this exact command: no login.
  expect((await w.shell.wrap("ssh admin@192.0.2.10 uptime", w.project)).ssh).toBeUndefined();
  await w.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes

/** Open the socket, send raw bytes, and wait until Casper closes it (or `ms` pass). */
function poke(endpoint: string, bytes: string, ms = 3000): Promise<"closed" | "open"> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint, () => { if (bytes) socket.write(bytes); });
    const timer = setTimeout(() => { socket.destroy(); resolve("open"); }, ms);
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(timer); resolve("closed"); });
  });
}

test("a malformed request (null, an array, text, the wrong types, half a line) is dropped and Casper stays up to answer the real one", async () => {
  const home = await tempDir();
  let calls = 0;
  const run = (await startAskpass(async () => { calls++; return { secret: "still-works" }; }, { home, program: "unused", idleMs: 150 }))!;
  try {
    for (const bytes of ["null\n", "[]\n", "\"text\"\n", "42\n", "{}\n", "{\"token\":5,\"prompt\":\"x\"}\n", `{"token":"${run.env[ASKPASS_TOKEN_ENV]}"}\n`, "}{ garbage\n", "\u0000\u0001\n"]) {
      expect([bytes, await poke(run.endpoint, bytes)]).toEqual([bytes, "closed"]);
    }
    // Half a line: nothing more comes, so the idle timeout closes it.
    expect(await poke(run.endpoint, "{\"token\":\"abc")).toBe("closed");
    expect(await poke(run.endpoint, "")).toBe("closed");
    expect(calls).toBe(0);
    const { seen, io } = helperIO();
    expect(await runAskpassHelper([PROMPT], run.env, io)).toBe(0);
    expect(seen.out).toBe("still-works\n");
    expect(calls).toBe(1);
  } finally { await run.close(); }
});

test("the token is good for a few prompts of one command, one at a time, and not after the command ends", async () => {
  const home = await tempDir();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const run = (await startAskpass(async () => { calls++; if (calls === 1) await gate; return { secret: "s" }; }, { home, program: "unused", maxRequests: 2 }))!;
  try {
    const first = runAskpassHelper([PROMPT], run.env, helperIO().io);
    await Bun.sleep(100);
    // A second caller while one prompt is open: refused, the handler is not asked.
    const second = helperIO();
    expect(await runAskpassHelper([PROMPT], run.env, second.io)).toBe(1);
    expect(second.seen.err).toContain("busy");
    release();
    expect(await first).toBe(0);
    expect(await runAskpassHelper([PROMPT], run.env, helperIO().io)).toBe(0);
    expect(await runAskpassHelper([PROMPT], run.env, helperIO().io)).toBe(1);
    expect(calls).toBe(2);
  } finally { await run.close(); }
  const after = helperIO();
  expect(await runAskpassHelper([PROMPT], run.env, after.io)).toBe(1);
  expect(after.seen.out).toBe("");
});

posixOnly("a home folder too long for a Unix socket gets no box, and the temp folder is not used instead", async () => {
  const base = await tempDir();
  const home = path.join(base, "h".repeat(120));
  await mkdir(home);
  const before = new Set(await readdir(os.tmpdir()));
  expect(await startAskpass(async () => ({ secret: "x" }), { home, program: "unused" })).toBeUndefined();
  expect(await readdir(path.join(home, ".casper", "run"))).toEqual([]);
  expect((await readdir(os.tmpdir())).filter((name) => name.startsWith("casper-ask-") && !before.has(name))).toEqual([]);
});

test("from a source checkout on Windows there is no launcher (no batch file ever sees a prompt): no box, and nothing is left behind", async () => {
  const home = await tempDir();
  expect(await startAskpass(async () => ({ secret: "x" }), { home, platform: "win32" })).toBeUndefined();
  expect(await readdir(path.join(home, ".casper", "run"))).toEqual([]);
});

test("on Windows the ssh the shell finds is ssh.exe, so the system's OpenSSH counts as plain and gets the box; elsewhere ssh.exe does not", async () => {
  const base = await tempDir();
  const system = path.join(base, "System32", "OpenSSH");
  await mkdir(system, { recursive: true });
  await writeFile(path.join(system, "ssh.exe"), "", { mode: 0o755 });
  expect(trustedProgram("ssh", system, () => false, undefined, "win32")).toBe(path.join(system, "ssh.exe"));
  expect(trustedProgram("ssh", system, () => false, undefined, "linux")).toBeUndefined();
  // Still refused when a sandboxed command could write there.
  expect(trustedProgram("ssh", system, () => true, undefined, "win32")).toBeUndefined();
});

test("an ssh the PATH finds in a folder a sandboxed command may write (the project's own) is never given the box", async () => {
  const w = await world({ system: "project" });
  await mkdir(path.join(w.project, "bin"));
  await writeFile(path.join(w.project, "bin", "ssh"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
  expect(await w.shell.approve!("ssh admin@192.0.2.10 uptime")).toBeUndefined();
  expect((await w.shell.wrap("ssh admin@192.0.2.10 uptime", w.project)).ssh).toBeUndefined();
  await w.close();
});

test("an ssh named with a path (./ssh, bin/ssh), or a bare ssh that is not the system's, is never given the box", async () => {
  const w = await world({ answers: Array.from({ length: 4 }, () => "Yes, this once") });
  for (const command of ["./ssh admin@192.0.2.10 uptime", "bin/ssh admin@192.0.2.10 uptime", `${w.project}/ssh admin@192.0.2.10 uptime`]) {
    expect(await w.shell.approve!(command)).toBeUndefined();
    const wrapped = await w.shell.wrap(command, w.project);
    expect([command, wrapped.ssh?.env]).toEqual([command, undefined]);
  }
  await w.close();
  // A bare ssh that the PATH doesn't resolve to the system's own.
  const other = await world({ system: false });
  expect(await other.shell.approve!("ssh admin@192.0.2.10 uptime")).toBeUndefined();
  expect((await other.shell.wrap("ssh admin@192.0.2.10 uptime", other.project)).ssh).toBeUndefined();
  await other.close();
});

viaBash("a project script named ssh on the path never sees the askpass pointer or the password", async () => {
  const w = await world({ system: false });
  const result = await w.run("ssh admin@192.0.2.10 uptime");
  expect(result.raw).toContain("askpass: none");
  expect(result.raw).not.toContain("x9!");
  await w.close();
}, 30_000);

viaBash("BatchMode is read from ssh's options only: the same words in the command that runs over there change nothing", async () => {
  const typing = host([{ secret: "x9!", keep: "once" }, { secret: "x9!", keep: "once" }, { secret: "x9!", keep: "once" }]);
  const w = await world({ ssh: typing.value, answers: ["Yes, this once", "Yes, this once", "Yes, this once"] });
  for (const command of ["ssh admin@192.0.2.10 echo -o BatchMode=yes", "ssh admin@192.0.2.10 'ssh -o BatchMode=yes inner'", "ssh admin@192.0.2.10 -o BatchMode=yes"]) {
    const result = await w.run(command);
    expect([command, result.raw.includes("askpass: set")]).toEqual([command, true]);
    expect(result.raw).not.toContain(SSH_BATCH_MODE_LINE);
  }
  await w.close();
}, 60_000);

test("a box that can't start (no socket) says so to the AI instead of failing silently", async () => {
  const w = await world();
  const failing = runtimeShell({ canAsk: () => true, pick: async () => "Yes, this once", write: () => {}, planning: () => false },
    w.sandbox, new SandboxStore(path.join(w.home, "state")), { start: async () => undefined });
  expect(await failing.approve!("ssh admin@192.0.2.10 uptime")).toBeUndefined();
  expect((await failing.wrap("ssh admin@192.0.2.10 uptime", w.project)).ssh).toEqual({ afterFail: SSH_NOT_STARTED_LINE });
  await w.close();
});

test("a short typed secret can't match inside the marker another one left: one pass, and a second pass changes nothing", () => {
  rememberTypedSecret("e");
  rememberTypedSecret("x9!");
  const once = scrubPlainSecrets("e and x9!").text;
  expect(once).toBe("<secret hidden> and <secret hidden>");
  expect(scrubPlainSecrets(once).text).toBe(once);
  expect(scrubExactValues("a <secret hidden> b", ["e", "t"]).text).toBe("a <secret hidden> b");
  expect(scrubExactValues("abc", ["abc", "ab", "b"]).text).toBe("<secret hidden>");
});

viaBash("a 'Yes, this once' password is forgotten when the next command starts; a session one stays until the conversation, workspace or Casper ends", async () => {
  const once = await world({ ssh: host([{ secret: "once-pw", keep: "once" }]).value });
  await once.run("ssh admin@192.0.2.10 uptime");
  expect(typedSecretValues()).toEqual(["once-pw"]);
  await once.shell.wrap("echo hi", once.project);
  expect(typedSecretValues()).toEqual([]);
  await once.close();

  const kept = await world({ ssh: host([{ secret: "session-pw", keep: "session" }]).value });
  await kept.run("ssh admin@192.0.2.10 uptime");
  await kept.shell.wrap("echo hi", kept.project);
  expect(typedSecretValues()).toEqual(["session-pw"]);
  // A workspace change closes the shell: everything typed is forgotten.
  await (kept.shell as unknown as { close(): Promise<void> }).close();
  expect(typedSecretValues()).toEqual([]);
  await kept.close();
}, 30_000);

test("BatchMode is read from ssh's options only (no shell needed): before the machine it ends the box, after it nothing changes", async () => {
  const w = await world({ answers: Array.from({ length: 8 }, () => "Yes, this once") });
  const wrapped = async (command: string) => { expect(await w.shell.approve!(command)).toBeUndefined(); return w.shell.wrap(command, w.project); };
  for (const command of ["ssh -o BatchMode=yes admin@192.0.2.10 uptime", "ssh -oBatchMode=yes admin@192.0.2.10 uptime", "ssh -o 'BatchMode yes' admin@192.0.2.10 uptime"]) {
    expect([command, await wrapped(command)]).toEqual([command, { command, ssh: { afterFail: SSH_BATCH_MODE_LINE } }]);
  }
  for (const command of ["ssh admin@192.0.2.10 echo -o BatchMode=yes", "ssh admin@192.0.2.10 'ssh -o BatchMode=yes inner'", "ssh admin@192.0.2.10 -o BatchMode=yes", "ssh -o BatchMode=no admin@192.0.2.10 uptime"]) {
    const result = await wrapped(command);
    expect([command, Object.keys(result.ssh?.env ?? {}).includes("SSH_ASKPASS")]).toEqual([command, true]);
    await result.ssh?.done?.();
  }
  await w.close();
});

test("a 'Yes, this once' password is forgotten when the next command starts; a session one stays until the shell closes (no shell needed)", async () => {
  const w = await world();
  rememberTypedSecret("once-pw", true);
  rememberTypedSecret("session-pw");
  await w.shell.wrap("echo hi", w.project);
  expect(typedSecretValues()).toEqual(["session-pw"]);
  await (w.shell as unknown as { close(): Promise<void> }).close();
  expect(typedSecretValues()).toEqual([]);
  await w.close();
});
