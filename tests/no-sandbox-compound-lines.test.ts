import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionSandbox, runtimeShell, SHELL_DECLINED, STOP_ASKING_HINT, type PickSettings, type SandboxHost } from "../src/app/sandbox";
import { YES_ALWAYS, YES_ONCE, YES_SESSION } from "../src/app/safe-choices";
import { loadProjectContext } from "../src/project/context";
import { inspectProject } from "../src/project/inspect";
import { commandCore, commandPrefix, readOnlyCommand } from "../src/sandbox/read-only";
import { SandboxStore } from "../src/sandbox/store";
import { fakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/**
 * With no sandbox (Windows), the lines an AI really sends while it looks around a project it cloned into a subfolder:
 * `cd <project> && <readers> | <readers>`. They run without a box; a line with one command that is not a read (a test
 * run) asks once, and "don't ask again" covers that command for the same kind of line.
 */

/** A folder as the AI types it in a shell line: on Windows, Git Bash's /c/... form (a backslash path is never a read). */
const sh = (folder: string) => process.platform === "win32" ? `/${folder[0]!.toLowerCase()}${folder.slice(2).replace(/\\/g, "/")}` : folder;

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

/** Casper opened in a folder (`root`), and a project cloned into `root/webapp`, as a session that clones a repository has it. */
async function area() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-compound-")));
  roots.push(base);
  const home = path.join(base, "home"), root = path.join(base, "work"), outside = path.join(base, "outside");
  const project = path.join(root, "webapp");
  for (const folder of [home, outside, ...["app/vendors", "app/routes", "app/templates", "app/static/css", "tests"].map((part) => path.join(project, part))]) {
    await mkdir(folder, { recursive: true });
  }
  for (const file of ["app/requirements.txt", "app/main.py", "app/vendors/client.py", "app/routes/pages.py", "app/templates/base.html",
    "app/templates/form.html", "app/static/css/site.css", "tests/test_pages.py", "pytest.ini"]) {
    await writeFile(path.join(project, file), "x\n");
  }
  await writeFile(path.join(outside, "notes.txt"), "OUTSIDE");
  return { base, home, root, project, outside, where: { root, home, denyRead: [] as string[] } };
}

/** Lines an AI sent on Windows, with this project's path in place of the real one. */
const lookAroundLines = (project: string) => [
  `cd ${sh(project)} && cat app/requirements.txt`,
  `cd ${sh(project)} && wc -l app/vendors/*.py app/*.py app/routes/*.py | tail -40`,
  `cd ${sh(project)} && grep -n "https\\?://\\|_URL\\|api_path" app/vendors/client.py | head -60`,
  `cd ${sh(project)} && cat tests/test_pages.py | head -80`,
  `cd ${sh(project)} && ls app/templates app/static app/static/* 2>/dev/null | head -80`,
  `cd ${sh(project)} && echo "=== template line counts ===" && find app/templates -name '*.html' | xargs wc -l | sort -n | tail -25`,
  `cd ${sh(project)} && echo "=== inputs without a preceding label (first 30) ===" && grep -rn "<input" app/templates/form.html app/templates/base.html | head -30`,
  `cd ${sh(project)} && python --version 2>&1; py --version 2>&1; echo "---X---"; cat pytest.ini`,
];
const TEST_RUN = (project: string) => `cd ${sh(project)} && ./.venv/Scripts/python.exe -m pytest -q 2>&1 | tail -25`;

test("look-around lines from a cloned project are plain reads: a cd into the project, globs, xargs wc, --version and a quoted <", async () => {
  const { project, where } = await area();
  for (const line of lookAroundLines(project)) expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  // The test run is not a read; its one command is what a remembered answer covers.
  expect(readOnlyCommand(TEST_RUN(project), where)).toBe(false);
  // Its program is named from the folder Casper was opened in, so it never matches a .venv of another folder.
  expect(commandCore(TEST_RUN(project), where)).toBe("./webapp/.venv/Scripts/python.exe -m pytest -q");
  expect(commandPrefix("./webapp/.venv/Scripts/python.exe -m pytest -q")).toBe("./webapp/.venv/Scripts/python.exe -m pytest");
});

