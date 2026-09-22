import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { SettingsManager, type AgentSession, type ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyEffort, resolveAutoEffort } from "./auto-effort";
import { isEffortSelection, isModelRole, resolveModelSelection, type ModelReference, type ModelRoles, type ResolvedModelSelection } from "./model-routing";
import type { RuntimeModelSelection, RuntimeModelSelectionOptions, RuntimeReadOnlyStartOptions, RuntimeStatus, RuntimeUsage } from "./types";
import { pickPiModel } from "./pi-model-picker";

type Selection = { reference?: ModelReference; source: "conversation" | "default" | "none"; role?: string; effort?: string; auto?: RuntimeStatus["autoEffort"] };
type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
type Preferences = { modelRoles?: ModelRoles; autoEffortModels?: string[] };
const ENTRY = "casper.model-selection";

/** Shared Pi configuration may supply non-model preferences, never routing policy. */
function withoutModels(settings: Settings): Settings {
  const { defaultProvider, defaultModel, defaultThinkingLevel, modelThinkingLevels, enabledModels, ...rest } = settings;
  return rest;
}

/** Pi owns models, credentials and transcripts. Casper owns explicit routing policy. */
export class PiModels {
  private readonly selections = new WeakMap<AgentSession, Selection>();
  private readonly accounting = new WeakMap<AgentSession, NonNullable<RuntimeUsage["effortClassification"]>>();
  private selecting = false;
  private preparing = false;
  private authenticating = false;
  private readonly staleAuth = new Set<string>();
  private selectionSignal?: AbortSignal;
  private readonly lifetime = new AbortController();
  private selectionDone: Promise<void> = Promise.resolve();
  private preparationDone: Promise<void> = Promise.resolve();
  private readonly directory = path.join(os.homedir(), ".casper");

  constructor(private readonly catalog: ModelRuntime, private readonly agentDir: string) {}
  get busy(): boolean { return this.selecting || this.preparing || this.authenticating; }
  setAuthenticating(active: boolean): void { this.authenticating = active; }
  invalidateAuth(provider: string): void { this.staleAuth.add(provider); }
  async refreshAuth(provider: string, signal: AbortSignal): Promise<boolean> {
    try {
      const result = await this.catalog.refresh({ providers: [provider], allowNetwork: false, signal });
      if (signal.aborted || result.aborted || result.errors.size) return false;
      this.staleAuth.delete(provider);
      return true;
    } catch { return false; }
  }

  private preferences(): SettingsManager {
    // Non-atomic alias preflight, including hardlinks: never write shared Pi settings.
    for (const [file, directory] of [[this.directory, true], [path.join(this.directory, "settings.json"), false]] as const) {
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
          throw new Error("Casper model defaults require an unshared regular settings file in a real .casper directory.");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const settings = SettingsManager.create(this.directory, this.directory, { projectTrusted: false });
    if (settings.drainErrors().length) throw new Error(`Cannot read Casper model defaults at ${path.join(this.directory, "settings.json")}; repair the file before selecting a model.`);
    const provider = settings.getDefaultProvider(); const model = settings.getDefaultModel();
    if ((provider !== undefined || model !== undefined) &&
      (typeof provider !== "string" || !provider.trim() || typeof model !== "string" || !model.trim())) {
      throw new Error("Casper defaultProvider and defaultModel must both be nonempty strings.");
    }
    return settings;
  }

  private policy(): Preferences {
    const settings = this.preferences().getGlobalSettings() as Settings & Preferences;
    const roles = settings.modelRoles;
    if (roles !== undefined && (!roles || typeof roles !== "object" || Array.isArray(roles)
      || Object.entries(roles).some(([role, selector]) => !isModelRole(role) || typeof selector !== "string" || !selector.trim()))) {
      throw new Error("Casper modelRoles must map fast, build, reason or review to nonempty selectors.");
    }
    if (settings.autoEffortModels !== undefined && (!Array.isArray(settings.autoEffortModels)
      || settings.autoEffortModels.some(value => typeof value !== "string"))) throw new Error("Casper autoEffortModels must contain model identifiers.");
    return { modelRoles: roles, autoEffortModels: settings.autoEffortModels };
  }

  private async updatePolicy(update: (settings: Preferences) => void): Promise<void> {
    this.policy();
    const file = path.join(this.directory, "settings.json");
    // Match Pi's proper-lockfile directory lock; never bypass another writer.
    // A stale lock is a visible failure, not permission to overwrite preferences.
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    mkdirSync(lock);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      update(settings);
      writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
      rmdirSync(lock);
    }
  }

