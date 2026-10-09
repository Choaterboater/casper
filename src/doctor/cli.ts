import path from "node:path";
import readline from "node:readline";
import { loadConfiguration } from "../config/load";
import { discoverMCPConfiguration } from "../mcp/config";
import { networkReleasesOff } from "../mcp/network/releases";
import { runNetworkSetup, isCaspersEntry, type SetupHost } from "../mcp/network/setup";
import { installTools } from "../security/install";
import { terminalText } from "../tui/format";
import { runUpdate } from "../update/command";
import { doctorContext, runDoctor, type DoctorIO } from "./run";

/** One typed answer at a plain terminal: Enter is 1. Undefined when input ends (Ctrl-D) or is cancelled. */
function askLine(preview: string, choices: readonly string[], signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let done = false;
    const finish = (answer: string | undefined) => { if (done) return; done = true; rl.close(); resolve(answer); };
    rl.on("close", () => finish(undefined));
    signal.addEventListener("abort", () => finish(undefined), { once: true });
    process.stdout.write(`${terminalText(preview).replace(/\n?$/, "\n")}Type ${choices.join(" or ")} (Enter is 1): `);
    rl.once("line", (line) => {
      const word = line.trim() || "1";
      finish(choices.includes(word) ? word : "1");
    });
  });
}

/** `casper doctor`: the report on stdout. Questions only when a person is at the terminal; scripts get the report and
 * the exit code. No model, no saved session, outside the shell sandbox (it fixes your own install, like casper update). */
export async function runDoctorCommand(options: { cwd: string; signal: AbortSignal }): Promise<{ exitCode: number }> {
  const write = (text: string) => { process.stdout.write(text); };
  const ctx = await doctorContext(options.cwd);
  const canAsk = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const choose = (preview: string, choices: readonly string[]) => askLine(preview, choices, options.signal);
  const io: DoctorIO = {
    write,
    ...(canAsk ? { choose } : {}),
    update: () => runUpdate({ check: false, install: ctx.install, currentVersion: ctx.currentVersion, signal: options.signal, stateDir: path.join(ctx.homeDir, ".casper"),
      write: (line) => write(`${terminalText(line)}\n`) }),
    installTools: (ids) => installTools(ids, { homeDir: ctx.homeDir, write }),
    networkSetup: async () => {
      const { servers } = await discoverMCPConfiguration({ projectRoot: ctx.projectRoot ?? ctx.homeDir, homeDir: ctx.homeDir });
      // Setting it up for the first time connects it and remembers your yes, which needs a session.
      if (!servers.some((definition) => isCaspersEntry(definition, ctx.homeDir))) {
        write("To set up the network server, open Casper and type /mcp setup network.\n");
        return false;
      }
      // Settings that don't load count as off, so a broken file never skips your own off switch.
      const settings = await loadConfiguration({ projectRoot: ctx.projectRoot ?? ctx.homeDir, homeDir: ctx.homeDir }).catch(() => undefined);
      const off = networkReleasesOff(ctx.env, settings);
      const host: SetupHost = {
        homeDir: ctx.homeDir, canAsk: () => canAsk, write, releases: { signal: options.signal, ...(off ? { off } : {}) },
        chooseAnswer: (preview, _question, choices) => choose(preview, choices),
        configured: async () => servers,
        // Casper's entry is already in ~/.casper/mcp.json and connects in your next session as before.
        connect: async () => ({ ok: true }),
        restart: async (_name, whileStopped) => { await whileStopped?.(); },
      };
      const result = await runNetworkSetup(host, { explicit: true });
      return result === "installed" || result === "updated";
    },
  };
  return runDoctor(ctx, io);
}