test("a cd counts only into a folder in the project, reached without a link, and not inside a pipe", async () => {
  const { base, project, outside, where } = await area();
  await symlink(outside, path.join(project, "out-link"));
  await mkdir(path.join(where.root, ".ssh"));
  const deny = { ...where, denyRead: [path.join(where.root, ".ssh")] };
  for (const line of [`cd ${sh(outside)} && cat notes.txt`, `cd ${sh(base)} && ls`, "cd webapp/out-link && cat notes.txt", "cd webapp/out-link/.. && ls",
    "cd .ssh && ls", "cd webapp | cat app/main.py", "cd webapp || cat app/main.py", "cd -", "cd", "cd webapp", "cd ~ && ls", "cd webapp/app/* && ls",
    "cd webapp && cat ../../outside/notes.txt"]) {
    expect({ line, read: readOnlyCommand(line, deny) }).toEqual({ line, read: false });
  }
  for (const line of ["cd webapp && cat app/main.py", "cd webapp/app && cat ../pytest.ini", "cd webapp; ls", "cd webapp && cd app && ls routes"]) {
    expect({ line, read: readOnlyCommand(line, where) }).toEqual({ line, read: true });
  }
});

test("with CDPATH or BASH_ENV set, a relative cd asks (bash may find the name somewhere else); ./ and full paths still read", async () => {
  const { project, where } = await area();
  for (const name of ["CDPATH", "BASH_ENV"] as const) {
    const saved = process.env[name];
    process.env[name] = path.join(where.home);
    try {
      expect(readOnlyCommand("cd webapp && cat app/main.py", where)).toBe(false);
      expect(readOnlyCommand("cd ./webapp && cat app/main.py", where)).toBe(true);
      expect(readOnlyCommand(`cd ${sh(project)} && cat app/main.py`, where)).toBe(true);
    } finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
  }
});

test("after `cd x;` the next commands may run in either folder (the cd can fail), so both must be fine", async () => {
  const { project, outside, where } = await area();
  await writeFile(path.join(project, "app", "notes.txt"), "inside");
  await symlink(path.join(outside, "notes.txt"), path.join(project, "notes.txt"));
  expect(readOnlyCommand(`cd ${sh(project)}/app && cat notes.txt`, where)).toBe(true);
  // From `webapp` (where the line starts if this were the project), notes.txt leads out.
  const fromProject = { ...where, root: project };
  expect(readOnlyCommand("cd app && cat notes.txt", fromProject)).toBe(true);
  expect(readOnlyCommand("cd app; cat notes.txt", fromProject)).toBe(false);
  expect(readOnlyCommand("cd app && ls || cat notes.txt", fromProject)).toBe(false);
});

test("* and ? are expanded here: each file must be in the project and not private; a dot part, an option or a pattern asks", async () => {
  const { project, outside, where } = await area();
  const at = { ...where, root: project };
  for (const line of ["cat app/*.py", "wc -l app/*/*.py", "ls app/static/*", "head -5 tests/test_?ages.py", "cat app/none*.py", "grep -n x app/*.py",
    "echo app/*"]) {
    expect({ line, read: readOnlyCommand(line, at) }).toEqual({ line, read: true });
  }
  await writeFile(path.join(project, "app", "prod.env"), "SECRET");
  await symlink(path.join(outside, "notes.txt"), path.join(project, "app", "routes", "link.txt"));
  await writeFile(path.join(project, "tests", "--files0-from=list"), "x");
  for (const line of ["cat app/*", "cat app/*.env", "cat app/routes/*", "cd tests && wc -l *", "cat app/.*", "cat app/.e*", "grep x* app/main.py",
    "cat 'app'/*", "cat \"app/\"*.py", "cat -* app/main.py", "head -n * app/main.py", "git log -- app/*", "find app/* -name x", "cat* app/main.py"]) {
    expect({ line, read: readOnlyCommand(line, at) }).toEqual({ line, read: false });
  }
  // A glob that picks more files than this check walks asks.
  const many = path.join(project, "many");
  await mkdir(many);
  await Promise.all(Array.from({ length: 1001 }, (_, index) => writeFile(path.join(many, `f${index}.txt`), "")));
  expect(readOnlyCommand("wc -l many/*.txt", at)).toBe(false);
});

