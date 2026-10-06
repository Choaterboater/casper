import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { SettingsManager, type AgentSession, type ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyEffort, nearestEffort, resolveAutoEffort } from "./auto-effort";
import { isEffortSelection, isModelRole, resolveModelSelection, type ModelReference, type ModelRoles, type ResolvedModelSelection } from "./model-routing";
import type { RuntimeModelInfo, RuntimeModelSelection, RuntimeModelSelectionOptions, RuntimeReadOnlyStartOptions, RuntimeStatus, RuntimeUsage } from "./types";
import { pickPiModel } from "./pi-model-picker";
import { openRouterRequestHeaders } from "./openrouter-attribution";

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
/** The model Casper picks after a sign-in when none is set yet: the provider's own default in Pi's
 * catalog, except OpenRouter, where a measured low-cost model is Casper's choice. Checked against the
 * catalog by tests/default-models.test.ts. Order is the preference when several providers are signed in. */
export const DEFAULT_MODELS: ReadonlyArray<{ provider: string; id: string }> = [
  { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
  { provider: "anthropic", id: "claude-opus-4-8" },
  { provider: "openai-codex", id: "gpt-5.5" },
  { provider: "github-copilot", id: "gpt-5.4" },
];


/** Names /login knows, and the key variable each provider reads (the common ones). */
const SIGN_IN_NAMES: Record<string, string> = { openrouter: "OpenRouter", anthropic: "Anthropic", "openai-codex": "OpenAI Codex", "github-copilot": "GitHub Copilot" };
const KEY_VARIABLES: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", "github-copilot": "COPILOT_GITHUB_TOKEN", openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", google: "GEMINI_API_KEY", groq: "GROQ_API_KEY", xai: "XAI_API_KEY", mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY", together: "TOGETHER_API_KEY", fireworks: "FIREWORKS_API_KEY",
};

/** What to do when the model's provider has no sign-in: its real name, its /login and its key variable. */
export function missingSignIn(provider: string): string {
  const name = SIGN_IN_NAMES[provider];
  const variable = KEY_VARIABLES[provider];
  if (name) return `Not signed in to ${name}. Type /login ${provider}${variable ? `, or set ${variable}` : ""}.`;
  return `No key for ${provider}. ${variable ? `Set ${variable}` : "Set its API key"}, or /model to choose another.`;
}

