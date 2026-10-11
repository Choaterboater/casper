import { isMap } from "yaml";
import type { ProjectContext } from "../project/context";
import { DEFAULT_READER, DEFAULT_WEB, SHOW_PAGES_SETTINGS, type ShowPagesSetting } from "../config/load";
import { editUserConfig, USER_CONFIG, userConfigValue } from "../config/user-write";
import { DEFAULT_SPEND_LIMITS, formatLimit } from "../task/spend";
import { PROMPT_CACHE_SETTINGS, type PromptCacheSetting } from "../runtime/cache";
import { PROVIDER_LABELS } from "../web/providers";
import type { DisplayLevel } from "../tui/display";
import { activeThemeName, findTheme, shownThemeName, themeNames } from "../tui/theme";
import { packThemeOwner } from "../packs/themes";
import type { OutputWriter } from "./commands";
import type { MCPManager } from "../mcp/manager";

/** What /settings needs from the app: a numbered question only the person answers, and the project read again. */
export interface SettingsHost {
  readonly output: OutputWriter;
  homeDir(): string;
  /** A person can answer a numbered question here (an interactive session). */
  readonly canAsk: boolean;
  /** /settings was typed while a task runs. */
  readonly duringTask?: boolean;
  context(): Promise<ProjectContext | undefined>;
  /** The MCP servers, for the sandbox line of each one Casper has a profile for. */
  mcp?(): Pick<MCPManager, "status" | "setSandbox"> | undefined;
  /** Read the settings again after a change, so it applies from now on. */
  reload(): Promise<void>;
  /** The chosen label, or undefined (Esc, nobody answered). */
  ask(question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined>;
}

interface Choice { label: string; keys: string[] | ((home: string) => Promise<string[]>); value: unknown; shown: string;
  /** A few plain words beside the choice. */
  description?: string;
  /** Saved some other way than in config.yaml (the MCP sandbox, in ~/.casper/mcp-sandbox.json). */
  apply?: () => Promise<unknown> }
/** When a change reaches a running task: its next step, or only the next task (the tools are made once per task).
 * Unset: it applies now and has nothing to do with the task, or its question says from the next start. */
type Applies = "step" | "task";
interface Setting { label: string; value: string; question: string; keep: string; choices: Choice[]; savedIn?: string; applies?: Applies }

/** The note after a change typed during a task. */
const DURING_TASK: Record<Applies, string> = {
  step: " The running task uses it from its next step.",
  task: " The running task keeps what it had; your next request uses it.",
};

const SPEND_AMOUNTS = [2, 5, 20];
const DISPLAY_WORDS: Record<DisplayLevel, string> = {
  quiet: "the model's words, failures and receipts", normal: "steps fold into one named row; edits and failures in a box", detailed: "every step, with every edit's whole diff",
};

/** web: on/off goes into web.enabled when your web: is a mapping (a provider is set), so the provider stays. */
async function webKeys(home: string): Promise<string[]> {
  return isMap(await userConfigValue(home, ["web"])) ? ["web", "enabled"] : ["web"];
}

/** reader: on/off goes into reader.enabled when your reader: is a mapping (paths are listed), so the paths stay. */
async function readerKeys(home: string): Promise<string[]> {
  return isMap(await userConfigValue(home, ["reader"])) ? ["reader", "enabled"] : ["reader"];
}

/** visualize: on/off goes into visualize.enabled when your visualize: is a mapping (providers are listed), so they stay. */
async function visualizeKeys(home: string): Promise<string[]> {
  return isMap(await userConfigValue(home, ["visualize"])) ? ["visualize", "enabled"] : ["visualize"];
}

/** A plain on/off row: 1 keeps it as it is, 2 flips it. `them` for a plural (suggestions, page checks). */
function onOffRow(label: string, on: boolean, question: string, keys: Choice["keys"], them = false, applies?: Applies): Setting {
  const now = on ? "on" : "off";
  const it = them ? "them" : "it";
  return { label, value: now, ...(applies ? { applies } : {}), question: `${question} ${them ? "They are" : "It is"} ${now}.`, keep: `Keep ${it} ${now}`,
    choices: [{ label: on ? `Turn ${it} off` : `Turn ${it} on`, keys, value: !on, shown: on ? "off" : "on" }] };
}

const CACHE_WORDS: Record<PromptCacheSetting, string> = {
  auto: "the long cache where it costs no more, the short one elsewhere",
  long: "about an hour (a day where offered); writing it can cost more",
  short: "a few minutes",
  off: "no cache: every request costs more",
};

/** How long the provider keeps the conversation's start so the next request costs less (cache:). */
function cacheRow(now: PromptCacheSetting): Setting {
  return { label: "Prompt cache", value: now,
    question: `Prompt cache: ${now} (${CACHE_WORDS[now]}). The provider keeps the start of the conversation so the next request costs less. A change applies from the next start.`,
    keep: `Keep ${now}`,
    choices: PROMPT_CACHE_SETTINGS.filter((setting) => setting !== now)
      .map((setting) => ({ label: `${setting[0]!.toUpperCase()}${setting.slice(1)}`, description: CACHE_WORDS[setting], keys: ["cache"], value: setting, shown: setting })) };
}

const SHOW_PAGES_WORDS: Record<ShowPagesSetting, { value: string; choice: string }> = {
  ask: { value: "ask once a session", choice: "Ask once a session" },
  on: { value: "always", choice: "Always show them" },
  off: { value: "never", choice: "Never show them" },
};

/** After a UI change Casper saves page screenshots (no tokens); this says whether a model that sees pictures gets them. */
function showPagesRow(now: ShowPagesSetting): Setting {
  return { label: "Show the AI the pages", value: SHOW_PAGES_WORDS[now].value, applies: "step",
    question: `Showing the AI the page screenshots after a UI change: ${SHOW_PAGES_WORDS[now].value}. Only a model that sees pictures gets them, and each look uses tokens.`,
    keep: `Keep ${SHOW_PAGES_WORDS[now].value}`,
    choices: SHOW_PAGES_SETTINGS.filter((setting) => setting !== now)
      .map((setting) => ({ label: SHOW_PAGES_WORDS[setting].choice, keys: ["showPages"], value: setting, shown: SHOW_PAGES_WORDS[setting].value })) };
}

const THEME_WORDS: Record<string, string> = {
  default: "Casper's own colours", light: "for a light terminal background", "high-contrast": "bright colours, no faint text",
};

/** The screen's colours (theme:): the built-in themes and any a pack added. Colours only; nothing goes to the model.
 * A name Casper has no theme for shows as written, and every theme (default too) is offered in its place. */
function themeRow(name: string | undefined): Setting {
  const now = name ?? "default";
  const found = findTheme(now) !== undefined;
  // On screen when its pack was removed (or stopped being used) this session: it stays until Casper starts again.
  const value = found ? now : activeThemeName() === now ? `${shownThemeName(now)} (its pack is no longer used; default from the next start)`
    : `${shownThemeName(now)} (not found, using default)`;
  const capital = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;
  return { label: "Theme", value, question: `Theme: ${value}. It changes the colours only, from now on; NO_COLOR still turns colour off.`,
    keep: found ? `Keep ${now}` : "Keep it as it is",
    choices: themeNames().filter((theme) => theme !== now)
      .map((theme) => {
        const pack = packThemeOwner(theme);
        const description = Object.hasOwn(THEME_WORDS, theme) ? THEME_WORDS[theme]! : pack ? `from pack ${pack}` : undefined;
        return { label: capital(theme), ...(description ? { description } : {}), keys: ["theme"], value: theme, shown: theme };
      }) };
}

/** Each off switch Casper has, where it stands now, and the numbered answers for it (1 keeps it as it is). */
export function settingRows(context: ProjectContext): Setting[] {
  const web = context.web ?? DEFAULT_WEB;
  const reader = context.reader ?? DEFAULT_READER;
  const spend = context.spend ?? DEFAULT_SPEND_LIMITS;
  const display = context.display ?? "normal";
  const e2e = context.verification.e2e !== false;
  const build = context.delegate?.build !== false;
  const amount = (dollars: number | undefined) => dollars === undefined ? "off" : `at ${formatLimit(dollars)} a task`;
  const money = (key: "noteAt" | "pauseAt", label: string, verbs: [off: string, on: string], about: string): Setting => {
    const now = spend[key];
    return { label, value: amount(now), applies: "task", question: `${label} ${now === undefined ? verbs[0] : verbs[1]} ${amount(now)}. ${about}`,
      keep: `Keep ${now === undefined ? "it off" : `${formatLimit(now)}`}`,
      choices: [...(now === undefined ? [] : [{ label: "Turn it off", keys: ["spend", key], value: false, shown: "off" }]),
        ...SPEND_AMOUNTS.filter((dollars) => dollars !== now).map((dollars) => ({ label: `${formatLimit(dollars)} a task`, keys: ["spend", key], value: dollars, shown: amount(dollars) }))] };
  };
  return [
    { label: "Web lookups", value: web.enabled ? `on (${PROVIDER_LABELS[web.provider]})` : "off", applies: "task",
      question: `Web lookups are ${web.enabled ? `on (${PROVIDER_LABELS[web.provider]})` : "off"}.`, keep: `Keep them ${web.enabled ? "on" : "off"}`,
      choices: [web.enabled ? { label: "Turn them off", keys: webKeys, value: false, shown: "off" } : { label: "Turn them on", keys: webKeys, value: true, shown: "on" }] },
    onOffRow("Browser tool", context.browser !== false,
      "The AI's own browser opens pages and reads them when a task needs it. The page checks after a change still run when it is off.", ["browser"], false, "task"),
    onOffRow("Starter templates", context.templates !== false,
      "In an empty folder, a first request that fits a template (a NOC dashboard, an MCP server) is built from it for you, with one line saying so. Off: the AI builds it from scratch.", ["templates"], false, "task"),
    onOffRow("Diagram tool", context.diagrams !== false,
      "The AI draws a diagram when you ask for a map, chart or flow. /visualize, typed by you, still works when it is off.", visualizeKeys, false, "task"),
    onOffRow("Pages the AI makes", context.aiPages !== false,
      "When seeing beats reading (options side by side, a mock-up, a dashboard, a diagram, a report for others), the AI makes a page on this computer and you see it in your browser. Off: the AI is not offered it, so it costs no tokens; /pages still lists the ones made.",
      ["ai_pages"], true, "task"),
    onOffRow("Open pages in the browser", context.openPages !== false,
      "A page the AI makes opens in your browser the first time in a session, and its tab reloads itself after each change. Off: Casper prints the link only (as it always does over SSH or with no desktop).",
      ["open_pages"], true, "step"),
    { label: "New-version notice", value: context.updates === false ? "off" : "on",
      question: `The line and the footer note that say a newer Casper is out are ${context.updates === false ? "off" : "on"}.`, keep: `Keep it ${context.updates === false ? "off" : "on"}`,
      choices: [context.updates === false ? { label: "Turn it on", keys: ["updates"], value: true, shown: "on" } : { label: "Turn it off", keys: ["updates"], value: false, shown: "off" }] },
    onOffRow("Suggestions", context.suggestions !== false,
      "The numbered next steps under a task's receipt (zero tokens).", ["suggestions"], true),
    { label: "Side questions with ?", value: context.sideQuestions === false ? "off" : "on",
      question: context.sideQuestions === false ? "Side questions are off: a line that starts with ? goes to Casper as an ordinary request."
        : "Side questions are on: a line that starts with ? (? what does ECONNRESET mean) goes to your fast model on the side, with no tools, and the task's AI never sees it. Each one uses a few tokens.",
      keep: `Keep them ${context.sideQuestions === false ? "off" : "on"}`,
      choices: [context.sideQuestions === false ? { label: "Turn them on", keys: ["sideQuestions"], value: true, shown: "on" }
        : { label: "Turn them off", keys: ["sideQuestions"], value: false, shown: "off" }] },
    { label: "Built-in skills", value: context.skills.bundled === false ? "off" : "on",
      question: `Casper's built-in skills (careful steps for network work and more) are ${context.skills.bundled === false ? "off" : "on"}. A change applies from the next start.`,
      keep: `Keep them ${context.skills.bundled === false ? "off" : "on"}`,
      choices: [context.skills.bundled === false ? { label: "Turn them on", keys: ["skills", "bundled"], value: true, shown: "on" }
        : { label: "Turn them off", keys: ["skills", "bundled"], value: false, shown: "off" }] },
    onOffRow("GitHub tool", context.github !== false,
      "The AI reads this repo's pull requests and CI through GitHub's gh tool when you ask, after your yes for the repo. It never sees your GitHub login. It re-runs failed checks only after another yes.", ["github"], false, "task"),
    onOffRow("Packs", context.packs !== false,
      "Skill packs you added with /pack add. Their skills cost no tokens until a request fits one. A change applies from the next start.", ["packs"], true),
    money("noteAt", "Spend notes", ["are", "come"], "A quiet line says what a task has spent; it never stops the task."),
    money("pauseAt", "Spend pause", ["is", "comes"], "The task stops and asks before it spends more."),
    cacheRow(context.cache ?? "auto"),
    onOffRow("Local models", context.localModels !== false,
      "Casper looks for Ollama, LM Studio, llama.cpp and vLLM on this computer and lists their models in /model, with no sign-in and no models.json. Servers you added in /model stay either way. A change applies from the next start.",
      ["localModels"], true),
    onOffRow("Page checks", context.pageChecks !== false,
      "After a UI change Casper opens the changed pages in its own browser and checks they load, in every project. A project file can turn them off for itself, not back on.",
      ["pages"], true, "task"),
    showPagesRow(context.showPages ?? "ask"),
    { label: "Work shown", value: display, question: `Work shown: ${display} (${DISPLAY_WORDS[display]}).`, keep: `Keep ${display}`,
      choices: (["quiet", "normal", "detailed"] as const).filter((level) => level !== display)
        .map((level) => ({ label: `${level[0]!.toUpperCase()}${level.slice(1)}`, keys: ["display"], value: level, shown: level })) },
    themeRow(context.theme),
    { label: "Untrusted-text reader", value: reader.enabled ? "on" : "off", applies: "task",
      question: `The untrusted-text reader (casper_read_untrusted) is ${reader.enabled ? "on" : "off"}. It reads logs, mail and forms with a separate model that has no tools, and costs tokens only when the AI uses it.`,
      keep: `Keep it ${reader.enabled ? "on" : "off"}`,
      choices: [reader.enabled ? { label: "Turn it off", keys: readerKeys, value: false, shown: "off" } : { label: "Turn it on", keys: readerKeys, value: true, shown: "on" }] },
    { label: "Helpers that build", value: build ? "on" : "off", applies: "task",
      question: `Helpers that build are ${build ? "on" : "off"}. For a big job with separate parts the AI may start up to 3 builders; each works in its own copy of the project and its change lands in your folder when it ends. They use tokens.`,
      keep: `Keep them ${build ? "on" : "off"}`,
      choices: [build ? { label: "Turn them off", keys: ["delegate", "build"], value: false, shown: "off" }
        : { label: "Turn them on", keys: ["delegate", "build"], value: true, shown: "on" }] },
    { label: "Playwright tests", value: e2e ? "on" : "off", applies: "task",
      question: `Casper runs a project's own Playwright tests (the e2e check) after each change, once they are installed. They are ${e2e ? "on" : "off"}.`,
      keep: `Keep them ${e2e ? "on" : "off"}`,
      choices: [e2e ? { label: "Turn them off", keys: ["verification", "e2e"], value: false, shown: "off" }
        : { label: "Turn them on", keys: ["verification", "e2e"], value: true, shown: "on" }] },
    onOffRow("Send Casper's name to OpenRouter", context.telemetry !== false,
      "On OpenRouter requests Casper sends only the app name and site, so OpenRouter files the use under Casper (kept out of its public rankings for now); nothing about your code. CASPER_TELEMETRY=0 turns it off too.",
      ["telemetry"], false, "step"),
    onOffRow("Sign-ins from other tools", context.otherLogins !== false,
      "/login offers a sign-in Claude Code, Codex CLI or GitHub CLI left on this computer (1 use it, 2 sign in separately, 3 not now). Nothing is taken without your pick. Off: /login only shows its own list.",
      ["other_logins"]),
    onOffRow("Network server updates", context.networkUpdates !== false,
      "Once a day Casper asks GitHub whether casper-network-mcp has a release newer than the one installed, and offers it (1 Not now, 2 Update it), installed from that release's hash lock after a check. Only the server Casper set up is updated. Off: only a new Casper brings a new version.",
      ["network_updates"]),
    onOffRow("Private ssh passwords", context.sshLogin !== false,
      "When ssh you allowed asks for a password or key passphrase, Casper shows its own hidden box (1 No, 2 Yes once, 3 Yes for this session). The AI never sees what you type. Off: ssh gets no box and a login that needs a password fails.",
      ["ssh_login"], false, "step"),
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

/** Every row and where it stands, as "Label: value" joined by " · ", wrapped between rows to fit 80 columns. */
export function atAGlance(rows: readonly Pick<Setting, "label" | "value">[], width = 80): string {
  const lines: string[] = [];
  let line = "";
  for (const item of rows.map((row) => `${row.label}: ${row.value}`)) {
    if (line && `  ${line} · ${item}`.length > width) { lines.push(`  ${line}`); line = item; }
    else line = line ? `${line} · ${item}` : item;
  }
  if (line) lines.push(`  ${line}`);
  return lines.join("\n");
}

/**
 * /settings: Casper's off switches as one numbered list, so nobody edits a config file. 1 is Done; a pick asks
 * with 1 Keep first, writes the answer into ~/.casper/config.yaml and lists the settings again.
 */
export async function runSettings(host: SettingsHost, signal?: AbortSignal, only?: string): Promise<void> {
  for (;;) {
    const context = await host.context();
    if (!context) return;
    const rows = [...settingRows(context), ...mcpSandboxRows(host.mcp?.())].filter((row) => !only || row.label === only);
    if (!host.canAsk && only) {
      host.output.write(`${rows.map((row) => `${row.label}: ${row.value}`).join("\n")}\nRun /${only.toLowerCase()} in a Casper session to change it by number.\n`);
      return;
    }
    if (!host.canAsk) {
      const width = Math.max(...rows.map((row) => row.label.length)) + 2;
      host.output.write(`Settings (${USER_CONFIG}):\n${rows.map((row) => `  ${row.label.padEnd(width)}${row.value}`).join("\n")}\nRun /settings in a Casper session to change one by number.\n`);
      return;
    }
    // `only` (/theme): straight to that row's question, once.
    const picked = only ?? await host.ask(`Settings (saved in ${USER_CONFIG} for you):\n${atAGlance(rows)}\nPick one to change:`,
      [{ label: "Done", description: "nothing changes" }, ...rows.map((row) => ({ label: row.label, description: row.value }))], signal);
    const row = rows.find((candidate) => candidate.label === picked);
    if (!row || signal?.aborted) return;
    const answer = await host.ask(row.question, [{ label: row.keep },
      ...row.choices.map((choice) => ({ label: choice.label, ...(choice.description ? { description: choice.description } : {}) }))], signal);
    const choice = row.choices.find((candidate) => candidate.label === answer);
    if (only && !choice) return;
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
    // Typed during a task: says when the change reaches it (nothing for one that applies now or from the next start).
    const task = host.duringTask && row.applies ? DURING_TASK[row.applies] : "";
    host.output.write(`[settings] ${row.label}: ${choice.shown}. Saved in ${row.savedIn ?? USER_CONFIG}.${task}\n`);
    if (only) return;
  }
}
