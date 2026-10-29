/**
 * Auto mode (docs/adr/0002/47-auto-mode-judge.md): with the sandbox off and in a folder you trust, a command that
 * would show "Run this command?" goes to a model judge first (src/sandbox/judge.ts). It lets ordinary build work run
 * and asks you about the rest. On unless `auto_mode: off` in your own config; "auto mode off" or /settings turns it off.
 */
import type { CasperApp } from "../app";
import { editUserConfig } from "../config/user-write";
import type { RuntimeEvent } from "../runtime/types";
import { judgeCommand, type JudgeResult } from "../sandbox/judge";
import { terminalText } from "../tui/format";
import { reloadProject } from "./project-file";
import { requestAsItStands } from "./steered-request";

/** How many of the task's steps the judge sees. */
const STEPS_KEPT = 8;
const EDIT_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch"]);

/** One short line per step the AI takes this task, for the judge: "edited package.json", "ran npm test". */
export function noteJudgeStep(app: CasperApp, event: RuntimeEvent): void {
  if (event.type !== "tool_start" || !app.commandActive) return;
  const input = event.input ?? {};
  const step = EDIT_TOOLS.has(event.toolName) && input.path ? `edited ${input.path}`
    : event.toolName === "bash" && input.command ? `ran ${input.command}` : undefined;
  if (step) app.judgeSteps = [...app.judgeSteps, step.replace(/\s+/g, " ").slice(0, 160)].slice(-STEPS_KEPT);
}

/** The judge for this session's shell host: undefined (no judge, the box) unless auto mode is on, someone can answer,
 * the folder is trusted and the runtime can make a side call. Its tokens join the task's. */
export async function judgeForApp(app: CasperApp, command: string, signal?: AbortSignal): Promise<JudgeResult | undefined> {
  if (app.projectContext?.autoMode === false || !app.interactive || app.folderTrust?.trusted !== true) return undefined;
  const session = app.session;
  if (!session?.complete) return undefined;
  const complete = session.complete.bind(session);
  const result = await judgeCommand({ complete, command, request: requestAsItStands(app, app.lastTaskRequest ?? ""),
    steps: app.judgeSteps, trusted: true, ...(signal ? { signal } : {}) });
  if (result.usage !== undefined) app.observations.recordModelCall(result.usage);
  else app.observations.recordUntrackedModelUse();
  return result;
}

const POLITE = String.raw`(?:(?:please|pls|ok|okay|casper)[,\s]+)*`;
const WORDS = new RegExp(String.raw`^${POLITE}(?:turn\s+)?auto[\s-]?mode\s+(on|off)$|^${POLITE}turn\s+(on|off)\s+auto[\s-]?mode$`, "i");

/** "on" or "off" when the whole typed line only says to turn auto mode on or off ("auto mode off", "turn on auto
 * mode"); undefined for anything else. A line with pasted text in it never counts. */
export function autoModeRequest(line: string, pasted: readonly string[] = []): "on" | "off" | undefined {
  if (pasted.some(Boolean) || line.length > 40 || /[\r\n]/.test(line.trim())) return undefined;
  const match = WORDS.exec(line.trim().replace(/\s*[.!]+$/, "").trim());
  const word = match?.[1] ?? match?.[2];
  return word ? word.toLowerCase() as "on" | "off" : undefined;
}

/** Saves auto mode on or off in your own config, as /settings would, and says so in one line. No model call. */
export async function setAutoMode(app: CasperApp, on: boolean): Promise<void> {
  await editUserConfig(app.homeDir(), ["auto_mode"], on);
  await reloadProject(app, { own: true }).catch(() => false);
  const trusted = app.folderTrust?.trusted === true;
  app.output.write(on
    ? `[auto mode] On. Saved in ~/.casper/config.yaml. ${trusted ? "Commands that would ask go to the judge first; anything doubtful still asks you."
      : `This folder isn't trusted, so commands still ask here; say "trust this folder" to use it.`}\n`
    : "[auto mode] Off. Saved in ~/.casper/config.yaml. Commands that would ask \"Run this command?\" ask you, as before.\n");
}

/** The line that says Casper did it itself. */
export const autoModeHandledHere = (request: "on" | "off") => `[auto mode] Handled here, no model call: "auto mode ${terminalText(request)}".\n`;
