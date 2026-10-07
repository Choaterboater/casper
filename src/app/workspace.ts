/** Which folder Casper works in: the question at startup from home or a folder of projects, /project, /new and the
 * build-request offer, and "The work is in ..." after a task in a project inside this folder. Moved from src/app.ts. */

import type { CasperApp } from "../app";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { terminalText } from "../tui/format";
import type { ProjectContext } from "../project/context";
import { findProjectCandidates, hasProjectSignals, inspectProject } from "../project/inspect";
import { childProjectOf, type ChildProject } from "../project/child";
import { orderProjectChoices, recentlyUsedProjects } from "../project/recent";
import { appAgentDir } from "./runtime-start";
import type { VerificationReport, VerificationResult } from "../verify/evidence";
import { VerifierRegistry } from "../verify/registry";
import { workFolderChoices } from "./safe-choices";
import { isOutside } from "../platform/inside";
import { planAutoChecks } from "../verify/mode";
import { NEW_USAGE, parseNewArgs } from "../cli-args";
import { askBuildRequest, buildRequestNote, isEmptyFolder, newProjectFromQuestions, newProjectInEmptyFolder, offerMissingFolder, opened, type NewProjectFlow } from "./new-project";
import { listLines } from "../new/command";
import { defaultNameFor } from "../new/templates";
import { tildePath } from "../new/scaffold";
import { updateFooter, phase } from "./footer";
import { revokeWorkspaceCapabilities } from "./session-branches";
import { writeCheckResult, networkOptions } from "./verification";
import { loadWorkspace } from "./wiring";

/** The last choice of the home-folder and folder-of-projects question. */
const NEW_PROJECT_CHOICE = "New project";

/** A request answered at a question runs next, as if typed at the prompt, keeping what was pasted into it. */
export function queueTypedRequest(app: CasperApp, text: string, pasted: readonly string[] = app.terminal.takeSubmittedPastes()): void {
  app.queuedPrompt = text;
  if (pasted.length) app.linePastes.set(text, pasted);
}

/** The new-project questions go through Casper's own numbered question, on the rich or the plain terminal. */
export function newProjectFlow(app: CasperApp): NewProjectFlow {
  return {
    pick: (question, options, signal) => app.terminal.pick(question, options, signal),
    write: (line) => { if (!app.closing) app.output.write(`${line}\n`); },
    homeDir: app.sessionHomeDir ?? os.homedir(),
    ...(app.createProjectFn ? { create: app.createProjectFn } : {}),
    ...(app.commandAbort ? { signal: app.commandAbort.signal } : {}),
  };
}

/** Startup questions run before any command, so they get their own cancel (Ctrl+C, close). */
export async function newProjectFlowWithAbort<T>(app: CasperApp, work: (flow: NewProjectFlow) => Promise<T>): Promise<T> {
  const outer = { active: app.commandActive, abort: app.commandAbort };
  app.commandActive = true;
  app.commandAbort = outer.abort ?? new AbortController();
  try { return await work(newProjectFlow(app)); }
  finally { app.commandActive = outer.active; app.commandAbort = outer.abort; }
}

/** Interactive startup from the home directory, or from a folder that only holds projects (not a
 * project itself and not inside a git repository), asks which project to open — a launch from ~
 * silently made the whole home directory the workspace, and tasks then scanned all of it. A typed
 * path is validated and must stay inside the launch folder; Esc/empty keeps it. The projects last worked in
 * (saved conversations) lead, then the scan's by last change. Without a rich surface the question cannot
 * render, so the launch folder is stated plainly with the most recent project as the command to open it. */