  getRoles(): ModelRoles { return { ...this.policy().modelRoles }; }
  async setRole(role: string, selector?: string): Promise<ModelRoles> {
    this.lifetime.signal.throwIfAborted();
    if (this.busy) throw new Error("Wait for active work before changing model roles.");
    if (!isModelRole(role)) throw new Error("Choose a role: fast, build, reason, review.");
    const roles = this.getRoles();
    if (selector !== undefined) {
      roles[role] = selector;
      resolveModelSelection(`@${role}`, this.catalog.getModels(), roles, this.defaultReference());
    } else delete roles[role];
    await this.updatePolicy(settings => { settings.modelRoles = roles; });
    return roles;
  }
  private defaultReference(settings = this.preferences()): ModelReference | undefined {
    const provider = settings.getDefaultProvider(); const id = settings.getDefaultModel();
    return provider && id ? { provider, id } : undefined;
  }
  private autoDefault(reference: ModelReference): boolean {
    return this.policy().autoEffortModels?.includes(`${reference.provider}/${reference.id}`) ?? false;
  }
  private async saveAuto(reference: ModelReference, auto: boolean): Promise<void> {
    const key = `${reference.provider}/${reference.id}`;
    if (this.autoDefault(reference) === auto) return;
    await this.updatePolicy(settings => {
      const models = new Set(settings.autoEffortModels);
      if (auto) models.add(key); else models.delete(key);
      if (models.size) settings.autoEffortModels = [...models]; else delete settings.autoEffortModels;
    });
  }
  private recorded(manager: SessionManager, reference: ModelReference): { effort: string; role?: string } | undefined {
    for (const entry of manager.getBranch().reverse()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data = entry.data as Record<string, unknown> | undefined;
      if (data?.provider === reference.provider && data.model === reference.id && typeof data.effort === "string" && isEffortSelection(data.effort)) {
        return { effort: data.effort, role: typeof data.role === "string" ? data.role : undefined };
      }
    }
    return undefined;
  }
  private record(session: AgentSession): void {
    const selection = this.selections.get(session)!;
    session.sessionManager.appendCustomEntry(ENTRY, { provider: selection.reference!.provider, model: selection.reference!.id, effort: selection.effort, role: selection.role });
    // Export only an unwritten file: exporting existing sessions loses inactive branches.
    if (session.sessionFile && !existsSync(session.sessionFile)) {
      session.exportToJsonl(session.sessionFile);
      session.sessionManager.setSessionFile(session.sessionFile);
    }
  }

