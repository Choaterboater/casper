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
import { askBuildRequest, buildFromFirstRequest, buildInEmptyFolder, buildRequestNote, isEmptyFolder, newProjectFromQuestions, offerMissingFolder, opened, type NewProjectFlow } from "./new-project";
import { listLines, projectsFolder } from "../new/command";
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

/** A drive or filesystem root (C:\\, D:\\, /): as broad a workspace as the home folder. */
export function isDriveRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === path.parse(resolved).root;
}

/** The one plain line for a folder that holds projects: the count, up to four names, and the command to open the
 * most recent. Nothing for fewer than two. */
export function projectsHeldLine(cwd: string, candidates: readonly string[]): string | undefined {
  if (candidates.length < 2) return undefined;
  const names = candidates.slice(0, 4).map((candidate) => terminalText(path.basename(candidate)));
  const more = candidates.length - names.length;
  return `[folder] This folder holds ${candidates.length} projects (${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}). `
    + `To work in one: casper ${terminalText(path.relative(cwd, candidates[0]!))}\n`;
}

/** Interactive startup opens the folder Casper was launched in. A project, or a folder inside a git repository,
 * opens with no question. The home folder or a drive root is too broad to work in (the sandbox lets the AI write
 * anywhere in the workspace and tasks scan it), so those ask which project to open: the projects last worked in
 * (saved conversations) lead, then the scan's by last change; staying put and New project come after. A typed
 * path is validated and must stay inside the launch folder; Esc/empty keeps it. Any other folder, even one that
 * only holds projects, opens exactly there, with one line naming them. Without a rich surface the question cannot
 * render, so the launch folder is stated plainly with the most recent project as the command to open it. */