export async function openProjectFolder(app: CasperApp, cwd: string): Promise<string> {
  const home = app.sessionHomeDir ?? os.homedir();
  const fromHome = path.resolve(cwd) === path.resolve(home);
  let candidates: string[] | undefined;
  if (!fromHome) {
    if (await hasProjectSignals(cwd) || (await inspectProject(cwd)).isGit) return cwd;
    candidates = await findProjectCandidates(cwd, { homeDir: home });
    // An empty folder: one numbered question, on either terminal, offers to start a project right here.
    // Piped input can't answer it, so a pipe gets the command instead.
    // A resumed conversation already belongs to this folder: no question.
    if (!candidates.length && !app.runConversation && await isEmptyFolder(cwd)) {
      if (!app.terminal.canAsk) { app.output.write("[folder] This folder is empty. To start a new project in ~/Projects: casper new\n"); return cwd; }
      const result = await newProjectFlowWithAbort(app, (flow) => newProjectInEmptyFolder(flow, cwd, (text) => queueTypedRequest(app, text)));
      if (opened(result)) return result.dir;
      // "Not now" means this folder: a later build request doesn't ask again.
      app.newProjectOffered = true;
      return cwd;
    }
    if (!candidates.length) return cwd;
    candidates = await orderProjectChoices(candidates, { base: cwd, agentDir: appAgentDir(app) });
  }
  if (!app.terminal.rich) {
    // `casper <folder>` opens that folder, so the hint is one command, no cd and no restart. From home it names
    // the project last worked in (no scan: only the saved conversations), else an example.
    const recent = fromHome ? (await recentlyUsedProjects({ base: home, agentDir: appAgentDir(app) }))[0] : undefined;
    app.output.write(fromHome
      ? recent ? `[folder] Opened in your home folder. To work in ${terminalText(path.basename(recent))}: casper ${terminalText(tildePath(recent, home))}\n`
        : `[folder] Opened in your home folder. To work in a project: casper ~/Projects/myapp\n`
      : `[folder] This folder holds several projects. To work in one: casper ${terminalText(path.relative(cwd, candidates![0]!))}\n`);
    app.output.write("[folder] To start a new project instead: casper new\n");
    return cwd;
  }
  // Projects worked in lately lead (Enter opens the last one), then the scan's by last change.
  candidates ??= await orderProjectChoices(await findProjectCandidates(cwd, { homeDir: home }), { base: home, agentDir: appAgentDir(app) });
  const base = fromHome ? home : cwd;
  const folderLabel = (folder: string) => fromHome
    ? folder === home ? "~" : `~${folder.slice(home.length)}`
    : folder === cwd ? "." : path.relative(cwd, folder);
  // Messages name the folder: "staying in Documents", never "staying in .".
  const folderName = fromHome ? "your home folder" : path.basename(cwd) || cwd;
  const byLabel = new Map<string, string>(candidates.map(candidate => [folderLabel(candidate), candidate]));
  const answer = await app.terminal.ask(
    fromHome ? "Opened from your home folder. Work in which project?" : "This folder holds several projects. Work in which one?",
    // The projects lead, so Enter opens the first; staying put is the last choice.
    [
      ...candidates.slice(0, 6).map(candidate => ({ label: folderLabel(candidate) })),
      { label: folderLabel(cwd), description: fromHome ? "stay in the home folder" : ` stay in ${path.basename(cwd)}` },
      { label: NEW_PROJECT_CHOICE, description: fromHome ? "start one in ~/Projects" : ` start one in ${path.basename(cwd)}` },
    ],
    false,
  );
  const choice = answer?.[0]?.trim();
  if (!choice) return cwd; // Esc, empty, or the plain-line fallback keeps the launch folder.
  if (choice === NEW_PROJECT_CHOICE) {
    const result = await newProjectFlowWithAbort(app, (flow) => newProjectFromQuestions(flow, {}, fromHome ? undefined : cwd, (text) => queueTypedRequest(app, text)));
    return opened(result) ? result.dir : cwd;
  }
  const resolved = byLabel.get(choice) ?? path.resolve(cwd, choice.replace(/^~(?=\/|$)/, home));
  const relative = path.relative(path.resolve(base), path.resolve(resolved));
  if (isOutside(relative)) {
    app.output.write(`[folder] ${terminalText(choice)} is outside ${fromHome ? "your home directory" : "the folder you opened"}; staying in ${folderName}.\n`);
    return cwd;
  }
  const info = await stat(resolved).catch(() => undefined);
  if (!info) {
    // A name that isn't there: offer to make it (Enter stays). From home it goes in ~/Projects, like /new.
    const result = await newProjectFlowWithAbort(app, (flow) => offerMissingFolder(flow, terminalText(choice), fromHome ? undefined : cwd,
      folderName, fromHome ? "in ~/Projects" : "here"));
    return opened(result) ? result.dir : cwd;
  }
  if (!info.isDirectory()) {
    app.output.write(`[folder] ${terminalText(choice)} is not a folder; staying in ${folderName}.\n`);
    return cwd;
  }
  return resolved;
}

