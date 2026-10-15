import path from "node:path";
import os from "node:os";
import type { CasperApp } from "../../src/app";
import { runtimeShell } from "../../src/app/sandbox";
import { sandboxHost } from "../../src/app/wiring";
import { NO } from "../../src/app/safe-choices";
import { PiRuntime } from "../../src/runtime/pi";
import type { RuntimeEvent } from "../../src/runtime/types";
import { ShellSandbox } from "../../src/sandbox/manager";
import { SandboxStore } from "../../src/sandbox/store";

const [cwd] = process.argv.slice(2);
if (!cwd) throw new Error("Missing fixture cwd");
const questions: string[] = [];
const app = { interactive: true, closing: false, planning: false, approvalQueue: Promise.resolve(), responseText: "",
  terminal: { canAsk: true, pick: async (question: string) => { questions.push(question); return NO; } },
  projectContext: { routineCommands: false }, output: { write() {} } } as unknown as CasperApp;
const store = new SandboxStore(path.join(os.homedir(), "state"));
const sandbox = new ShellSandbox({ root: () => cwd, home: os.homedir(), store, offByDefault: true, tempDirs: [] });
const shell = runtimeShell(sandboxHost(app), sandbox, store);
const runtime = new PiRuntime();
const toolEnds: RuntimeEvent[] = [];
try {
  const session = await runtime.start({ cwd, shell, localModels: false, tools: [{
    name: "approval_probe", description: "Ask before a custom tool's command.",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async (args, signal) => {
      await Bun.sleep(0); // A service/check tool may await before it asks, too.
      const reason = await shell.approve!(String(args.command), signal);
      return { text: reason ?? "allowed", isError: Boolean(reason) };
    },
  }] });
  session.subscribe((event) => {
    if (event.type === "assistant_response_start") app.responseText = "";
    if (event.type === "assistant_text_delta") app.responseText += event.delta;
    if (event.type === "tool_end") toolEnds.push(event);
  });
  await session.prompt("Check the command approval titles.");
  console.log("APPROVAL_REASONS=" + JSON.stringify({ questions, toolEnds }));
} finally { await runtime.dispose(); await shell.close(); await sandbox.close(); }
