import path from "node:path";
import { runNetworkSetup } from "../mcp/network/setup";
import { installTools } from "../security/install";
import { terminalText } from "../tui/format";
import { runUpdate } from "../update/command";
import type { CommandHost } from "../app/commands";
import { doctorContext, runDoctor } from "./run";

/** /doctor in a session: the same checks as casper doctor, plus why a server this session tried to start didn't. Its
 * questions use the session's numbered box (only you answer, never the AI). Never a model call. `duringWork`: a task
 * is running, so it only reports (a question of its own would stand in the way of the task's approvals). */
export async function runDoctorInSession(host: Pick<CommandHost, "output" | "homeDir" | "activeWorkspaceRoot" | "mcp" | "interactive" | "chooseAnswer" | "networkSetupHost" | "commandAbort" | "updateInstalled">, duringWork = false): Promise<void> {
  const write = (text: string) => { host.output.write(text); };
  const signal = duringWork ? undefined : host.commandAbort?.signal;
  const ctx = await doctorContext(host.activeWorkspaceRoot(), { homeDir: host.homeDir(), ...(host.mcp ? { mcpStatus: () => host.mcp!.status() } : {}) });
  await runDoctor(ctx, {
    write,
    ...(host.interactive && !duringWork ? { choose: (preview: string, choices: readonly string[]) => host.chooseAnswer(preview, "", choices, signal) } : {}),
    ...(duringWork ? { fixesLater: "Type /doctor when this task ends to have Casper make the fixes it can (it asks first).\n" } : {}),
    update: async () => {
      const result = await runUpdate({ check: false, install: ctx.install, currentVersion: ctx.currentVersion, stateDir: path.join(ctx.homeDir, ".casper"), ...(signal ? { signal } : {}),
        write: (line) => write(`${terminalText(line)}\n`) });
      if (result.exitCode === 0) { write("Restart Casper to use the new version.\n"); host.updateInstalled?.(); }
      return result;
    },
    installTools: (ids) => installTools(ids, { homeDir: ctx.homeDir, write }),
    networkSetup: async () => {
      const result = await runNetworkSetup(host.networkSetupHost(), { explicit: true });
      return result === "installed" || result === "updated";
    },
  });
}