/**
 * `/project <name>`: a project folder inside this one (typed as a path, or the name of one Casper finds two
 * levels down). Before the model starts Casper opens it; a name that isn't there offers "1 Stay in Documents ·
 * 2 Make <name> here" (Enter stays). Once the conversation has started its folder is fixed, so Casper says the
 * command to use instead.
 */
export async function openProjectCommand(app: CasperApp, name: string): Promise<void> {
  const root = app.activeWorkspaceRoot();
  const home = app.sessionHomeDir ?? os.homedir();
  const folder = path.basename(root) || root;
  const typed = terminalText(name);
  const inside = (dir: string) => { const relative = path.relative(root, dir); return relative !== "" && !isOutside(relative); };
  const direct = path.resolve(root, name.replace(/^~(?=\/|$)/, home));
  let target: string | undefined;
  if (inside(direct) && (await stat(direct).catch(() => undefined))?.isDirectory()) target = direct;
  else {
    const wanted = name.toLowerCase().replace(/\/+$/, "");
    target = (await findProjectCandidates(root, { homeDir: home })).find((dir) => inside(dir)
      && (path.basename(dir).toLowerCase() === wanted || path.relative(root, dir).split(path.sep).join("/").toLowerCase() === wanted));
  }
  if (target && !canMoveWorkspace(app)) {
    const display = terminalText(tildePath(target, home));
    app.output.write(`[folder] This conversation stays in ${terminalText(folder)}. To work in ${terminalText(path.basename(target))}: cd ${display} && casper\n`);
    return;
  }
  if (target) { await openWorkspaceBeforeRuntime(app, target); return; }
  if (!canMoveWorkspace(app) || !app.interactive || !app.terminal.canAsk) {
    app.output.write(`[folder] ${typed} isn't a folder in ${terminalText(folder)}. To start it as a new project: ${app.interactive ? "/new" : "casper new"} ${typed}\n`);
    return;
  }
  const result = await offerMissingFolder(newProjectFlow(app), typed, root, terminalText(folder));
  if (app.closing || !opened(result) || app.commandAbort?.signal.aborted) return;
  await openWorkspaceBeforeRuntime(app, result.dir);
}

/** Moves Casper to another folder. Before the model starts it just opens it. After, the conversation here ends
 * (it stays in /resume in this folder) and the next request starts a new one there. */
export async function moveWorkspace(app: CasperApp, dir: string): Promise<void> {
  if (!canMoveWorkspace(app)) {
    if (app.subagents.isBusy) { app.output.write("[folder] Helpers are still working; nothing moved.\n"); return; }
    await revokeWorkspaceCapabilities(app);
    app.unsubscribe?.();
    app.unsubscribe = undefined;
    const runtime = app.runtime;
    app.session = undefined;
    app.runtimeStart = undefined;
    app.runtimeLoad = undefined;
    app.runtime = undefined;
    app.sessionWorkspace = undefined;
    app.runConversation = undefined;
    await runtime?.dispose().catch(() => {});
    await openWorkspaceBeforeRuntime(app, dir);
    app.output.write("[folder] Your next request starts a new conversation there; the one here stays in /resume in the old folder.\n");
    return;
  }
  await openWorkspaceBeforeRuntime(app, dir);
}