test("xargs only for wc fed by find: grep or cat through xargs would print files the check never saw", async () => {
  const { project, where } = await area();
  const at = { ...where, root: project };
  for (const line of ["find app -name '*.py' | xargs wc -l", "find app -name '*.py' -print0 | xargs -0 wc -l | sort -n", "find . -type f | xargs -r wc"]) {
    expect({ line, read: readOnlyCommand(line, at) }).toEqual({ line, read: true });
  }
  for (const line of ["find app | xargs grep x", "find app | xargs cat", "ls | xargs wc -l", "echo /etc/passwd | xargs wc -l", "find app | xargs -I{} wc {}",
    "find app | xargs wc -l app/main.py", "find app | xargs sh -c id", "find / | xargs wc -l", "find app; xargs wc -l",
    // find's own text would reach wc as options or paths: GNU wc --files0-from=F prints F's lines in its errors.
    "find . -maxdepth 0 -printf '--files0-from=.env\\n' | xargs wc -l", "find . -maxdepth 0 -printf '/c/Users/me/.ssh/id_rsa\\n' | xargs wc -c",
    "find app -ls | xargs wc", "find app -print0 | xargs wc -l", "find app | xargs -0 wc -l"]) {
    expect({ line, read: readOnlyCommand(line, at) }).toEqual({ line, read: false });
  }
});

test("xargs splits names on spaces and quotes: a name that would split, or a link out of the project, asks", async () => {
  const { project, outside, where } = await area();
  const at = { ...where, root: project };
  const odd = path.join(project, "odd");
  await mkdir(odd);
  await writeFile(path.join(odd, "a --files0-from=x.txt"), "");
  expect(readOnlyCommand("find odd -name '*.txt' | xargs wc -l", at)).toBe(false);
  // With -print0 and -0 each name reaches wc whole.
  expect(readOnlyCommand("find odd -name '*.txt' -print0 | xargs -0 wc -l", at)).toBe(true);
  const linked = path.join(project, "linked");
  await mkdir(linked);
  await symlink(path.join(outside, "notes.txt"), path.join(linked, "notes.txt"));
  expect(readOnlyCommand("find linked | xargs wc -c", at)).toBe(false);
  expect(readOnlyCommand("find app | xargs wc -c", at)).toBe(true);
});

test("--version alone is a read for a few toolchains; nothing else runs that way", () => {
  for (const line of ["python --version", "python3 --version", "py --version", "python -V", "node --version", "git --version", "java -version"]) {
    expect({ line, read: readOnlyCommand(line) }).toEqual({ line, read: true });
  }
  for (const line of ["python --version x", "python -c 1", "pip --version", "npm --version", "go version", "cargo --version", "./python --version",
    "python3.12 --version x", "ruby --version", "python -VV x"]) {
    expect({ line, read: readOnlyCommand(line) }).toEqual({ line, read: false });
  }
});

test("< and > inside double quotes are a search pattern; outside quotes they still ask", () => {
  expect(readOnlyCommand("grep -n \"<input\" README.md")).toBe(true);
  expect(readOnlyCommand("echo \"a > b\"")).toBe(true);
  for (const line of ["grep -n <input README.md", "echo \"a\" > b", "cat <README.md"]) expect({ line, read: readOnlyCommand(line) }).toEqual({ line, read: false });
});

