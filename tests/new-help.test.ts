import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { parseCliArgs, parseUpdateArgs } from "../src/cli-args";
import { NEW_HELP_LINE, parseNewArgs, runNewCommand } from "../src/new/command";
import { terminalNewProject } from "../src/cli-main";
import { EMPTY_TEMPLATE, listTemplates } from "../src/new/templates";
import { CLI_HELP_TEXT, FULL_HELP_TEXT } from "../src/tui/help";
import { makeNewFakes, type NewFakes } from "./support/new-fakes";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

setDefaultTimeout(30_000);
let fakes: NewFakes | undefined;
afterEach(async () => { await fakes?.cleanup(); fakes = undefined; });
const cli = path.resolve(import.meta.dir, "../src/cli.ts");

test("the casper new help line names every kind, and both helps use it", () => {
  for (const id of [...listTemplates().map((template) => template.id), EMPTY_TEMPLATE]) expect(NEW_HELP_LINE).toContain(id);
  expect(FULL_HELP_TEXT).toContain(NEW_HELP_LINE);
  expect(CLI_HELP_TEXT).toContain(NEW_HELP_LINE);
});

test("a lone kind word is the kind, not a project named after it", () => {
  expect(parseNewArgs(["web-app"])).toEqual({ template: "web-app", list: false });
  expect(parseNewArgs(["empty"])).toEqual({ template: "empty", list: false });
  expect(parseNewArgs(["mist-aps"])).toEqual({ name: "mist-aps", list: false });
  // At a terminal Casper asks only for the name.
  expect(terminalNewProject(parseCliArgs(["new", "web-app"]), true)).toEqual({ template: "web-app", list: false });
});

posixOnly("without a terminal, a lone kind word builds that kind under its usual name", async () => {
  fakes = await makeNewFakes();
  const lines: string[] = [];
  const { exitCode } = await runNewCommand({ command: { template: "python-cli", list: false }, write: (line) => lines.push(line), env: fakes.env(), homeDir: fakes.home });
  expect(exitCode).toBe(0);
  expect(lines[0]).toMatch(/^Starting ~\/Projects\/\S+ from template python-cli$/);
});

test("casper new --help and casper update --help print help, not an error", async () => {
  expect(parseNewArgs(["--help"])).toEqual({ list: false, help: true });
  expect(parseUpdateArgs(["update", "--help"])).toEqual({ check: false, help: true });
  for (const [args, words] of [[["new", "--help"], ["Usage: casper new", "web-app"]], [["update", "--help"], ["Usage: casper update [--check]", "--check"]]] as const) {
    const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: "/nonexistent-casper-home" } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    for (const word of words) expect(stdout).toContain(word);
  }
});

test("/project new with a lone kind word where Casper can't ask builds that kind under its usual name", async () => {
  const { CasperApp } = await import("../src/app");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-new-kind-"));
  const built: { template: string; name: string }[] = [];
  let output = "";
  const app = new CasperApp({ output: { write: (text) => { output += text; } }, runtimeFactory() { throw new Error("No model expected"); },
    createProject: async (options) => { built.push({ template: options.template, name: options.name }); return { status: "not_created", exitCode: 1, dir: path.join(root, options.name), displayDir: options.name, steps: [] } as never; } });
  try {
    await app.runOnce("/project new python-cli", root);
    expect(output).not.toContain("needs a template and a name");
    expect(built).toEqual([{ template: "python-cli", name: "my-tool" }]);
  } finally { await app.close(); await removeTempDir(root); }
});

test("/project new --help in a session prints the help and asks nothing", async () => {
  const { CasperApp } = await import("../src/app");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-new-help-"));
  const built: string[] = [];
  let output = "";
  const app = new CasperApp({ output: { write: (text) => { output += text; } }, runtimeFactory() { throw new Error("No model expected"); },
    createProject: async (options) => { built.push(options.name); return { status: "not_created", exitCode: 1, dir: root, displayDir: options.name, steps: [] } as never; } });
  try {
    await app.runOnce("/project new --help", root);
    expect(output).toContain("Usage: /project new [name]");
    expect(output).toContain("web-app");
    expect(output).not.toContain("needs a template");
    expect(built).toEqual([]);
  } finally { await app.close(); await removeTempDir(root); }
});