/** The workspace can move only before the model starts: the conversation's folder is fixed once it exists. */
export function canMoveWorkspace(app: CasperApp): boolean {
  return !app.session && !app.runtimeStart && !app.sessionWorkspace && !app.sessionWorkspaceStart && !app.runConversation
    && !app.runtimeTools.length;
}

/** Opens a new project's folder as the workspace before any model runtime exists, so the conversation starts there. */
export async function openWorkspaceBeforeRuntime(app: CasperApp, dir: string): Promise<void> {
  await revokeWorkspaceCapabilities(app);
  const { context } = await loadWorkspace(app, dir);
  app.workspaceNeedsRebind = false;
  app.output.write(`[folder] Working in ${terminalText(tildePath(context.info.root, app.sessionHomeDir ?? os.homedir()))}\n`);
  updateFooter(app);
}

/** /new [name] | /new <template> <name> | /new --list: the same local build as `casper new`, no model. */
export async function newProjectCommand(app: CasperApp, args: string): Promise<void> {
  const words = args ? args.split(/\s+/) : [];
  const usage = NEW_USAGE.replace(/casper new/g, "/new");
  const command = parseNewArgs(words);
  if (!command) { app.output.write(`${usage}\n`); return; }
  if (command.help) {
    app.output.write(`${usage}\nA lone kind word builds that kind and asks only the name. The kinds:\n${listLines().map((line) => `  ${line}`).join("\n")}\n`);
    return;
  }
  if (command.list) { app.output.write(`${listLines().join("\n")}\n`); return; }
  const canAsk = app.interactive && app.terminal.canAsk;
  // A lone kind word where nobody can be asked the name: the kind's usual name, like casper new.
  if (!canAsk && command.template && !command.name) command.name = defaultNameFor(command.template);
  if (!canAsk && (!command.template || !command.name)) {
    app.output.write(`/new needs a template and a name when Casper can't ask. ${usage}\n`);
    return;
  }
  // A request typed at "What are you building?" runs next, in the new project when the conversation can move there.
  let typed: string | undefined;
  let typedPastes: string[] = [];
  const result = await newProjectFromQuestions(newProjectFlow(app), command, undefined, (text) => { typed = text; typedPastes = app.terminal.takeSubmittedPastes(); });
  if (app.closing) return;
  if (!result) { app.output.write("Nothing was created.\n"); return; }
  if (!opened(result) || app.commandAbort?.signal.aborted) return;
  if (canMoveWorkspace(app)) { await openWorkspaceBeforeRuntime(app, result.dir); if (typed) queueTypedRequest(app, typed, typedPastes); return; }
  app.output.write(`[folder] This conversation stays in ${terminalText(tildePath(app.activeWorkspaceRoot(), app.sessionHomeDir ?? os.homedir()))}. `
    + `To work in it, run: casper ${terminalText(result.displayDir)}\n`);
  // The conversation can't move there, so the typed request isn't run here: say so, never drop it silently.
  if (typed) app.output.write(`[new] Your request didn't run here. Run casper ${terminalText(result.displayDir)} and type it there.\n`);
}

/**
 * A build request outside a project, before the model starts: one numbered question, zero tokens.
 * Yes (2) builds the project and opens it, so the conversation and its checks start there. Use this folder
 * (1, Enter) or Esc changes nothing. One-shot and --json runs can't ask: they keep the folder and say so.
 * "stop" when the project could not be built: nothing goes to the model.
 */
