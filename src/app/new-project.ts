import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { projectsFolder } from "../new/command";
import { EMPTY_CHOICE, newProjectQuestion, newProjectSuggestion, parseNameAnswer, templateMenu, type NewProjectSuggestion } from "../new/pick";
import { formatNewProjectReceipt } from "../new/receipt";
import { createProject, startingLine, tildePath, type NewProjectOptions, type NewProjectResult } from "../new/scaffold";
import { defaultNameFor, EMPTY_TEMPLATE, getTemplate, isBuildable, listTemplates, NAME_RULE, projectSlug, validName } from "../new/templates";
import { missingFolderChoices } from "./safe-choices";

/**
 * The new-project questions inside an app session: `casper new` on a terminal, the question when Casper
 * starts in an empty folder or a folder of projects, the question before the model starts on a build
 * request outside a project, and /new. All local: numbered choices, no model call, zero tokens. The
 * answer is always the user's own (Casper's questions never reach the AI's ask tool).
 */

export type Pick = (question: string, options: { label: string; description?: string }[], signal?: AbortSignal) => Promise<string | undefined>;

export interface NewProjectFlow {
  pick: Pick;
  write: (line: string) => void;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Builds the project; tests pass a fake. */
  create?: (options: NewProjectOptions) => Promise<NewProjectResult>;
}

/** Tries at a question before Casper gives up on it. */
const PICK_TRIES = 3;

/** The question through the host, with a typed label ("yes") read as that choice on both terminals. A number
 * that isn't one of the choices ("4" of three) is never read as typed text: the question is asked again. */
async function choose(flow: NewProjectFlow, question: string, options: { label: string; description?: string }[]): Promise<string | undefined> {
  for (let attempt = 0; attempt < PICK_TRIES; attempt++) {
    const answer = await flow.pick(question, options, flow.signal);
    if (answer === undefined) return undefined;
    const label = options.find((option) => option.label.toLowerCase() === answer.trim().toLowerCase())?.label;
    if (label) return label;
    if (options.length > 1 && /^\d+$/.test(answer.trim())) { flow.write(`[new] Pick a number from 1 to ${options.length}.`); continue; }
    return answer;
  }
  return undefined;
}

/** Short yes and no typed at "Build this as a new …?": they answer it and are never a project name. */
const TYPED_YES = new Set(["y", "yes", "yep", "yeah", "ok", "okay", "sure"]);
const TYPED_NO = new Set(["n", "no", "nope", "nah", "not now", "cancel", "skip"]);

/** Tries for a name before Casper gives up. */
const NAME_TRIES = 3;

type Choice = { label: string; description?: string };

export interface AskTemplateOptions {
  /** A way out that builds nothing, first, so Enter never picks a kind. */
  extra?: Choice;
  /** Replaces "What are you building?". */
  question?: string;
  /** Offer "My own" (an empty folder). Default true. */
  empty?: boolean;
  /** Text that is plainly a request (a few words, not a choice) is handed here and answers `extra`. */
  request?: (text: string) => void;
}

/** A pasted or typed request at a question, not a slip of a choice: three words or more. */
const looksLikeRequest = (text: string) => text.trim().split(/\s+/).length >= 3;

/** A typed template id ("web-app", "empty") picks it. */
function typedTemplate(answer: string): string | undefined {
  const typed = answer.trim().toLowerCase();
  return isBuildable(typed) ? typed : undefined;
}

/**
 * "What are you building?" A short list of kinds (Network, MCP server, Web app or dashboard, Python tool,
 * My own), then, for a kind with more than one template, which one, with Back first. The template id,
 * EMPTY_TEMPLATE, "extra", or undefined for Esc. Nothing is locked in: Back returns to the kinds.
 */
export async function askTemplate(flow: NewProjectFlow, options: AskTemplateOptions = {}): Promise<string | "extra" | undefined> {
  const menu = templateMenu();
  const empty = options.empty ?? true;
  const kinds: Choice[] = [...(options.extra ? [options.extra] : []), ...menu.groups.map(({ label, description }) => ({ label, description })),
    ...(empty ? [EMPTY_CHOICE] : [])];
  for (let round = 0; round < PICK_TRIES; round++) {
    const answer = await choose(flow, options.question ?? menu.question, kinds);
    if (answer === undefined) return undefined;
    if (options.extra && answer === options.extra.label) return "extra";
    if (empty && answer === EMPTY_CHOICE.label) return EMPTY_TEMPLATE;
    const group = menu.groups.find((entry) => entry.label === answer);
    if (!group) {
      const typed = typedTemplate(answer);
      if (typed && (empty || typed !== EMPTY_TEMPLATE)) return typed;
      if (options.extra && options.request && looksLikeRequest(answer)) { options.request(answer.trim()); return "extra"; }
      flow.write(`[new] ${answer.trim()} isn't one of the choices.`);
      return undefined;
    }
    if (group.ids.length === 1) return group.ids[0];
    const back = { label: "Back", description: "the kinds again" };
    const which = await choose(flow, group.question, [back, ...group.choices.map((label) => ({ label }))]);
    if (which === undefined) return undefined;
    if (which === back.label) continue;
    const index = group.choices.indexOf(which);
    if (index >= 0) return group.ids[index];
    const typed = typedTemplate(which);
    if (typed && typed !== EMPTY_TEMPLATE) return typed;
    flow.write(`[new] ${which.trim()} isn't one of the choices.`);
    return undefined;
  }
  return undefined;
}

