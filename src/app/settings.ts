import { isMap } from "yaml";
import type { ProjectContext } from "../project/context";
import { DEFAULT_READER, DEFAULT_WEB, SHOW_PAGES_SETTINGS, type ShowPagesSetting } from "../config/load";
import { editUserConfig, USER_CONFIG, userConfigValue } from "../config/user-write";
import { DEFAULT_SPEND_LIMITS, formatLimit } from "../task/spend";
import { PROVIDER_LABELS } from "../web/providers";
import type { DisplayLevel } from "../tui/display";
import type { OutputWriter } from "./commands";
import type { MCPManager } from "../mcp/manager";

/** What /settings needs from the app: a numbered question only the person answers, and the project read again. */
export interface SettingsHost {
  readonly output: OutputWriter;
  homeDir(): string;
  /** A person can answer a numbered question here (an interactive session). */
  readonly canAsk: boolean;
  context(): Promise<ProjectContext | undefined>;
  /** The MCP servers, for the sandbox line of each one Casper has a profile for. */
  mcp?(): Pick<MCPManager, "status" | "setSandbox"> | undefined;
  /** Read the settings again after a change, so it applies from now on. */
  reload(): Promise<void>;
  /** The chosen label, or undefined (Esc, nobody answered). */
  ask(question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined>;
}

interface Choice { label: string; keys: string[] | ((home: string) => Promise<string[]>); value: unknown; shown: string;
  /** Saved some other way than in config.yaml (the MCP sandbox, in ~/.casper/mcp-sandbox.json). */
  apply?: () => Promise<unknown> }
interface Setting { label: string; value: string; question: string; keep: string; choices: Choice[]; savedIn?: string }

const SPEND_AMOUNTS = [2, 5, 20];
const DISPLAY_WORDS: Record<DisplayLevel, string> = {
  quiet: "the model's words, failures and receipts", normal: "steps fold into one summary line", detailed: "every step, with a small diff under each edit",
};

/** web: on/off goes into web.enabled when your web: is a mapping (a provider is set), so the provider stays. */
async function webKeys(home: string): Promise<string[]> {
  return isMap(await userConfigValue(home, ["web"])) ? ["web", "enabled"] : ["web"];
}

/** reader: on/off goes into reader.enabled when your reader: is a mapping (paths are listed), so the paths stay. */
async function readerKeys(home: string): Promise<string[]> {
  return isMap(await userConfigValue(home, ["reader"])) ? ["reader", "enabled"] : ["reader"];
}

const SHOW_PAGES_WORDS: Record<ShowPagesSetting, { value: string; choice: string }> = {
  ask: { value: "ask once a session", choice: "Ask once a session" },
  on: { value: "always", choice: "Always show them" },
  off: { value: "never", choice: "Never show them" },
};

/** After a UI change Casper saves page screenshots (no tokens); this says whether a model that sees pictures gets them. */
function showPagesRow(now: ShowPagesSetting): Setting {
  return { label: "Show the AI the pages", value: SHOW_PAGES_WORDS[now].value,
    question: `Showing the AI the page screenshots after a UI change: ${SHOW_PAGES_WORDS[now].value}. Only a model that sees pictures gets them, and each look uses tokens.`,
    keep: `Keep ${SHOW_PAGES_WORDS[now].value}`,
    choices: SHOW_PAGES_SETTINGS.filter((setting) => setting !== now)
      .map((setting) => ({ label: SHOW_PAGES_WORDS[setting].choice, keys: ["showPages"], value: setting, shown: SHOW_PAGES_WORDS[setting].value })) };
}

/** Each off switch Casper has, where it stands now, and the numbered answers for it (1 keeps it as it is). */
export function settingRows(context: ProjectContext): Setting[] {
  const web = context.web ?? DEFAULT_WEB;
  const reader = context.reader ?? DEFAULT_READER;
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
    { label: "Side questions with ?", value: context.sideQuestions === false ? "off" : "on",
      question: context.sideQuestions === false ? "Side questions are off: a line that starts with ? goes to the AI as an ordinary request."
        : "Side questions are on: a line that starts with ? (? what does ECONNRESET mean) goes to your fast model on the side, with no tools, and the task's AI never sees it. Each one uses a few tokens.",
      keep: `Keep them ${context.sideQuestions === false ? "off" : "on"}`,
      choices: [context.sideQuestions === false ? { label: "Turn them on", keys: ["sideQuestions"], value: true, shown: "on" }
        : { label: "Turn them off", keys: ["sideQuestions"], value: false, shown: "off" }] },
    { label: "Built-in skills", value: context.skills.bundled === false ? "off" : "on",
      question: `Casper's built-in skills (careful steps for network work and more) are ${context.skills.bundled === false ? "off" : "on"}. A change applies from the next start.`,
      keep: `Keep them ${context.skills.bundled === false ? "off" : "on"}`,
      choices: [context.skills.bundled === false ? { label: "Turn them on", keys: ["skills", "bundled"], value: true, shown: "on" }
        : { label: "Turn them off", keys: ["skills", "bundled"], value: false, shown: "off" }] },
    money("noteAt", "Spend notes", ["are", "come"], "A quiet line says what a task has spent; it never stops the task."),
    money("pauseAt", "Spend pause", ["is", "comes"], "The task stops and asks before it spends more."),
    showPagesRow(context.showPages ?? "ask"),
    { label: "Work shown", value: display, question: `Work shown: ${display} (${DISPLAY_WORDS[display]}).`, keep: `Keep ${display}`,
      choices: (["quiet", "normal", "detailed"] as const).filter((level) => level !== display)
        .map((level) => ({ label: `${level[0]!.toUpperCase()}${level.slice(1)}`, keys: ["display"], value: level, shown: level })) },
    { label: "Untrusted-text reader", value: reader.enabled ? "on" : "off",
      question: `The untrusted-text reader (casper_read_untrusted) is ${reader.enabled ? "on" : "off"}. It reads logs, mail and forms with a separate model that has no tools, and costs tokens only when the AI uses it.`,
      keep: `Keep it ${reader.enabled ? "on" : "off"}`,
      choices: [reader.enabled ? { label: "Turn it off", keys: readerKeys, value: false, shown: "off" } : { label: "Turn it on", keys: readerKeys, value: true, shown: "on" }] },
    { label: "Playwright tests", value: e2e ? "on" : "off",
      question: `Casper runs a project's own Playwright tests (the e2e check) after each change, once they are installed. They are ${e2e ? "on" : "off"}.`,
      keep: `Keep them ${e2e ? "on" : "off"}`,
      choices: [e2e ? { label: "Turn them off", keys: ["verification", "e2e"], value: false, shown: "off" }
        : { label: "Turn them on", keys: ["verification", "e2e"], value: true, shown: "on" }] },
  ];
}

