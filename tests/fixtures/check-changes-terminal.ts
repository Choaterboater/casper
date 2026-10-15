/** Real terminal components; no provider, network or device calls. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CasperApp } from "../../src/app";
import { checkChangeOptions } from "../../src/app/check-changes";
import type { ProjectModel } from "../../src/project/model";
import { CheckChangeGuard } from "../../src/runtime/check-changes";
import { buildNextRow } from "../../src/tui/next-row";
import { InteractiveTerminal } from "../../src/tui/terminal";

const root = process.argv[2]!;
const terminal = new InteractiveTerminal(process.stdin, process.stdout, () => {}, () => {});
const model = { project: { root }, commands: { test: "bun .casper/quick-test.ts" } } as ProjectModel;
const app = { interactive: true, closing: false, approvalQueue: Promise.resolve(), terminal, output: process.stdout,
  projectContext: { model, verification: { timeoutMs: 30_000 } },
} as unknown as CasperApp;
const config = path.join(root, ".casper/project.yaml");
const before = await readFile(config, "utf8");
const guard = new CheckChangeGuard(root, checkChangeOptions(app));
try {
  terminal.setStatus("fixture");
  terminal.start();
  terminal.offerNext(buildNextRow({ more: [{ label: "Save junos-syntax", command: "/verify add junos-syntax", note: "free" }] }));
  terminal.write(`Picked: ${await terminal.readCommand()}\n`);
  try { await guard.write(config, "commands:\n  test: bun test\n"); }
  catch (error) { terminal.write(`${(error as Error).message}\n`); }
  terminal.write(`Active command: ${model.commands.test}\nFile unchanged: ${await readFile(config, "utf8") === before}\n`);
  // A script has no session-only option: Enter must decline, not rewrite it.
  try { await guard.write(path.join(root, ".casper/quick-test.ts"), "console.log('skip');\n"); }
  catch { terminal.write("Script change declined\n"); }
  terminal.write("Terminal check complete\n");
  await terminal.readCommand();
} finally { terminal.close(); }