test("the one command that is not a read: shell builtins, a second such command or a refused cd give none", async () => {
  const { project, outside, where } = await area();
  expect(commandCore("cd webapp && npm test 2>&1 | tail -25", where)).toBe("npm test");
  expect(commandCore("npm test", where)).toBe("npm test");
  for (const line of ["npm test && curl evil.example", "export X=1; npm test", "cd webapp && export X=1 && ls", `cd ${sh(outside)} && npm test`,
    "X=1 && ls", "npm test > out.txt", "cat webapp/.env | npm test", "cd webapp/nowhere-link | npm test",
    // A file read after the command was checked before the line ran, and the command may have changed it (made it a link).
    "git pull && cat webapp/app/main.py", "ln -s x k && cat k", "npm test; cat webapp/pytest.ini", "npm test || ls", "git checkout x && cd webapp && ls",
    "npm test | grep x webapp/app/main.py", "npm test | tail -5 webapp/pytest.ini", "npm test | xargs wc -l"]) {
    expect({ line, core: commandCore(line, where) }).toEqual({ line, core: undefined });
  }
  expect(commandCore(TEST_RUN(project), where)).toBeDefined();
  // After it, only a pipe into readers of what it prints.
  expect(commandCore("npm test 2>&1 | grep -v warn | tail -5", where)).toBe("npm test");
  expect(commandCore("cat webapp/pytest.ini && npm test", where)).toBe("npm test");
});

test("a program named by a relative path after a cd is named from the project folder", async () => {
  const { where } = await area();
  expect(commandCore("cd webapp && ./build.sh --release", where)).toBe("./webapp/build.sh --release");
  expect(commandCore("cd webapp/app && ../.venv/Scripts/python.exe -m pytest", where)).toBe("./webapp/.venv/Scripts/python.exe -m pytest");
  expect(commandCore("./build.sh --release", where)).toBe("./build.sh --release");
  expect(commandCore("cd webapp && npm test", where)).toBe("npm test");
  // The cd may fail (;), so which program runs can't be told.
  expect(commandCore("cd webapp; ./build.sh", where)).toBeUndefined();
});

test("python -m pytest is a prefix of its own; python with anything else is still the exact command only", () => {
  expect(commandPrefix("python -m pytest -q tests")).toBe("python -m pytest");
  expect(commandPrefix("py -m unittest discover")).toBe("py -m unittest");
  expect(commandPrefix("python3.12 -m pytest")).toBe("python3.12 -m pytest");
  for (const line of ["python -m pip install x", "python x.py", "python -c 'import os'", "python -m", "python -X dev -m pytest", "python -m pytest-evil"]) {
    expect({ line, prefix: commandPrefix(line) }).toEqual({ line, prefix: undefined });
  }
});

/** A terminal that answers in turn and keeps each box's question, choices and record function. */
function host(answers: Array<string | undefined>) {
  const asked: Array<{ question: string; options: string[]; settings?: PickSettings }> = [];
  const written: string[] = [];
  const value: SandboxHost = {
    canAsk: () => true,
    pick: async (question, options, _signal, settings) => {
      asked.push({ question, options: options.map((option) => option.label), ...(settings ? { settings } : {}) });
      return answers.shift();
    },
    write: (text) => { written.push(text); },
    planning: () => false,
  };
  return { value, asked, written };
}

async function shellFor(answers: Array<string | undefined>) {
  const { project, root, home } = await area();
  const context = await loadProjectContext(await inspectProject(root), { homeDir: home });
  const terminal = host(answers);
  const sandbox = createSessionSandbox(terminal.value, context, { root: () => root, home, seams: { engine: fakeEngine(), platform: "win32" } });
  return { project, home, context, terminal, shell: runtimeShell(terminal.value, sandbox, new SandboxStore(context.stateDirectory)) };
}