/** One line per MCP server Casper runs in the sandbox (or would, if you turned it off). */
export function mcpSandboxRows(mcp: Pick<MCPManager, "status" | "setSandbox"> | undefined): Setting[] {
  return (mcp?.status() ?? []).filter((status) => status.sandbox?.state === "on" || status.sandbox?.state === "off").map((status) => {
    const on = status.sandbox!.state === "on";
    return { label: `Sandbox for MCP server ${status.name}`, value: on ? "on" : "off", savedIn: "~/.casper/mcp-sandbox.json",
      question: `MCP server ${status.name} runs ${on ? "in" : "outside"} the sandbox. In it, it reaches only its login hosts, writes only its cache, and can't read your keys or projects.`,
      keep: `Keep it ${on ? "on" : "off"}`,
      choices: [{ label: on ? "Turn it off" : "Turn it on", keys: [], value: !on, shown: on ? "off" : "on", apply: () => mcp!.setSandbox(status.name, !on) }] };
  });
}

/**
 * /settings: Casper's off switches as one numbered list, so nobody edits a config file. 1 is Done; a pick asks
 * with 1 Keep first, writes the answer into ~/.casper/config.yaml and lists the settings again.
 */
export async function runSettings(host: SettingsHost, signal?: AbortSignal): Promise<void> {
  for (;;) {
    const context = await host.context();
    if (!context) return;
    const rows = [...settingRows(context), ...mcpSandboxRows(host.mcp?.())];
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
      if (choice.apply) await choice.apply();
      else await editUserConfig(home, typeof choice.keys === "function" ? await choice.keys(home) : choice.keys, choice.value);
    } catch (error) {
      host.output.write(`[settings] Not saved: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    await host.reload();
    host.output.write(`[settings] ${row.label}: ${choice.shown}. Saved in ${row.savedIn ?? USER_CONFIG}.\n`);
  }
}
