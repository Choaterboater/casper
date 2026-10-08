import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ProjectContext } from "../project/context";
import { CASPER_VERSION } from "../version";
import { lineText, paint, tint } from "./format";

/** A value from the project's files, on one line: a line break in it can't add a line of its own. */
const one = (text: string): string => lineText(text).replace(/\s+/g, " ").trim();

function displayList(values: string[]): string {
  return values.length ? values.map(one).join(" · ") : "(not detected)";
}

/** Casper the ghost: half-block pixel art, eyes are the two blank cells, scalloped hem. Bold in the terminal's own
 * text color, so it shows on light and dark themes alike. */
const GHOST = [
  " ▄▄███▄▄ ",
  "██ ███ ██",
  "█████████",
  "█████████",
  "█▀██▀██▀█",
];

const WORDMARK = [
  " ██████  █████  ███████ ██████  ███████ ██████ ",
  "██      ██   ██ ██      ██   ██ ██      ██   ██",
  "██      ███████ ███████ ██████  █████   ██████ ",
  "██      ██   ██      ██ ██      ██      ██   ██",
  " ██████ ██   ██ ███████ ██      ███████ ██   ██",
];

/** Narrower terminals get the one-line text banner instead of a wrapped wordmark. */
export const WORDMARK_COLUMNS = GHOST[0]!.length + 2 + WORDMARK[0]!.length;

const TEXT_HEADER = `CASPER ${CASPER_VERSION} · your coding companion`;

/** Trusted constant art above the version line, already styled, so it bypasses the untrusted-text line
 * classifier. It is chosen per render width: a window narrowed below the art gets the one-line header
 * instead of the art wrapped into fragments. */
export function wordmarkHeader(color: boolean): Component {
  const art = ["", ...GHOST.map((row, index) => `${paint(row, "1", color)}  ${tint(WORDMARK[index]!, "accent", color)}`), "",
    ` version   ${CASPER_VERSION} · your coding companion`];
  return { render: width => width >= WORDMARK_COLUMNS ? art : wrapTextWithAnsi(tint(TEXT_HEADER, "accent", color, "1"), width), invalidate() {} };
}

export function renderProjectSummary(context: ProjectContext): string {
  const { info, model } = context;
  return [
    ` project   ${one(model.project.name)}`,
    ` stack     ${displayList([...model.languages, ...model.frameworks])}`,
    ` package   ${model.packageManager ? one(model.packageManager) : "(not detected)"}`,
    ` build     ${model.commands.build ? one(model.commands.build) : "(not detected)"}`,
    ` test      ${model.commands.test ? one(model.commands.test) : "(not detected)"}`,
    ` profile   ${context.profileName}`,
    ` branch    ${info.gitBranch ? one(info.gitBranch) : "(no git branch)"}`,
  ].join("\n");
}

/** With the wordmark header above, the name and version are already on screen. `model` (the model line or block)
 * comes before the slash-command hint, which is only meaningful where someone can type one. */
export function renderBanner(context: ProjectContext, options: { wordmark?: boolean; interactive?: boolean; checks?: string; shell?: string; model?: string } = {}): string {
  return [
    ...(options.wordmark ? [] : [TEXT_HEADER]),
    ` project   ${one(context.model.project.name)} · branch ${context.info.gitBranch ? one(context.info.gitBranch) : "(no git branch)"} · profile ${context.profileName}`,
    ...(options.checks ? [` checks    ${options.checks}`] : []),
    ...(options.shell ? [` shell     ${options.shell}`] : []),
    ...(options.model ? [options.model] : []),
    ...(options.interactive ? [" /help · /status · /login · /model"] : []),
    "",
  ].join("\n");
}