/** Why a name can't be used in `parent`, or undefined when it can. */
export async function nameProblem(parent: string, name: string, home: string): Promise<string | undefined> {
  if (!validName(name)) return NAME_RULE;
  const dir = path.join(parent, name);
  const info = await lstat(dir).catch(() => undefined);
  if (!info) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(dir)).length) return `${tildePath(dir, home)} already exists and isn't empty. Pick another name.`;
  return undefined;
}

/** "Name it? (Enter for my-tool)". Asked again after a bad or taken name; undefined for Esc. Words that aren't
 * a name ("a thing like a config backup tool") become the next Enter choice (config-backup-tool). */
export async function askName(flow: NewProjectFlow, parent: string, fallback: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < NAME_TRIES; attempt++) {
    const answer = await choose(flow, `Name it? (Enter for ${fallback})`, [{ label: fallback }]);
    if (answer === undefined) return undefined;
    const parsed = parseNameAnswer(answer, fallback);
    const problem = "error" in parsed ? parsed.error : await nameProblem(parent, parsed.name, flow.homeDir);
    if (!problem) return (parsed as { name: string }).name;
    const slug = "error" in parsed ? projectSlug(answer) : "";
    if (slug && !(await nameProblem(parent, slug, flow.homeDir))) {
      flow.write(`[new] Names use lowercase letters, digits and dashes. Press Enter for ${slug}, or type another name.`);
      fallback = slug;
      continue;
    }
    flow.write(`[new] ${problem}`);
  }
  return undefined;
}

/** Builds it with progress lines, then prints the result. Nothing here calls a model. */
export async function buildProject(flow: NewProjectFlow, parent: string, template: string, name: string): Promise<NewProjectResult> {
  const create = flow.create ?? createProject;
  flow.write(startingLine(tildePath(path.join(parent, name), flow.homeDir), template));
  const result = await create({ parent, name, template, homeDir: flow.homeDir, onStep: flow.write,
    ...(flow.env ? { env: flow.env } : {}), ...(flow.signal ? { signal: flow.signal } : {}) });
  for (const line of formatNewProjectReceipt(result)) flow.write(line);
  return result;
}

/** A result Casper can open: the folder exists, ready or not. */
export function opened(result: NewProjectResult | undefined): result is NewProjectResult & { status: "ready" | "created" } {
  return result !== undefined && result.status !== "not_created";
}

/** The full question set for `casper new` and /new: the kind and the name when missing, then the build
 * in `parent` (~/Projects by default). Undefined when the user stopped at a question. */
export async function newProjectFromQuestions(flow: NewProjectFlow, given: { template?: string; name?: string }, parentDir?: string): Promise<NewProjectResult | undefined> {
  const template = given.template ?? await askTemplate(flow);
  if (!template || template === "extra") return undefined;
  const parent = parentDir ?? await projectsFolder(flow.homeDir);
  let name = given.name;
  const taken = name ? await nameProblem(parent, name, flow.homeDir) : undefined;
  if (taken) flow.write(`[new] ${taken}`);
  if (!name || taken) name = await askName(flow, parent, defaultNameFor(template));
  if (!name) return undefined;
  return buildProject(flow, parent, template, name);
}

/** Empty: no entries at all (createProject only builds in an empty folder). */
export async function isEmptyFolder(dir: string): Promise<boolean> {
  try { return (await readdir(dir)).length === 0; } catch { return false; }
}

/** Started in an empty folder: "This folder is empty. Start a new project here?" "Not now" first (so Enter builds
 * nothing), then the kinds. A request typed (or pasted) at the question means Not now: it goes to `request`,
 * to run as the first request here.
 * The folder's own name is used when it is a valid name; otherwise Casper asks one and builds inside it. */
