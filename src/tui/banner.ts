import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ProjectContext } from "../project/context";
import { CASPER_VERSION } from "../version";
import { paint } from "./format";

function displayList(values: string[]): string {
  return values.length ? values.join(" · ") : "(not detected)";
}

/** Casper the ghost: half-block pixel art, eyes are the two blank cells, scalloped hem. */
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
  const art = ["", ...GHOST.map((row, index) => `${paint(row, "1;37", color)}  ${paint(WORDMARK[index]!, "36", color)}`), "",
    ` version   ${CASPER_VERSION} · your coding companion`];
  return { render: width => width >= WORDMARK_COLUMNS ? art : wrapTextWithAnsi(paint(TEXT_HEADER, "1;36", color), width), invalidate() {} };
}

export function renderProjectSummary(context: ProjectContext): string {
  const { info, model } = context;
  return [
    ` project   ${model.project.name}`,
    ` stack     ${displayList([...model.languages, ...model.frameworks])}`,
    ` package   ${model.packageManager ?? "(not detected)"}`,
    ` build     ${model.commands.build ?? "(not detected)"}`,
    ` test      ${model.commands.test ?? "(not detected)"}`,
    ` profile   ${context.profileName}`,
    ` branch    ${info.gitBranch ?? "(no git branch)"}`,
  ].join("\n");
}

/** With the wordmark header above, the name and version are already on screen.
 * The slash-command hint is only meaningful where someone can type one. */
export function renderBanner(context: ProjectContext, options: { wordmark?: boolean; interactive?: boolean } = {}): string {
  return [
    ...(options.wordmark ? [] : [TEXT_HEADER]),
    ` project   ${context.model.project.name} · branch ${context.info.gitBranch ?? "(no git branch)"} · profile ${context.profileName}`,
    ...(options.interactive ? [" /help · /status · /login · /model"] : []),
    "",
  ].join("\n");
}
