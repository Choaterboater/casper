/** Which folder Casper works in: the question at startup from home or a folder of projects, /project, /project new and the
 * build-request offer, and "The work is in ..." after a task in a project inside this folder. Moved from src/app.ts. */

import type { CasperApp } from "../app";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { terminalText } from "../tui/format";
import type { ProjectContext } from "../project/context";
import { broadFolder, findProjectCandidates, hasProjectSignals, inspectProject } from "../project/inspect";
import { childProjectOf, type ChildProject } from "../project/child";
import { orderProjectChoices, recentlyUsedProjects } from "../project/recent";
import { appAgentDir } from "./runtime-start";
import type { VerificationReport, VerificationResult } from "../verify/evidence";
import { VerifierRegistry } from "../verify/registry";
import { namedProjectChoices, workFolderChoices } from "./safe-choices";
import { isOutside } from "../platform/inside";
import { planAutoChecks } from "../verify/mode";
import { NEW_USAGE, parseNewArgs, type NewCommand } from "../cli-args";
import { askBuildRequest, buildInEmptyFolder, buildRequestNote, isEmptyFolder, newProjectFromQuestions, offerMissingFolder, opened, type NewProjectFlow } from "./new-project";
import { listLines } from "../new/command";
import { defaultNameFor, EMPTY_TEMPLATE, projectSlug, validName } from "../new/templates";
import { tildePath } from "../new/scaffold";
import type { NoiseOptions } from "../project/noise";
import { updateFooter, phase } from "./footer";
import { revokeWorkspaceCapabilities } from "./session-branches";
import { writeCheckResult, networkOptions } from "./verification";
import { loadWorkspace } from "./wiring";

/** The last choice of the home-folder and folder-of-projects question. */

/** A request answered at a question runs next, as if typed at the prompt, keeping what was pasted into it. */
export function queueTypedRequest(app: CasperApp, text: string, pasted: readonly string[] = app.terminal.takeSubmittedPastes()): void {
  app.queuedPrompt = text;
  if (pasted.length) app.linePastes.set(text, pasted);
}