test("with no sandbox: those reads never ask, and 'always' for the test run covers the next test run line", async () => {
  const { project, context, terminal, shell } = await shellFor([YES_ALWAYS, undefined, undefined]);
  for (const line of lookAroundLines(project)) expect(await shell.approve!(line)).toBeUndefined();
  expect(terminal.asked).toEqual([]);
  expect(await shell.approve!(TEST_RUN(project))).toBeUndefined();
  expect(terminal.asked).toHaveLength(1);
  expect(terminal.asked[0]!.options).toEqual(["No", "Yes, this once", "Yes, for this session", "Yes, always for this project"]);
  expect(JSON.parse(await readFile(path.join(context.stateDirectory, "sandbox.json"), "utf8")).prefixes).toEqual(["./webapp/.venv/Scripts/python.exe -m pytest"]);
  // The same kind of line, other options: no box.
  expect(await shell.approve!(`cd ${sh(project)} && ./.venv/Scripts/python.exe -m pytest -x tests/test_pages.py 2>&1 | tail -5`)).toBeUndefined();
  expect(await shell.approve!("./webapp/.venv/Scripts/python.exe -m pytest")).toBeUndefined();
  expect(terminal.asked).toHaveLength(1);
  // Anything else that python runs still asks.
  expect(await shell.approve!(`cd ${sh(project)} && ./.venv/Scripts/python.exe -c 'import os' | tail -5`)).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(2);
  // Another folder's .venv is another program.
  expect(await shell.approve!("./.venv/Scripts/python.exe -m pytest")).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(3);
});

test("a remembered command covers no file read after it on the line (it may have made that file a link)", async () => {
  const { project, home, terminal, shell } = await shellFor([YES_ALWAYS, undefined, undefined]);
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  await writeFile(path.join(home, ".ssh", "id_rsa"), "KEY");
  expect(await shell.approve!(`ln -s ${sh(project)}/app/main.py ${sh(project)}/b.py`)).toBeUndefined();
  expect(terminal.asked).toHaveLength(1);
  expect(await shell.approve!(`ln -s ${sh(home)}/.ssh/id_rsa k2 && cat k2`)).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(2);
});

test("a program remembered by a relative path is not another folder's program of the same name", async () => {
  const { terminal, shell } = await shellFor([YES_ALWAYS, undefined]);
  expect(await shell.approve!("./build.sh --release")).toBeUndefined();
  expect(await shell.approve!("./build.sh")).toBeUndefined();
  expect(terminal.asked).toHaveLength(1);
  expect(await shell.approve!("cd webapp && ./build.sh")).toBe(SHELL_DECLINED);
  expect(terminal.asked).toHaveLength(2);
});

test("a yes leaves no line of its own; a remembered one leaves one short line; a No keeps the usual record", async () => {
  const { terminal, shell } = await shellFor([YES_SESSION]);
  expect(await shell.approve!("npm test 2>&1 | tail -20")).toBeUndefined();
  const record = terminal.asked[0]!.settings!.record!;
  expect(record(YES_ONCE)).toBe("");
  expect(record(YES_SESSION)).toBe("✓ allowed until you quit: npm test");
  expect(record(YES_ALWAYS)).toBe("✓ allowed always in this project: npm test");
  expect(record("No")).toBeUndefined();
});

test("the third shell box answered yes in a session says once how to stop them", async () => {
  const { terminal, shell } = await shellFor([YES_ONCE, YES_ONCE, YES_ONCE, YES_ONCE]);
  for (const line of ["make a", "make b", "make c", "make d"]) await shell.approve!(line);
  expect(terminal.written.filter((text) => text.includes(STOP_ASKING_HINT))).toHaveLength(1);
  expect(terminal.asked).toHaveLength(4);
});

test("Git Bash drive paths: /c/... is C:\\ on Windows only; another / path on Windows asks", async () => {
  const { where } = await area();
  if (process.platform === "win32") {
    const drive = where.root.slice(0, 1).toLowerCase();
    const shellPath = `/${drive}/${where.root.slice(3).split(path.sep).join("/")}`;
    expect(readOnlyCommand(`cd ${shellPath}/webapp && cat app/main.py`, where)).toBe(true);
    expect(readOnlyCommand(`cat ${shellPath}/webapp/app/main.py`, where)).toBe(true);
    expect(readOnlyCommand("cat /tmp/x", { ...where, root: `${where.root.slice(0, 3)}` })).toBe(false);
    expect(readOnlyCommand(`cd /mnt/${drive}/x && ls`, where)).toBe(false);
  } else {
    // Elsewhere /c/... is an ordinary folder, outside this project.
    expect(readOnlyCommand("cd /c/Users/me/project && ls", where)).toBe(false);
  }
});
