/** Named session branches: /branch and /switch move the conversation to another worktree; tools tied to the old
 * folder are revoked and connect again only with fresh consent. Moved from src/app.ts. */

import type { CasperApp } from "../app";
import { formatProjectContext } from "../project/context";
import type { RuntimeSession } from "../runtime/types";
import { CHECK_NAMES } from "../verify/evidence";
import { SessionWorkspaceManager, type ReturnAction } from "../sessions/manager";
import { confirmYes } from "./approvals";
import { stopDebugger } from "./task-tools";

export async function ensureSessionWorkspace(app: CasperApp): Promise<SessionWorkspaceManager> {
  if (app.sessionWorkspace) return app.sessionWorkspace;
  if (!app.sessionWorkspaceStart) {
    const context = app.projectContext!;
    app.sessionWorkspaceStart = SessionWorkspaceManager.open({
      projectRoot: context.info.root,
      gitBranch: context.info.gitBranch,
      policy: context.policy.workspace,
      homeDir: app.sessionHomeDir,
    }).then((manager) => {
      app.sessionWorkspace = manager;
      return manager;
    }).finally(() => { app.sessionWorkspaceStart = undefined; });
  }
  return app.sessionWorkspaceStart;
}

export async function handleBranchCommand(app: CasperApp, prompt: string): Promise<void> {
  if (app.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
  const [, name, ...extra] = prompt.trim().split(/\s+/);
  if (!name || extra.length) throw new Error("Usage: /branch <name>");
  const manager = await ensureSessionWorkspace(app);
  const context = [
    `Casper named session branch: ${name}`,
    `Parent session branch: ${manager.activeName}`,
    app.lastTaskRequest ? `Latest task contract request: ${app.lastTaskRequest}` : "No task request has been submitted in this process.",
    formatProjectContext(app.projectContext!),
  ].join("\n\n");
  const transition = await manager.branch(name, {
    getRuntime: () => runtimeForWorkspaceTransition(app),
    // You typed /branch: no second box. A one-shot run still refuses (a branch is for a session).
    confirm: async () => app.interactive,
    context,
  });
  if (!transition) {
    app.output.write("[sessions] Branch creation not approved.\n");
    return;
  }
  await rebindWorkspace(app, transition.workspacePath);
  app.output.write(`[sessions] active ${transition.name} · ${transition.workspacePath}\n`);
}

export async function handleSwitchCommand(app: CasperApp, prompt: string): Promise<void> {
  if (app.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
  const [, name, action, ...extra] = prompt.trim().split(/\s+/);
  if (!name || extra.length || (action !== undefined && action !== "apply" && action !== "discard")) {
    throw new Error("Usage: /switch <branch> | /switch main <apply|discard>");
  }
  const manager = await ensureSessionWorkspace(app);
  let transition;
  if (action !== undefined) {
    if (name !== "main") throw new Error("Apply/discard is only valid when returning to main");
    transition = await manager.returnToMain(action as ReturnAction, {
      getRuntime: () => runtimeForWorkspaceTransition(app),
      confirm: (preview, question) => confirmYes(app, preview, question),
      verify: async () => (await app.runVerification(
        CHECK_NAMES,
        false,
        `Verify session branch ${manager.activeName} before returning to main.`,
      )).status,
    });
  } else {
    transition = await manager.switch(name, {
      getRuntime: () => runtimeForWorkspaceTransition(app),
      // You typed /switch: no second box. A one-shot run still refuses.
      confirm: async () => app.interactive,
    });
  }
  if (!transition) {
    app.output.write("[sessions] Switch not approved.\n");
    return;
  }
  await rebindWorkspace(app, transition.workspacePath);
  app.output.write(`[sessions] active ${transition.name} · ${transition.workspacePath}\n`);
  if (transition.preservedPath) app.output.write(`[sessions] Candidate files retained for recovery: ${JSON.stringify(transition.preservedPath)}\n`);
  if (transition.cleanupWarning) {
    app.output.write(`[sessions] Return did not complete cleanly; review the session tree and repository state: ${transition.cleanupWarning}\n`);
  }
}

export async function revokeWorkspaceCapabilities(app: CasperApp): Promise<void> {
  app.workspaceNeedsRebind = true;
  if (app.runtimeTools.length && !app.session?.setTools) throw new Error("Runtime cannot revoke workspace capabilities");
  app.session?.setTools?.([]);
  app.runtimeTools = [];
  app.offeredTools.clear();
  await Promise.all([app.broker?.close(), app.lsp?.close(), app.references?.close(), app.browser?.close(), app.services?.close(), stopDebugger(app)]);
  app.browser = undefined;
  app.services = undefined;
  app.debugSession = undefined;
}

export async function runtimeForWorkspaceTransition(app: CasperApp): Promise<RuntimeSession> {
  const session = await app.ensureRuntime();
  await revokeWorkspaceCapabilities(app);
  return session;
}

export async function rebindWorkspace(app: CasperApp, cwd: string): Promise<void> {
  await revokeWorkspaceCapabilities(app);
  app.sessionYes.forget();
  const { context } = await app.loadWorkspace(cwd);
  if (app.closing) throw new Error("Casper is closing");
  app.runtimeTools = [];
  app.session?.setTools?.([]);
  await app.session?.appendContext?.([
    "Casper switched the active workspace for this named session branch.",
    formatProjectContext(context),
  ].join("\n\n"));
  app.workspaceNeedsRebind = false;
  app.output.write(`[sessions] workspace context rebound to ${context.info.root}; MCP/LSP connections require fresh explicit consent.\n`);
}