  async create<T extends { session: AgentSession }>(cwd: string, manager: SessionManager,
    create: (options: { settingsManager: SettingsManager; modelRuntime: ModelRuntime; model: AgentSession["model"] }) => Promise<T>,
    readOnly?: RuntimeReadOnlyStartOptions): Promise<T> {
    const preferences = this.preferences();
    const shared = readOnly ? undefined : SettingsManager.create(cwd, this.agentDir);
    const settingsManager = SettingsManager.inMemory({
      ...(shared ? withoutModels(shared.getGlobalSettings()) : { compaction: { enabled: false }, retry: { enabled: false } }),
      defaultThinkingLevel: preferences.getDefaultThinkingLevel(), modelThinkingLevels: preferences.getAllModelThinkingLevels(),
    });
    if (shared) settingsManager.applyOverrides(withoutModels(shared.getProjectSettings()));
    const recorded = manager.buildSessionContext().model;
    const roles = this.getRoles();
    const routed = readOnly?.modelRole && roles[readOnly.modelRole]
      ? resolveModelSelection(`@${readOnly.modelRole}`, this.catalog.getModels(), roles, this.defaultReference(preferences)) : undefined;
    const reference = recorded ? { provider: recorded.provider, id: recorded.modelId } : routed?.reference ?? this.defaultReference(preferences);
    const saved = reference && recorded ? this.recorded(manager, reference) : undefined;
    const selection: Selection = { reference, source: recorded ? "conversation" : reference ? "default" : "none",
      role: saved?.role ?? routed?.role, effort: saved?.effort ?? routed?.effort ?? (!recorded && reference && this.autoDefault(reference) ? "auto" : undefined) };
    const model = reference ? this.catalog.getModel(reference.provider, reference.id) : undefined;
    let initializing = true;
    const modelRuntime = new Proxy(this.catalog, {
      get: (target, key) => {
        if (key === "getAvailableSnapshot") return () => initializing ? [] : target.getAvailableSnapshot();
        if (key === "checkAuth") return async (provider: string, options?: { signal?: AbortSignal }) => {
          const signal = this.selectionSignal ?? options?.signal;
          const auth = await target.checkAuth(provider, { signal });
          signal?.throwIfAborted();
          return auth;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const result = await create({ settingsManager, modelRuntime, model });
      this.selections.set(result.session, selection);
      if (model && selection.effort) {
        this.applyEffort(result.session, selection.effort, Boolean(recorded));
        if (!recorded) this.record(result.session);
      }
      return result;
    } finally { initializing = false; }
  }

  status(session: AgentSession): RuntimeStatus {
    const selection = this.selections.get(session)!;
    const reference = selection.reference;
    const model = reference && session.model?.provider === reference.provider && session.model.id === reference.id
      ? this.catalog.getModel(reference.provider, reference.id) : undefined;
    const stale = reference && this.staleAuth.has(reference.provider);
    const auth = stale ? "unknown" : reference ? this.catalog.hasConfiguredAuth(reference.provider) ? "configured" : "missing" : "unknown";
    const blocked = !reference ? "No Casper model selected. Use /model to choose one."
      : stale ? "Credential state needs local refresh. Restart Casper before using this provider; do not repeat login blindly."
      : !model ? `Model ${reference.provider}/${reference.id} is unavailable. Use /model to choose another; no fallback was selected.`
      : auth === "missing" ? `Credentials missing for ${reference.provider}. Use /login for OpenAI Codex, configure another supported credential, or /model to choose another.` : undefined;
    return { provider: reference?.provider, model: reference?.id, thinkingLevel: model ? session.thinkingLevel : undefined,
      configuredEffort: selection.effort ?? (model ? session.thinkingLevel : undefined), modelRole: selection.role, autoEffort: selection.auto,
      availableThinkingLevels: model ? session.getAvailableThinkingLevels() : [],
      auth, selectionSource: selection.source, defaultModel: this.defaultReference(), blocked };
  }

  private applyEffort(session: AgentSession, effort: string, retain = false): void {
    const supported = session.getAvailableThinkingLevels();
    const level = effort === "auto" ? resolveAutoEffort(retain ? session.thinkingLevel : "high", supported) : supported.find(value => value === effort);
    if (effort !== "auto" && !level) throw new Error(`Unsupported effort. Choose: auto, ${supported.join(", ")}`);
    if (level) session.setThinkingLevel(level, { persist: false });
    const selection = this.selections.get(session)!;
    selection.effort = effort;
    selection.auto = effort === "auto" ? { state: level ? "pending" : "unavailable" } : undefined;
  }
  async setEffort(session: AgentSession, level: string, persist: boolean): Promise<RuntimeStatus> {
    this.assertReady(session);
    if (this.busy || !session.isIdle) throw new Error("Wait for active work before changing effort.");
    this.applyEffort(session, level);
    const model = session.model!;
    session.settingsManager.setModelThinkingLevel(model.provider, model.id, session.thinkingLevel);
    this.record(session);
    if (persist) {
      const preferences = this.preferences();
      preferences.setModelThinkingLevel(model.provider, model.id, session.thinkingLevel);
      if (this.defaultReference(preferences)?.id === model.id && this.defaultReference(preferences)?.provider === model.provider)
        preferences.setDefaultThinkingLevel(session.thinkingLevel);
      await preferences.flush();
      if (preferences.drainErrors().length) throw new Error("Effort applied to this conversation, but could not be saved.");
      await this.saveAuto(model, level === "auto");
    }
    return this.status(session);
  }

  usage(session: AgentSession): RuntimeUsage["effortClassification"] { return this.accounting.get(session); }
  async preparePrompt(session: AgentSession, request: string, caller: AbortSignal): Promise<RuntimeStatus> {
    this.assertReady(session);
    if (this.preparing) throw new Error("Automatic effort is already being resolved.");
    const signal = AbortSignal.any([caller, this.lifetime.signal]);
    signal.throwIfAborted();
    const selection = this.selections.get(session)!;
    if (selection.effort !== "auto") return this.status(session);
    this.preparing = true;
    const { promise, resolve: finish } = Promise.withResolvers<void>();
    this.preparationDone = promise;
    try {
      const supported = session.getAvailableThinkingLevels();
      if (!resolveAutoEffort("high", supported)) {
        selection.auto = { state: "unavailable" };
        this.record(session);
        return this.status(session);
      }
      selection.auto = { state: "pending" };
      try {
        const roles = this.getRoles();
        const classifier = roles.fast ? resolveModelSelection("@fast", this.catalog.getModels(), roles, this.defaultReference()).reference : selection.reference!;
        const model = this.catalog.getModel(classifier.provider, classifier.id);
        selection.auto.classifier = `${classifier.provider}/${classifier.id}`;
        if (!model || this.staleAuth.has(classifier.provider) || !this.catalog.hasConfiguredAuth(classifier.provider)) throw new Error("Classifier unavailable.");
        let usage = this.accounting.get(session);
        if (!usage) { usage = { requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; this.accounting.set(session, usage); }
        usage.requests++;
        const result = await classifyEffort({ catalog: this.catalog, model, supported, request, signal, onUsage: observed => {
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.tokens[key] += observed.tokens[key];
          if (observed.estimatedCost !== undefined) usage.estimatedCost = (usage.estimatedCost ?? 0) + observed.estimatedCost;
        } });
        signal.throwIfAborted();
        session.setThinkingLevel(result.level, { persist: false });
        selection.auto.state = "classified";
      } catch {
        signal.throwIfAborted();
        selection.auto.state = "fallback";
      }
      this.record(session);
      return this.status(session);
    } finally { this.preparing = false; finish(); }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.all([this.selectionDone, this.preparationDone]);
  }
  assertReady(session: AgentSession): void {
    this.lifetime.signal.throwIfAborted();
    if (this.selecting) throw new Error("Model selection is in progress; wait before sending a request.");
    if (this.authenticating) throw new Error("Login is in progress; wait before sending a request.");
    const blocked = this.status(session).blocked;
    if (blocked) throw new Error(blocked);
  }

  async select(session: AgentSession, options: RuntimeModelSelectionOptions): Promise<RuntimeModelSelection> {
    if (this.busy || !session.isIdle) throw new Error("Wait for active work before changing models.");
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    this.selecting = true; this.selectionSignal = signal;
    const { promise, resolve: finish } = Promise.withResolvers<void>();
    this.selectionDone = promise;
    try {
      let resolved: ResolvedModelSelection | undefined;
      if (options.query) {
        try { resolved = resolveModelSelection(options.query, this.catalog.getModels(), this.getRoles(), this.defaultReference()); }
        catch (error) { if (!options.picker || options.query.startsWith("@") || options.query.includes(":")) throw error; }
      }
      let model = resolved && this.catalog.getModel(resolved.reference.provider, resolved.reference.id);
      let persist = Boolean(options.persist);
      if (!model && options.picker) {
        signal.throwIfAborted();
        const picked = await options.picker.mount(view => pickPiModel(view, this.catalog,
          this.status(session).blocked ? undefined : session.model, this.defaultReference(), options.query, signal, options.persist === false));
        signal.throwIfAborted();
        if (!picked) return { status: this.status(session), selected: false, savedDefault: false };
        model = this.catalog.getModel(picked.provider, picked.id); persist = options.persist === false ? false : picked.persist;
      }
      if (!model) return { status: this.status(session), selected: false, savedDefault: false,
        models: this.catalog.getAvailableSnapshot().map(({ provider, id, name }) => ({ provider, id, name })) };
      const saved = this.recorded(session.sessionManager, model);
      const effort = resolved?.effort ?? saved?.effort ?? (this.autoDefault(model) ? "auto" : undefined);
      if (effort && effort !== "auto" && !getSupportedThinkingLevels(model).some(level => level === effort)) throw new Error(`Unsupported effort ${effort} for ${model.provider}/${model.id}.`);
      if (this.staleAuth.has(model.provider)) throw new Error("Credential state needs local refresh. Restart Casper before selecting this provider.");
      if (!this.catalog.hasConfiguredAuth(model.provider)) throw new Error(`Credentials missing for ${model.provider}. Use /login for OpenAI Codex or configure another supported credential; selection unchanged.`);
      await session.setModel(model, { persist: false });
      // Pi commits the model before awaiting model_select extension handlers.
      // Retain that committed conversation state even if cancellation arrived
      // during a handler; the abort still prevents saving startup defaults.
      this.selections.set(session, { reference: { provider: model.provider, id: model.id }, source: "conversation", role: resolved?.role, effort: effort ?? session.thinkingLevel });
      if (effort) this.applyEffort(session, effort);
      this.record(session);
      signal.throwIfAborted();
      if (persist) {
        const preferences = this.preferences();
        preferences.setDefaultModelAndProvider(model.provider, model.id);
        preferences.setDefaultThinkingLevel(session.thinkingLevel);
        preferences.setModelThinkingLevel(model.provider, model.id, session.thinkingLevel);
        await preferences.flush();
        if (preferences.drainErrors().length) throw new Error("Model selected for this conversation, but the Casper default could not be saved.");
        await this.saveAuto(model, effort === "auto");
      }
      return { status: this.status(session), selected: true, savedDefault: persist };
    } finally { this.selecting = false; this.selectionSignal = undefined; finish(); }
  }
}