export async function openProjectFolder(app: CasperApp, cwd: string): Promise<string> {
  const home = app.sessionHomeDir ?? os.homedir();
  const fromHome = path.resolve(cwd) === path.resolve(home);
  const atRoot = !fromHome && isDriveRoot(cwd);
  const broad = fromHome || atRoot;
  let candidates: string[] | undefined;
  if (!broad) {
    if (await hasProjectSignals(cwd) || (await inspectProject(cwd)).isGit) return cwd;
    candidates = await findProjectCandidates(cwd, { homeDir: home, limit: 50 });
    // An empty folder starts quietly: no question. A first request that fits a template builds it here (offerNewProject).
    if (candidates.length > 1) candidates = await orderProjectChoices(candidates, { base: cwd, agentDir: appAgentDir(app) });
    const line = projectsHeldLine(cwd, candidates);
    if (line) app.output.write(line);
    return cwd;
  }
  if (!app.terminal.rich) {
    // `casper <folder>` opens that folder, so the hint is one command, no cd and no restart. From home it names
    // the project last worked in (no scan: only the saved conversations), else an example.
    const recent = (await recentlyUsedProjects({ base: fromHome ? home : cwd, agentDir: appAgentDir(app) }))[0];
    const where = fromHome ? "your home folder" : "the top of a drive";
    app.output.write(
      recent ? `[folder] Opened in ${where}. To work in ${terminalText(path.basename(recent))}: casper ${terminalText(tildePath(recent, home))}\n`
        : `[folder] Opened in ${where}. To work in a project: casper ~/Projects/myapp\n`);
    app.output.write("[folder] To start a new project instead: casper new\n");
    return cwd;
  }
  // Projects worked in lately lead (Enter opens the last one), then the scan's by last change.
  candidates ??= await orderProjectChoices(await findProjectCandidates(cwd, { homeDir: home }), { base: fromHome ? home : cwd, agentDir: appAgentDir(app) });
  const base = fromHome ? home : cwd;
  const folderLabel = (folder: string) => fromHome
    ? folder === home ? "~" : `~${folder.slice(home.length)}`
    : folder === cwd ? "." : path.relative(cwd, folder);
  // Messages name the folder: "staying in Documents", never "staying in .".
  const folderName = fromHome ? "your home folder" : atRoot ? "the top of the drive" : path.basename(cwd) || cwd;
  const byLabel = new Map<string, string>(candidates.map(candidate => [folderLabel(candidate), candidate]));
  const answer = await app.terminal.ask(
    fromHome ? "Opened from your home folder. Work in which project?" : "Opened from the top of a drive. Work in which project?",
    // The projects lead, so Enter opens the first (the workspace is too broad to stay in by default); staying put is
    // the next-to-last choice.
    [
      ...candidates.slice(0, 6).map(candidate => ({ label: folderLabel(candidate) })),
      { label: folderLabel(cwd), description: fromHome ? "stay in the home folder" : "stay at the top of the drive" },
      { label: NEW_PROJECT_CHOICE, description: "start one in ~/Projects" },
    ],
    false,
  );
  const choice = answer?.[0]?.trim();
  if (!choice) return cwd; // Esc, empty, or the plain-line fallback keeps the launch folder.
  if (choice === NEW_PROJECT_CHOICE) {
    // No questions: Casper starts in ~/Projects, and the first request makes the project (offerNewProject).
    const parent = await projectsFolder(home).catch(() => undefined);
    if (!parent) { app.output.write("[new] Couldn't make ~/Projects; staying here.\n"); return cwd; }
    app.pendingNewProject = true;
    app.output.write(`[new] Starting a new project in ${terminalText(tildePath(parent, home))}. Say what you want; its folder is made from your first request.\n`);
    return parent;
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
    const result = await newProjectFlowWithAbort(app, (flow) => offerMissingFolder(flow, terminalText(choice), undefined, folderName, "in ~/Projects"));
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
 * A request outside a project, before the model starts, zero tokens. In an empty folder (and after "New project"
 * from home) nothing is asked: a request that fits a template builds it, one plain line says which, and the
 * conversation starts in the project. Any other request goes to the model as it is. In a folder that holds other
 * things (Documents) one numbered question stays: Use this folder (1, Enter), Yes (2) or Other kind (3). One-shot
 * and --json runs can't be asked and can't see a line: they keep the folder and say the command.
 * "stop" when the project could not be built: nothing goes to the model.
 */
export async function offerNewProject(app: CasperApp, prompt: string): Promise<"stop" | undefined> {
  const pending = app.pendingNewProject;
  if ((app.newProjectOffered && !pending) || !canMoveWorkspace(app)) return undefined;
  const context = app.projectContext!;
  if (context.info.isGit || await hasProjectSignals(context.info.root)) { app.pendingNewProject = false; return undefined; }
  const templatesOn = context.templates !== false;
  let built: Awaited<ReturnType<typeof buildInEmptyFolder>> | undefined;
  if (pending && app.interactive) {
    app.pendingNewProject = false;
    built = await buildFromFirstRequest(newProjectFlow(app), prompt, templatesOn);
    if (!built) { app.newProjectOffered = true; return undefined; }
  } else if (app.interactive && await isEmptyFolder(context.info.root)) {
    built = await buildInEmptyFolder(newProjectFlow(app), context.info.root, prompt, templatesOn);
  } else if (!app.interactive || !app.terminal.canAsk) {
    const note = buildRequestNote(prompt);
    if (note) { app.newProjectOffered = true; app.output.write(`${note}\n`); }
    return undefined;
  } else {
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
  if ("none" in built) return undefined;
  app.newProjectOffered = true;
  app.beforeWorkAsked = true;
  if (app.closing || app.commandAbort?.signal.aborted) return "stop";
  if ("stopped" in built) { app.output.write("Nothing was sent to the model.\n"); return "stop"; }
  await openWorkspaceBeforeRuntime(app, built.result.dir);
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
  const plan = planAutoChecks({ commands: child.model.commands, scopes: child.model.verificationScopes, changedPaths: inside });
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
