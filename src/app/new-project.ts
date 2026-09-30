import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { projectsFolder } from "../new/command";
import { newProjectQuestion, newProjectSuggestion, parseNameAnswer, templateMenu, type NewProjectSuggestion } from "../new/pick";
import { formatNewProjectReceipt } from "../new/receipt";
import { createProject, tildePath, type NewProjectOptions, type NewProjectResult } from "../new/scaffold";
import { getTemplate, listTemplates, NAME_RULE, validName } from "../new/templates";

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

/** "What are you building?" One numbered choice per ready template, with `extra` (a way out that builds
 * nothing) first, so Enter never picks a kind. The template id, "extra", or undefined for Esc. Typed text
 * that names a template picks it. */
export async function askTemplate(flow: NewProjectFlow, extra?: string): Promise<string | "extra" | undefined> {
  const menu = templateMenu();
  const options = [...(extra ? [{ label: extra }] : []), ...menu.choices.map((label) => ({ label }))];
  const answer = await choose(flow, menu.question, options);
  if (answer === undefined) return undefined;
  if (extra && answer === extra) return "extra";
  const index = menu.choices.indexOf(answer);
  if (index >= 0) return menu.ids[index];
  const typed = answer.trim().toLowerCase();
  if (getTemplate(typed)?.manifest.ready) return typed;
  flow.write(`[new] ${answer.trim()} isn't one of the choices.`);
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

/** "Name it? (Enter for my-tool)". Asked again after a bad or taken name; undefined for Esc. */
export async function askName(flow: NewProjectFlow, parent: string, fallback: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < NAME_TRIES; attempt++) {
    const answer = await choose(flow, `Name it? (Enter for ${fallback})`, [{ label: fallback }]);
    if (answer === undefined) return undefined;
    const parsed = parseNameAnswer(answer, fallback);
    const problem = "error" in parsed ? parsed.error : await nameProblem(parent, parsed.name, flow.homeDir);
    if (!problem) return (parsed as { name: string }).name;
    flow.write(`[new] ${problem}`);
  }
  return undefined;
}

/** Builds it with progress lines, then prints the result. Nothing here calls a model. */
export async function buildProject(flow: NewProjectFlow, parent: string, template: string, name: string): Promise<NewProjectResult> {
  const create = flow.create ?? createProject;
  flow.write(`Starting ${tildePath(path.join(parent, name), flow.homeDir)} from template ${template}`);
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
  if (!name || taken) name = await askName(flow, parent, getTemplate(template)!.manifest.defaultName);
  if (!name) return undefined;
  return buildProject(flow, parent, template, name);
}

/** Empty: no entries at all (createProject only builds in an empty folder). */
export async function isEmptyFolder(dir: string): Promise<boolean> {
  try { return (await readdir(dir)).length === 0; } catch { return false; }
}

/** Started in an empty folder: "This folder is empty. Start a new project here?" "Not now" first (so Enter builds
 * nothing), then the kinds.
 * The folder's own name is used when it is a valid name; otherwise Casper asks one and builds inside it. */
export async function newProjectInEmptyFolder(flow: NewProjectFlow, dir: string): Promise<NewProjectResult | undefined> {
  const menu = templateMenu();
  const answer = await choose(flow, "This folder is empty. Start a new project here?",
    [{ label: "Not now", description: "just work in this folder" }, ...menu.choices.map((label) => ({ label }))]);
  const index = answer === undefined ? -1 : menu.choices.indexOf(answer);
  if (index < 0) {
    if (answer !== undefined && answer !== "Not now") flow.write(`[new] ${answer.trim()} isn't one of the choices; nothing was created.`);
    return undefined;
  }
  const template = menu.ids[index]!;
  const own = path.basename(dir);
  if (validName(own)) return buildProject(flow, path.dirname(dir), template, own);
  const name = await askName(flow, dir, getTemplate(template)!.manifest.defaultName);
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
    const template = await askTemplate(flow, "Use this folder");
    if (!template || template === "extra") return { keep: true };
    const manifest = getTemplate(template)!.manifest;
    const fallback = suggestion !== "ask" ? suggestion.name : manifest.defaultName;
    picked = { template, name: fallback, kind: manifest.kind };
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