export async function offerNewProject(app: CasperApp, prompt: string): Promise<"stop" | undefined> {
  if (app.newProjectOffered || !canMoveWorkspace(app)) return undefined;
  const context = app.projectContext!;
  if (context.info.isGit || await hasProjectSignals(context.info.root)) return undefined;
  if (!app.interactive || !app.terminal.canAsk) {
    const note = buildRequestNote(prompt);
    if (note) { app.newProjectOffered = true; app.output.write(`${note}\n`); }
    return undefined;
  }
  const answer = await askBuildRequest(newProjectFlow(app), prompt);
  if (!answer) return undefined;
  app.newProjectOffered = true;
  app.beforeWorkAsked = true;
  if (app.closing || app.commandAbort?.signal.aborted) return "stop";
  if ("keep" in answer) return undefined;
  if ("stopped" in answer) { app.output.write("Nothing was sent to the model.\n"); return "stop"; }
  await openWorkspaceBeforeRuntime(app, answer.result.dir);
  return undefined;
}

/** The one project folder inside the open folder that holds every file this task changed, when the open folder
 * is not a project itself (Documents, not a repository). */
export async function childProjectOfTask(app: CasperApp, context: ProjectContext, changed: readonly string[]): Promise<ChildProject | undefined> {
  const root = context.info.root;
  if (!changed.length || context.info.isGit || await hasProjectSignals(root)) return undefined;
  return childProjectOf(root, changed, app.sessionHomeDir ?? os.homedir()).catch(() => undefined);
}

/** That project's own detected checks (python -m unittest, pytest, bun test ...), run once in its folder, in the
 * shell sandbox like every check, for this task's receipt. No repair: the conversation's folder is this one.
 * Undefined when the child has no check for these files. */
export async function runChildChecks(app: CasperApp, child: ChildProject, changed: readonly string[]): Promise<VerificationReport | undefined> {
  const prefix = `${child.relative}/`;
  const inside = changed.filter((file) => file.split(path.sep).join("/").startsWith(prefix)).map((file) => file.split(path.sep).join("/").slice(prefix.length));
  const plan = planAutoChecks({ commands: child.model.commands, scopes: child.model.verificationScopes, changedPaths: inside, root: child.dir });
  if (!plan.run.length) return undefined;
  const label = `checks from ${child.relative}`;
  app.events.ensureLineBreak();
  app.output.write(`… Casper checking: ${plan.run.join(", ")} (${terminalText(label)})\n`);
  const registry = VerifierRegistry.forProject(child.model, app.projectContext!.verification.timeoutMs, app.blockOnCleanupFailure, networkOptions(app));
  phase(app, "checks", "start");
  try {
    const results: VerificationResult[] = [];
    await registry.run(plan.run, { ...(app.commandAbort ? { signal: app.commandAbort.signal } : {}),
      onResult: (result) => { const labelled = { ...result, label }; results.push(labelled); writeCheckResult(app, labelled); } });
    const status = results.some((result) => result.status === "fail") ? "fail" as const
      : results.length && results.every((result) => result.status === "pass") ? "pass" as const : "incomplete" as const;
    return { status, repairAttempts: 0, rounds: [results], results };
  } finally { phase(app, "checks", "end"); }
}

/** After the receipt: "The work is in ~/Documents/sample-tools. 1 Stay here · 2 Switch there". Enter stays. A run
 * that can't ask says the command to use. */
export async function offerWorkFolder(app: CasperApp, child: ChildProject): Promise<void> {
  const home = app.sessionHomeDir ?? os.homedir();
  const display = terminalText(tildePath(child.dir, home));
  if (!app.interactive || !app.terminal.canAsk) {
    app.output.write(`[folder] The work is in ${display}. To work there: cd ${display} && casper\n`);
    return;
  }
  // Asked once per folder: after "Stay here", later tasks in the same project don't ask again this session.
  if (app.stayedOutOf.has(child.dir)) return;
  const choices = workFolderChoices(terminalText(path.basename(app.activeWorkspaceRoot())), terminalText(child.relative));
  const picked = await app.terminal.pick(`The work is in ${display}.`, choices, app.commandAbort?.signal);
  if (app.closing) return;
  if (picked?.trim() !== choices[1]!.label) { app.stayedOutOf.add(child.dir); return; }
  await moveWorkspace(app, child.dir);
}