/** The new-project questions go through Casper's own numbered question, on the rich or the plain terminal. */
export function newProjectFlow(app: CasperApp): NewProjectFlow {
  return {
    pick: (question, options, signal) => app.terminal.pick(question, options, signal, { typed: true }),
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

export { isDriveRoot } from "../project/inspect";

/** A lone CLI word at home or a drive root could be a question or a project name. Ask before either runs. */
export async function initialProjectRequest(app: CasperApp, cwd: string, prompt: string): Promise<NewCommand | undefined> {
  if (!app.terminal.canAsk || !broadFolder(cwd, app.sessionHomeDir ?? os.homedir())
    || /\s/.test(prompt) || prompt.startsWith("/")) return undefined;
  if (await stat(path.resolve(cwd, prompt)).then((entry) => entry.isDirectory(), () => false)) return undefined;
  return newProjectFlowWithAbort(app, async (flow) => {
    const question = `${JSON.stringify(terminalText(prompt))} isn't a folder here.`;
    const name = validName(prompt) ? prompt : projectSlug(prompt) || defaultNameFor(EMPTY_TEMPLATE);
    const choices = [{ label: "Ask it as a question" }, { label: `Start a new project named ${name}` }];
    const answer = await app.terminal.pick(question, choices, flow.signal);
    if (answer === choices[0]!.label) return undefined;
    // Esc cancels the initial request, not the session. Choosing a project never also sends its name to the AI.
    app.queuedPrompt = undefined;
    return answer === choices[1]!.label ? { name, template: EMPTY_TEMPLATE, list: false } : undefined;
  });
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

/** Interactive startup opens the folder Casper was launched in, always, with no question. A folder that holds
 * projects gets one line naming them. The home folder or a drive root is broad (the sandbox lets the AI write
 * anywhere in the workspace and tasks scan it), so there one line says where Casper opened and the command that
 * opens the project last worked in (no scan: only the saved conversations), else an example. */
export async function openProjectFolder(app: CasperApp, cwd: string, env: { platform?: NodeJS.Platform; noise?: NoiseOptions } = {}): Promise<string> {
  const home = app.sessionHomeDir ?? os.homedir();
  const platform = env.platform ?? process.platform;
  const noise: NoiseOptions = { platform, homeDir: home, ...env.noise };
  // Windows shows real paths (C:\Users\alex\Projects); macOS and Linux keep ~/Projects.
  const projectsDisplay = platform === "win32" ? path.win32.join(home, "Projects") : "~/Projects";
  const kind = broadFolder(cwd, home);
  const fromHome = kind === "home";
  const broad = kind !== undefined;
  let candidates: string[] | undefined;
  if (!broad) {
    if (await hasProjectSignals(cwd) || (await inspectProject(cwd)).isGit) return cwd;
    candidates = await findProjectCandidates(cwd, { homeDir: home, limit: 50, noise });
    // An empty folder starts quietly: no question. A first request that fits a template builds it here (offerNewProject).
    if (candidates.length > 1) candidates = await orderProjectChoices(candidates, { base: cwd, agentDir: appAgentDir(app), noise });
    const line = projectsHeldLine(cwd, candidates);
    if (line) app.output.write(line);
    return cwd;
  }
  // `casper <folder>` opens that folder, so the hint is one command, no cd and no restart. From home it names
  // the project last worked in (no scan: only the saved conversations), else an example.
  const recent = (await recentlyUsedProjects({ base: fromHome ? home : cwd, agentDir: appAgentDir(app), noise }))[0];
  // Home is a fine place to start: a request there need not be a project (set up this server, fix the NAS's docker).
  const where = fromHome ? "your home folder: ask for anything here" : "the top of a drive";
  app.output.write(
    recent ? `[folder] Opened in ${where}. To work in ${terminalText(path.basename(recent))}: casper ${terminalText(tildePath(recent, home, platform))}\n`
      : `[folder] Opened in ${where}. To work in a project: casper ${platform === "win32" ? path.win32.join(projectsDisplay, "myapp") : "~/Projects/myapp"}\n`);
  if (!fromHome) app.output.write("[folder] To start a new project instead: casper new\n");
  return cwd;
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
    app.output.write(`[folder] ${typed} isn't a folder in ${terminalText(folder)}. To start it as a new project: ${app.interactive ? "/project new" : "casper new"} ${typed}\n`);
    return;
  }
  const result = await offerMissingFolder(newProjectFlow(app), typed, root, terminalText(folder));
  if (app.closing || !opened(result) || app.commandAbort?.signal.aborted) return;
  await openWorkspaceBeforeRuntime(app, result.dir);
}

/** Moves Casper to another folder. Before the model starts it just opens it. After, the conversation here ends
 * (it stays in /resume in this folder) and the next request starts a new one there; with `carry`, the conversation is
 * copied into the new folder (so /resume there lists it) and the next request continues it there. */
export async function moveWorkspace(app: CasperApp, dir: string, options: { carry?: boolean } = {}): Promise<void> {
  if (!canMoveWorkspace(app)) {
    if (app.subagents.isBusy) { app.output.write("[folder] Helpers are still working; nothing moved.\n"); return; }
    // The work is in that folder: the conversation about it goes too. A copy there, so the one here stays as it was.
    let carried: string | undefined;
    if (options.carry && app.session?.forkSession) {
      try {
        const name = app.session.getSessionInfo?.().name ?? path.basename(dir);
        carried = (await app.session.forkSession({ cwd: dir, name,
          context: `Casper moved this conversation to ${dir}, the folder the work is in. Paths are relative to it from here on.` })).sessionId;
      } catch { carried = undefined; }
    }
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
    if (carried) {
      // Picked up when the model starts there, as --resume would.
      app.runConversation = { resume: carried };
      app.output.write("[folder] This conversation came with you: your next request continues it there.\n");
      return;
    }
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

/** /project new [name] | /project new <template> <name> | /project new --list: the same local build as `casper new`, no model. */
export async function newProjectCommand(app: CasperApp, args: string): Promise<void> {
  const words = args ? args.split(/\s+/) : [];
  const usage = NEW_USAGE.replace(/casper new/g, "/project new");
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
    app.output.write(`/project new needs a template and a name when Casper can't ask. ${usage}\n`);
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
 * A request outside a project, before the model starts, zero tokens. In an empty folder nothing is asked: a request that fits a template builds it, one plain line says which, and the
 * conversation starts in the project. Any other request goes to the model as it is. In a folder that holds other
 * things (Documents) one numbered question stays: Use this folder (1, Enter), Yes (2) or Other kind (3). One-shot
 * and --json runs can't be asked and can't see a line: they keep the folder and say the command.
 * "stop" when the project could not be built: nothing goes to the model.
 */
export async function offerNewProject(app: CasperApp, prompt: string): Promise<"stop" | undefined> {
  if (app.newProjectOffered || !canMoveWorkspace(app)) return undefined;
  const context = app.projectContext!;
  if (context.info.isGit || await hasProjectSignals(context.info.root)) return undefined;
  const templatesOn = context.templates !== false;
  let built: Awaited<ReturnType<typeof buildInEmptyFolder>> | undefined;
  if (app.interactive && await isEmptyFolder(context.info.root)) {
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

/** The project a request names by its folder name ("fix find_tool in casper-tools", a link ending in /casper-tools),
 * among the folders Casper has had conversations in, when it is not the open folder or one holding it. A name with a
 * dash, underscore, dot or digit counts anywhere, in any case. A plain word ("review", "Notes") is an ordinary word
 * too, so it counts only where the request points at a folder: "move to review", "open the review project",
 * "the Notes folder". A name shorter than five letters never counts. */
export function namedProject(request: string, folders: readonly string[], root: string): string | undefined {
  let found: string | undefined;
  for (const dir of folders) {
    const full = path.resolve(dir);
    if (!isOutside(path.relative(full, path.resolve(root)))) continue;
    const name = path.basename(full);
    if (name.length < 5) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = /[-_.\d]/.test(name)
      ? new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)`, "i").test(request)
      : new RegExp(`\\b(?:(?:move|switch|go|cd|change)\\s+(?:over\\s+)?(?:in)?to|open)\\s+(?:the\\s+)?${escaped}\\b(?!-)`
        + `|\\b${escaped}\\s+(?:folder|project|repo|repository|directory)\\b`, "i").test(request);
    if (named && (!found || name.length > path.basename(found).length)) found = full;
  }
  return found;
}

/** Before the model starts, zero tokens: a request naming another project Casper has worked in asks "1 Stay here ·
 * 2 Move there" (Enter stays, asked once per folder). Only the saved conversations' folders are matched: Casper never
 * searches the person's folders for it. Move before the conversation starts opens the folder and the request runs
 * there; after, the conversation here stays in /resume and the request is queued for a new one there ("stop"). */
export async function offerNamedProject(app: CasperApp, request: string, planFirst?: boolean): Promise<"stop" | undefined> {
  if (!app.interactive || !app.terminal.canAsk) return undefined;
  const home = app.sessionHomeDir ?? os.homedir();
  // Only conversation folders ending in a word of the request ("--…-casper-tools--"), however old: not just the newest.
  const words = [...new Set(request.toLowerCase().match(/[\w.-]{5,}/g) ?? [])];
  const named = (folder: string) => words.some((word) => folder.toLowerCase().endsWith(`-${word}--`));
  const folders = words.length ? await recentlyUsedProjects({ base: home, agentDir: appAgentDir(app), named }).catch(() => []) : [];
  const target = namedProject(request, folders, app.activeWorkspaceRoot());
  if (!target || app.stayedOutOf.has(target)) return undefined;
  const display = terminalText(tildePath(target, home));
  const choices = namedProjectChoices(terminalText(path.basename(app.activeWorkspaceRoot())), terminalText(path.basename(target)));
  const picked = await app.terminal.pick(`This request names ${terminalText(path.basename(target))}, in ${display}.`, choices, app.commandAbort?.signal);
  if (app.closing || app.commandAbort?.signal.aborted) return "stop";
  app.beforeWorkAsked = true;
  if (picked?.trim() !== choices[1]!.label) { app.stayedOutOf.add(target); return undefined; }
  if (canMoveWorkspace(app)) { await openWorkspaceBeforeRuntime(app, target); return undefined; }
  await moveWorkspace(app, target);
  // Helpers still working: nothing moved, so the request runs here.
  if (!canMoveWorkspace(app)) return undefined;
  queueTypedRequest(app, planFirst ? `/plan ${request}` : request, []);
  return "stop";
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
  app.output.write(`• Casper checking: ${plan.run.join(", ")} (${terminalText(label)})\n`);
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
  await moveWorkspace(app, child.dir, { carry: true });
}