export async function newProjectInEmptyFolder(flow: NewProjectFlow, dir: string, request?: (text: string) => void): Promise<NewProjectResult | undefined> {
  const template = await askTemplate(flow, { question: "This folder is empty. Start a new project here?",
    extra: { label: "Not now", description: "just work in this folder" }, empty: false, ...(request ? { request } : {}) });
  if (!template || template === "extra") return undefined;
  const own = path.basename(dir);
  if (validName(own)) return buildProject(flow, path.dirname(dir), template, own);
  const name = await askName(flow, dir, defaultNameFor(template));
  return name ? buildProject(flow, dir, template, name) : undefined;
}

export type BuildRequestAnswer = { result: NewProjectResult } | { keep: true; said?: string } | { stopped: true };

/**
 * The question before the model starts, on a build request outside a project: "Build this as a new Mist
 * Python project in ~/Projects/mist-aps? 1 Use this folder · 2 Yes · 3 Other kind". A typed name means
 * Yes with that name. "Use this folder" (Enter) and Esc keep the folder. Undefined when the request isn't one.
 */
export async function askBuildRequest(flow: NewProjectFlow, prompt: string): Promise<BuildRequestAnswer | undefined> {
  const suggestion = newProjectSuggestion(prompt, listTemplates());
  if (!suggestion) return undefined;
  const parent = await projectsFolder(flow.homeDir);
  const parentDisplay = tildePath(parent, flow.homeDir);
  let picked: NewProjectSuggestion | undefined = suggestion === "ask" ? undefined : suggestion;
  let name: string | undefined;
  if (picked) {
    const { question, choices } = newProjectQuestion(picked, parentDisplay);
    const answer = await choose(flow, question, choices.map((label) => ({ label })));
    const typed = answer?.trim().toLowerCase() ?? "";
    if (answer === undefined || answer === "Use this folder" || TYPED_NO.has(typed)) return { keep: true };
    if (answer === "Other kind") picked = undefined;
    else if (answer === "Yes" || TYPED_YES.has(typed)) name = picked.name;
    else {
      const parsed = parseNameAnswer(answer, picked.name);
      const problem = "error" in parsed ? parsed.error : await nameProblem(parent, parsed.name, flow.homeDir);
      if (problem) { flow.write(`[new] ${problem}`); name = await askName(flow, parent, picked.name); if (!name) return { keep: true }; }
      else name = (parsed as { name: string }).name;
    }
  }
  if (!picked) {
    const template = await askTemplate(flow, { extra: { label: "Use this folder" } });
    if (!template || template === "extra") return { keep: true };
    const fallback = suggestion !== "ask" ? suggestion.name : defaultNameFor(template);
    picked = { template, name: fallback, kind: getTemplate(template)?.manifest.kind ?? "empty project" };
  }
  if (name) {
    const taken = await nameProblem(parent, name, flow.homeDir);
    if (taken) { flow.write(`[new] ${taken}`); name = undefined; }
  }
  name ??= await askName(flow, parent, picked.name);
  if (!name) return { keep: true };
  const result = await buildProject(flow, parent, picked.template, name);
  return opened(result) ? { result } : { stopped: true };
}

/** One-shot and --json runs can't ask: they keep the folder and say how to start a project instead. */
export function buildRequestNote(prompt: string): string | undefined {
  const suggestion = newProjectSuggestion(prompt, listTemplates());
  if (!suggestion) return undefined;
  const command = suggestion === "ask" ? "casper new" : `casper new ${suggestion.template} ${suggestion.name}`;
  return `[new] This reads like a new project. Casper can't ask here, so it works in this folder. To start a project instead: ${command}`;
}

/**
 * A folder name typed at "Work in which one?" that isn't there: "sample-tools isn't a folder in Documents.
 * 1 Stay in Documents · 2 Make sample-tools here". Enter stays. Choice 2 runs the /new questions with that name in
 * `parent`. Undefined when nothing was made.
 */
export async function offerMissingFolder(flow: NewProjectFlow, typed: string, parent: string | undefined, folder: string, where = "here"): Promise<NewProjectResult | undefined> {
  const trimmed = typed.trim();
  const name = validName(trimmed) ? trimmed : projectSlug(trimmed);
  if (!name || /[\\/]/.test(trimmed)) {
    flow.write(`[folder] ${trimmed} is not a folder; staying in ${folder}.`);
    return undefined;
  }
  const choices = missingFolderChoices(folder, name, where);
  const answer = await choose(flow, `${trimmed} isn't a folder in ${folder}. Make it?`, choices);
  if (answer !== choices[1]!.label) {
    flow.write(`[folder] Staying in ${folder}.`);
    return undefined;
  }
  return newProjectFromQuestions(flow, { name }, parent);
}
