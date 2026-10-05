import { isMap } from "yaml";
import type { ProjectContext } from "../project/context";
import { DEFAULT_WEB } from "../config/load";
import { editUserConfig, USER_CONFIG, userConfigValue } from "../config/user-write";
import { DEFAULT_SPEND_LIMITS, formatLimit } from "../task/spend";
import { PROVIDER_LABELS } from "../web/providers";
import type { DisplayLevel } from "../tui/display";
import type { OutputWriter } from "./commands";

/** What /settings needs from the app: a numbered question only the person answers, and the project read again. */
export interface SettingsHost {
  readonly output: OutputWriter;
  homeDir(): string;
  /** A person can answer a numbered question here (an interactive session). */
  readonly canAsk: boolean;
  context(): Promise<ProjectContext | undefined>;
  /** Read the settings again after a change, so it applies from now on. */
  reload(): Promise<void>;
  /** The chosen label, or undefined (Esc, nobody answered). */
  ask(question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined>;
}

interface Choice { label: string; keys: string[] | ((home: string) => Promise<string[]>); value: unknown; shown: string }
interface Setting { label: string; value: string; question: string; keep: string; choices: Choice[] }

const SPEND_AMOUNTS = [2, 5, 20];
const DISPLAY_WORDS: Record<DisplayLevel, string> = {
  quiet: "the model's words, failures and receipts", normal: "steps fold into one summary line", detailed: "every step, with a small diff under each edit",
};

/** web: on/off goes into web.enabled when your web: is a mapping (a provider is set), so the provider stays. */
async function webKeys(home: string): Promise<string[]> {
  return isMap(await userConfigValue(home, ["web"])) ? ["web", "enabled"] : ["web"];
}

/** Each off switch Casper has, where it stands now, and the numbered answers for it (1 keeps it as it is). */
export function settingRows(context: ProjectContext): Setting[] {
  const web = context.web ?? DEFAULT_WEB;
  const spend = context.spend ?? DEFAULT_SPEND_LIMITS;
  const display = context.display ?? "normal";
  const e2e = context.verification.e2e !== false;
  const amount = (dollars: number | undefined) => dollars === undefined ? "off" : `at ${formatLimit(dollars)} a task`;
  const money = (key: "noteAt" | "pauseAt", label: string, verbs: [off: string, on: string], about: string): Setting => {
    const now = spend[key];
    return { label, value: amount(now), question: `${label} ${now === undefined ? verbs[0] : verbs[1]} ${amount(now)}. ${about}`,
      keep: `Keep ${now === undefined ? "it off" : `${formatLimit(now)}`}`,
      choices: [...(now === undefined ? [] : [{ label: "Turn it off", keys: ["spend", key], value: false, shown: "off" }]),
        ...SPEND_AMOUNTS.filter((dollars) => dollars !== now).map((dollars) => ({ label: `${formatLimit(dollars)} a task`, keys: ["spend", key], value: dollars, shown: amount(dollars) }))] };
  };
  return [
    { label: "Web lookups", value: web.enabled ? `on (${PROVIDER_LABELS[web.provider]})` : "off",
      question: `Web lookups are ${web.enabled ? `on (${PROVIDER_LABELS[web.provider]})` : "off"}.`, keep: `Keep them ${web.enabled ? "on" : "off"}`,
      choices: [web.enabled ? { label: "Turn them off", keys: webKeys, value: false, shown: "off" } : { label: "Turn them on", keys: webKeys, value: true, shown: "on" }] },
    { label: "New-version notice", value: context.updates === false ? "off" : "on",
      question: `The line that says a newer Casper is out is ${context.updates === false ? "off" : "on"}.`, keep: `Keep it ${context.updates === false ? "off" : "on"}`,
      choices: [context.updates === false ? { label: "Turn it on", keys: ["updates"], value: true, shown: "on" } : { label: "Turn it off", keys: ["updates"], value: false, shown: "off" }] },
    { label: "Built-in skills", value: context.skills.bundled === false ? "off" : "on",
      question: `Casper's built-in skills (careful steps for network work and more) are ${context.skills.bundled === false ? "off" : "on"}. A change applies from the next start.`,
      keep: `Keep them ${context.skills.bundled === false ? "off" : "on"}`,
      choices: [context.skills.bundled === false ? { label: "Turn them on", keys: ["skills", "bundled"], value: true, shown: "on" }
        : { label: "Turn them off", keys: ["skills", "bundled"], value: false, shown: "off" }] },
    money("noteAt", "Spend notes", ["are", "come"], "A quiet line says what a task has spent; it never stops the task."),
    money("pauseAt", "Spend pause", ["is", "comes"], "The task stops and asks before it spends more."),
    { label: "Work shown", value: display, question: `Work shown: ${display} (${DISPLAY_WORDS[display]}).`, keep: `Keep ${display}`,
      choices: (["quiet", "normal", "detailed"] as const).filter((level) => level !== display)
        .map((level) => ({ label: `${level[0]!.toUpperCase()}${level.slice(1)}`, keys: ["display"], value: level, shown: level })) },
    { label: "Playwright tests", value: e2e ? "on" : "off",
      question: `Casper runs a project's own Playwright tests (the e2e check) after each change, once they are installed. They are ${e2e ? "on" : "off"}.`,
      keep: `Keep them ${e2e ? "on" : "off"}`,
      choices: [e2e ? { label: "Turn them off", keys: ["verification", "e2e"], value: false, shown: "off" }
        : { label: "Turn them on", keys: ["verification", "e2e"], value: true, shown: "on" }] },
  ];
}

/**
 * /settings: Casper's off switches as one numbered list, so nobody edits a config file. 1 is Done; a pick asks
 * with 1 Keep first, writes the answer into ~/.casper/config.yaml and lists the settings again.
 */
export async function runSettings(host: SettingsHost, signal?: AbortSignal): Promise<void> {
  for (;;) {
    const context = await host.context();
    if (!context) return;
    const rows = settingRows(context);
    if (!host.canAsk) {
      const width = Math.max(...rows.map((row) => row.label.length)) + 2;
      host.output.write(`Settings (${USER_CONFIG}):\n${rows.map((row) => `  ${row.label.padEnd(width)}${row.value}`).join("\n")}\nRun /settings in a Casper session to change one by number.\n`);
      return;
    }
    const picked = await host.ask(`Settings (saved in ${USER_CONFIG} for you). Pick one to change:`,
      [{ label: "Done", description: "nothing changes" }, ...rows.map((row) => ({ label: row.label, description: row.value }))], signal);
    const row = rows.find((candidate) => candidate.label === picked);
    if (!row || signal?.aborted) return;
    const answer = await host.ask(row.question, [{ label: row.keep }, ...row.choices.map((choice) => ({ label: choice.label }))], signal);
    const choice = row.choices.find((candidate) => candidate.label === answer);
    if (!choice || signal?.aborted) continue;
    const home = host.homeDir();
    try {
      await editUserConfig(home, typeof choice.keys === "function" ? await choice.keys(home) : choice.keys, choice.value);
    } catch (error) {
      host.output.write(`[settings] Not saved: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    await host.reload();
    host.output.write(`[settings] ${row.label}: ${choice.shown}. Saved in ${USER_CONFIG}.\n`);
  }
}