/** What Casper says about a catalog model: its name, context window, input price and whether it sees images. */
function modelInfo(model: { provider: string; id: string; contextWindow?: number; cost?: { input?: number }; input?: readonly string[] }): RuntimeModelInfo {
  const input = model.cost?.input;
  return { provider: model.provider, id: model.id,
    ...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    ...(typeof input === "number" && Number.isFinite(input) && input > 0 ? { inputCostPerMillion: input } : {}),
    ...(model.input?.includes("image") ? { images: true } : {}) };
}

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
  private readonly directory: string;

  /** home is the session's home folder (tests pass a temporary one): model defaults live in its .casper. */
  constructor(private readonly catalog: ModelRuntime, private readonly agentDir: string, home: string) {
    this.directory = path.join(home, ".casper");
  }
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

  /** The catalog entry a selector names, for the big-model offer. Resolves without selecting anything. */
  describe(query: string): RuntimeModelInfo | undefined {
    let resolved: ResolvedModelSelection;
    try { resolved = resolveModelSelection(query, this.catalog.getModels(), this.getRoles(), this.defaultReference()); }
    catch { return undefined; }
    const model = this.catalog.getModel(resolved.reference.provider, resolved.reference.id);
    if (!model) return undefined;
    return modelInfo(model);
  }

  /** A signed-in model that can see images: the user's roles first (big model, build, review, fast), then the current
   * provider's default model. Never the model in use now. Makes no call. */
  visionModel(session: AgentSession): RuntimeModelInfo | undefined {
    const current = this.selections.get(session)?.reference;
    const roles = this.getRoles();
    const candidates = [
      ...(["reason", "build", "review", "fast"] as const).filter((role) => roles[role]).map((role) => `@${role}`),
      ...DEFAULT_MODELS.filter((entry) => entry.provider === current?.provider).map((entry) => `${entry.provider}/${entry.id}`),
    ];
    for (const query of candidates) {
      let resolved: ResolvedModelSelection;
      try { resolved = resolveModelSelection(query, this.catalog.getModels(), roles, this.defaultReference()); }
      catch { continue; }
      const model = this.catalog.getModel(resolved.reference.provider, resolved.reference.id);
      if (!model?.input?.includes("image") || this.staleAuth.has(model.provider) || !this.catalog.hasConfiguredAuth(model.provider)) continue;
      if (current && model.provider === current.provider && model.id === current.id) continue;
      return modelInfo(model);
    }
    return undefined;
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
    readOnly?: Pick<RuntimeReadOnlyStartOptions, "modelRole"> & { compact?: boolean }): Promise<T> {
    const preferences = this.preferences();
    // A repository is never trusted implicitly: projectTrusted:false is Pi's single gate for
    // `.pi/` extensions (in-process code), SYSTEM.md/APPEND_SYSTEM.md, prompts, themes and
    // settings. The loader reads it from the session's settings, so both managers carry it.
    // A read-only child reads no shared settings, so it keeps Pi's default retry policy (3 retries,
    // 2 s doubling backoff), as the main session and `pi` do: one 429 or dropped connection must
    // not end a scout. Cancelling the child aborts the backoff through session.abort().
    const shared = readOnly ? undefined : SettingsManager.create(cwd, this.agentDir, { projectTrusted: false });
    const settingsManager = SettingsManager.inMemory({
      ...(shared ? withoutModels(shared.getGlobalSettings()) : { compaction: { enabled: readOnly?.compact === true } }),
      defaultThinkingLevel: preferences.getDefaultThinkingLevel(), modelThinkingLevels: preferences.getAllModelThinkingLevels(),
    }, { projectTrusted: false });
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
    // Claude sign-in is per-token extra usage (see pi-auth), so only other subscription sign-ins count.
    const billing = !reference || auth !== "configured" ? undefined
      : reference.provider !== "anthropic" && this.catalog.isUsingSubscription(reference.provider) ? "subscription" : "per-token";
    const blocked = !reference ? "No Casper model selected. Use /model to choose one, or /login to sign in."
      : stale ? "Credential state needs local refresh. Restart Casper before using this provider; do not repeat login blindly."
      : !model ? `Model ${reference.provider}/${reference.id} is unavailable. Use /model to choose another; no fallback was selected.`
      : auth === "missing" ? missingSignIn(reference.provider) : undefined;
    const prices = model?.cost ? [model.cost.input, model.cost.output].filter((price) => typeof price === "number" && Number.isFinite(price)) : [];
    const priced = prices.length ? prices.some((price) => price > 0) : undefined;
    return { provider: reference?.provider, model: reference?.id, thinkingLevel: model ? session.thinkingLevel : undefined,
      configuredEffort: selection.effort ?? (model ? session.thinkingLevel : undefined), modelRole: selection.role, autoEffort: selection.auto,
      availableThinkingLevels: model ? session.getAvailableThinkingLevels() : [],
      auth, ...(billing ? { billing } : {}), selectionSource: selection.source, defaultModel: this.defaultReference(), blocked, ...(priced !== undefined ? { priced } : {}),
      ...(model ? { images: Boolean(model.input?.includes("image")) } : {}) };
  }

  private applyEffort(session: AgentSession, effort: string, retain = false): void {
    const supported = session.getAvailableThinkingLevels();
    const level = effort === "auto" ? resolveAutoEffort(retain ? session.thinkingLevel : "high", supported) : nearestEffort(effort, supported);
    if (effort !== "auto" && !level) throw new Error(`Unknown effort ${effort}. Choose: auto, off, minimal, low, medium, high, xhigh, max`);
    if (level) session.setThinkingLevel(level, { persist: false });
    const selection = this.selections.get(session)!;
    selection.effort = effort;
    selection.auto = effort === "auto" ? { state: level ? "pending" : "unavailable" } : undefined;
  }
  async setEffort(session: AgentSession, level: string, persist: boolean): Promise<RuntimeStatus> {
    this.assertReady(session);
    if (this.busy || !session.isIdle) throw new Error("Wait for active work before changing effort.");
    const selection = this.selections.get(session)!;
    const model = session.model!;
    // A repeat of the current level (a wrapped Shift+Tab, or /effort of the same value) must not
    // append another session entry or clone settings. Persisting still writes the preference.
    if (selection.effort !== level) {
      this.applyEffort(session, level);
      session.settingsManager.setModelThinkingLevel(model.provider, model.id, session.thinkingLevel);
      this.record(session);
    } else if (!persist) return this.status(session);
    if (persist) {
      const preferences = this.preferences();
      preferences.setModelThinkingLevel(model.provider, model.id, session.thinkingLevel);
      // The saved default is resolved case-insensitively everywhere else (model-routing
      // @default, startup); this comparison must agree or defaultThinkingLevel diverges.
      const reference = this.defaultReference(preferences);
      if (reference?.id.toLowerCase() === model.id.toLowerCase() && reference?.provider.toLowerCase() === model.provider.toLowerCase())
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
      if (effort && effort !== "auto" && !nearestEffort(effort, getSupportedThinkingLevels(model))) throw new Error(`Unknown effort ${effort} for ${model.provider}/${model.id}.`);
      if (this.staleAuth.has(model.provider)) throw new Error("Credential state needs local refresh. Restart Casper before selecting this provider.");
      if (!this.catalog.hasConfiguredAuth(model.provider)) throw new Error(`${missingSignIn(model.provider)} Model unchanged.`);
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

  /** When no model is selected yet, pick one for a signed-in provider (`provider` first) and save it as the
   * default. Never replaces a model the user chose. Undefined when nothing was picked. */
  async selectDefaultIfUnset(session: AgentSession, options: { provider?: string; signal?: AbortSignal } = {}): Promise<RuntimeModelSelection | undefined> {
    if (this.selections.get(session)?.reference) return undefined;
    const candidates = [...DEFAULT_MODELS].sort((a, b) => Number(b.provider === options.provider) - Number(a.provider === options.provider));
    const pick = candidates.find(({ provider, id }) => !this.staleAuth.has(provider) && this.catalog.hasConfiguredAuth(provider) && this.catalog.getModel(provider, id));
    if (!pick) return undefined;
    return this.select(session, { query: `${pick.provider}/${pick.id}`, persist: true, signal: options.signal });
  }

  /** A one-off request outside the transcript: the configured `review` role's model when set (so a check can
   * come from a different model than the one that did the work), else the conversation's; effort is the
   * caller's `effort` when given, else the role's suffix, else the conversation's, mapped to what the model
   * supports. `maxTokens` caps the answer. `role: "fast"` asks for the fast model instead (the conversation's
   * when none is set or it is not signed in). */
  async complete(session: AgentSession, input: { systemPrompt: string; user: string; signal?: AbortSignal; effort?: string; maxTokens?: number; role?: "fast" }): Promise<{ text: string; error?: string; usage: { tokens: number; estimatedCost: number } | null }> {
    const none = { tokens: 0, estimatedCost: 0 };
    const roles = this.getRoles();
    if (input.role === "fast") {
      // The fast model when it is set and signed in; otherwise the conversation's model, never an error.
      const fast = this.usableRole("fast", roles);
      return this.completeWith(fast?.model ?? session.model, fast?.effort, session, input, none);
    }
    const role = roles.review ? resolveModelSelection("@review", this.catalog.getModels(), roles, this.defaultReference()) : undefined;
    const model = role ? this.catalog.getModel(role.reference.provider, role.reference.id) : session.model;
    if (!model) return { text: "", error: role ? `the review model ${role.reference.provider}/${role.reference.id} is not in the catalog` : "no model selected", usage: none };
    if (role && (this.staleAuth.has(model.provider) || !this.catalog.hasConfiguredAuth(model.provider))) {
      return { text: "", error: `credentials missing for the review model's provider ${model.provider}`, usage: none };
    }
    return this.completeWith(model, role?.effort, session, input, none);
  }

  /** A role's model when it is set, in the catalog and signed in; undefined otherwise. */
  private usableRole(name: "fast", roles: ModelRoles): { model: NonNullable<AgentSession["model"]>; effort?: string } | undefined {
    if (!roles[name]) return undefined;
    let resolved: ResolvedModelSelection;
    try { resolved = resolveModelSelection(`@${name}`, this.catalog.getModels(), roles, this.defaultReference()); }
    catch { return undefined; }
    const model = this.catalog.getModel(resolved.reference.provider, resolved.reference.id);
    if (!model || this.staleAuth.has(model.provider) || !this.catalog.hasConfiguredAuth(model.provider)) return undefined;
    return { model, ...(resolved.effort ? { effort: resolved.effort } : {}) };
  }

  private async completeWith(model: AgentSession["model"], roleEffort: string | undefined, session: AgentSession,
    input: { systemPrompt: string; user: string; signal?: AbortSignal; effort?: string; maxTokens?: number },
    none: { tokens: number; estimatedCost: number }): Promise<{ text: string; error?: string; usage: { tokens: number; estimatedCost: number } | null }> {
    if (!model) return { text: "", error: "no model selected", usage: none };
    const requested = input.effort ?? (roleEffort && roleEffort !== "auto" ? roleEffort : session.thinkingLevel);
    const level = requested && requested !== "off" ? nearestEffort(requested, getSupportedThinkingLevels(model)) : undefined;
    const response = await this.catalog.completeSimple(model, {
      systemPrompt: input.systemPrompt,
      messages: [{ role: "user", content: input.user, timestamp: Date.now() }],
    }, { signal: input.signal, toolChoice: "none", ...(level && level !== "off" ? { reasoning: level } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      // A direct request skips the session's header hook; OpenRouter still learns it is Casper's.
      ...openRouterRequestHeaders(model) });
    const usage = response.usage;
    const cost = usage?.cost?.total;
    const reported = usage && Number.isFinite(usage.totalTokens) ? { tokens: usage.totalTokens, estimatedCost: Number.isFinite(cost) && cost >= 0 ? cost : 0 } : null;
    if (response.stopReason === "error" || response.stopReason === "aborted") return { text: "", error: response.errorMessage ?? response.stopReason, usage: reported };
    return { text: response.content.filter((part) => part.type === "text").map((part) => part.text).join(""), usage: reported };
  }
}
