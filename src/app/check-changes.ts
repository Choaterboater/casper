import type { CasperApp } from "../app";
import type { ProjectModel } from "../project/model";
import { CHECK_CHANGE_CHOICES, CHECK_CHANGE_QUESTION, type CheckChangeOptions } from "../runtime/check-changes";
import { checkCommands, isBuiltinCheck } from "../verify/named";
import { VerifierRegistry } from "../verify/registry";
import { maskText } from "../capabilities/approval";
import { terminalText } from "../tui/format";
import { approveChoice } from "./approvals";
import { taskNetworkOptions } from "./verification";

const overrides = new WeakMap<CasperApp, Map<string, Record<string, string>>>();

/** Reapply approved command replacements (saved or session-only) to this app and project, never to YAML or the
 * cached project model on disk. Other project-file settings still wait for a restart. */
export function applySessionCheckOverrides(app: CasperApp, model: ProjectModel): void {
  const commands = overrides.get(app)?.get(model.project.root);
  for (const [name, command] of Object.entries(commands ?? {})) {
    if (isBuiltinCheck(name)) model.commands[name] = command;
    else if (model.namedChecks?.[name]?.run) model.namedChecks[name] = { ...model.namedChecks[name]!, run: command };
  }
}

export function checkChangeOptions(app: CasperApp): CheckChangeOptions {
  return {
    commands: () => app.projectContext ? checkCommands(app.projectContext.model) : {},
    taskKey: () => app.commandAbort?.signal,
    ask: async (change) => {
      // No truncated approval: the person must see the whole change being approved. Secrets stay hidden.
      const preview = `${change.file}\nOld → new\n--- old\n${change.before}\n+++ new\n${change.after}\n`;
      if (preview.length > 24_000) return undefined;
      const choices = change.sessionCommands ? CHECK_CHANGE_CHOICES : CHECK_CHANGE_CHOICES.slice(0, 2);
      const picked = await approveChoice(app, terminalText(maskText(preview)), CHECK_CHANGE_QUESTION, choices, app.commandAbort?.signal);
      return picked === CHECK_CHANGE_CHOICES[1] ? "save" : picked === CHECK_CHANGE_CHOICES[2] ? "session" : undefined;
    },
    useSessionCommands: (commands) => {
      const context = app.projectContext;
      if (!context) return;
      let projects = overrides.get(app);
      if (!projects) overrides.set(app, projects = new Map());
      projects.set(context.model.project.root, { ...projects.get(context.model.project.root), ...commands });
      applySessionCheckOverrides(app, context.model);
      const registry = VerifierRegistry.forProject(context.model, context.verification.timeoutMs, app.blockOnCleanupFailure, taskNetworkOptions(app));
      app.checkTask?.useRegistry(registry);
      app.verificationTask?.useRegistry(registry);
    },
  };
}
