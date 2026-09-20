import { existsSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsManager, type AgentSession, type ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeModelSelection, RuntimeModelSelectionOptions, RuntimeStatus } from "./types";

type Reference = { provider: string; id: string };
type Selection = { reference?: Reference; source: "conversation" | "default" | "none" };
type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;

/** Keep existing non-model runtime configuration, but never inherit model preferences. */
function withoutModels(settings: Settings): Settings {
  const { defaultProvider, defaultModel, defaultThinkingLevel, modelThinkingLevels, enabledModels, ...rest } = settings;
  return rest;
}

/** Pi owns catalog, auth checks, model activation and transcript format. This adapter
 * supplies Casper's preference source and prevents Pi's automatic provider fallback. */
export class PiModels {
  private readonly selections = new WeakMap<AgentSession, Selection>();
  private selecting = false;
  private selectionSignal?: AbortSignal;
  private readonly lifetime = new AbortController();
  private selectionDone: Promise<void> = Promise.resolve();
  private finishSelection?: () => void;
  private readonly directory = path.join(os.homedir(), ".casper");

  constructor(private readonly catalog: ModelRuntime, private readonly agentDir: string) {}

  private preferences(): SettingsManager {
    // Non-atomic alias preflight: a Casper path must not redirect preference
    // writes into shared Pi settings (including hardlinked files).
    for (const [file, directory] of [[this.directory, true], [path.join(this.directory, "settings.json"), false]] as const) {
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
          throw new Error("Casper model defaults require an unshared regular settings file in a real .casper directory.");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // An unrelated cwd plus projectTrusted:false prevents .pi project model overrides.
    const settings = SettingsManager.create(this.directory, this.directory, { projectTrusted: false });
    if (settings.drainErrors().length) throw new Error(`Cannot read Casper model defaults at ${path.join(this.directory, "settings.json")}; repair the file before selecting a model.`);
    const provider = settings.getDefaultProvider(); const model = settings.getDefaultModel();
    if ((provider !== undefined || model !== undefined) &&
      (typeof provider !== "string" || !provider.trim() || typeof model !== "string" || !model.trim())) {
      throw new Error("Casper defaultProvider and defaultModel must both be nonempty strings.");
    }
    return settings;
  }

  private defaultReference(settings = this.preferences()): Reference | undefined {
    const provider = settings.getDefaultProvider(); const id = settings.getDefaultModel();
    return provider && id ? { provider, id } : undefined;
  }

  async create<T extends { session: AgentSession }>(cwd: string, manager: SessionManager,
    create: (options: { settingsManager: SettingsManager; modelRuntime: ModelRuntime; model: AgentSession["model"] }) => Promise<T>): Promise<T> {
    const preferences = this.preferences();
    const shared = SettingsManager.create(cwd, this.agentDir);
    const settingsManager = SettingsManager.inMemory({
      ...withoutModels(shared.getGlobalSettings()),
      defaultThinkingLevel: preferences.getDefaultThinkingLevel(),
      modelThinkingLevels: preferences.getAllModelThinkingLevels(),
    });
    settingsManager.applyOverrides(withoutModels(shared.getProjectSettings()));
    const recorded = manager.buildSessionContext().model;
    const reference = recorded ? { provider: recorded.provider, id: recorded.modelId } : this.defaultReference(preferences);
    const selection: Selection = { reference, source: recorded ? "conversation" : reference ? "default" : "none" };
    const model = reference ? this.catalog.getModel(reference.provider, reference.id) : undefined;
    let initializing = true;
    // The pinned SDK falls back to its first available provider when no explicit
    // model resolves. Hide only that fallback snapshot during construction; retain
    // the real catalog afterward for Pi's picker and ordinary session operations.
    const modelRuntime = new Proxy(this.catalog, {
      get: (target, key) => {
        if (key === "getAvailableSnapshot") return () => initializing ? [] : target.getAvailableSnapshot();
        if (key === "checkAuth") return async (provider: string, options?: { signal?: AbortSignal }) => {
          const signal = this.selectionSignal ?? options?.signal;
          const auth = await target.checkAuth(provider, { signal });
          signal?.throwIfAborted(); // setModel must not mutate after a cancelled auth check.
          return auth;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const result = await create({ settingsManager, modelRuntime, model });
      this.selections.set(result.session, selection);
      return result;
    } finally { initializing = false; }
  }

  status(session: AgentSession): RuntimeStatus {
    const selection = this.selections.get(session)!;
    const reference = selection.reference;
    // AgentCore supplies an internal placeholder when the SDK has no model. It
    // is not a user selection and must never authorize a request or appear as one.
    const model = reference && session.model?.provider === reference.provider && session.model.id === reference.id
      ? this.catalog.getModel(reference.provider, reference.id) : undefined;
    const auth = reference ? this.catalog.hasConfiguredAuth(reference.provider) ? "configured" : "missing" : "unknown";
    const blocked = !reference ? "No Casper model selected. Use /model to choose one."
      : !model ? `Model ${reference.provider}/${reference.id} is unavailable. Use /model to choose another; no fallback was selected.`
      : auth === "missing" ? `Credentials missing for ${reference.provider}. Use /login for setup guidance or /model to choose another.` : undefined;
    return { provider: reference?.provider, model: reference?.id, thinkingLevel: model ? session.thinkingLevel : undefined,
      auth, selectionSource: selection.source, defaultModel: this.defaultReference(), blocked };
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await this.selectionDone;
  }

  assertReady(session: AgentSession): void {
    this.lifetime.signal.throwIfAborted();
    if (this.selecting) throw new Error("Model selection is in progress; wait before sending a request.");
    const blocked = this.status(session).blocked;
    if (blocked) throw new Error(blocked);
  }

  async select(session: AgentSession, options: RuntimeModelSelectionOptions): Promise<RuntimeModelSelection> {
    if (this.selecting || !session.isIdle) throw new Error("Wait for active work before changing models.");
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    options = { ...options, signal };
    signal.throwIfAborted();
    this.selecting = true; this.selectionSignal = signal;
    this.selectionDone = new Promise((resolve) => { this.finishSelection = resolve; });
    try {
      const query = options.query?.toLowerCase();
      const all = this.catalog.getModels();
      const matches = query ? all.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === query) : [];
      if (query && !matches.length) matches.push(...all.filter((model) => model.id.toLowerCase() === query));
      let model = matches.length === 1 ? matches[0] : undefined;
      let persist = Boolean(options.persist);
      if (!model && options.picker) {
        const { pickPiModel } = await import("./pi-model-picker");
        options.signal?.throwIfAborted();
        const picked = await options.picker.run((io) => pickPiModel(io, this.catalog,
          this.status(session).blocked ? undefined : session.model, this.defaultReference(), options.query, options.signal));
        options.signal?.throwIfAborted();
        if (!picked) return { status: this.status(session), selected: false, savedDefault: false };
        model = this.catalog.getModel(picked.provider, picked.id); persist = picked.persist;
      }
      if (!model) {
        if (query) throw new Error(matches.length ? "Ambiguous model; use provider/model-id." : "Unknown model. Use /model to see available models.");
        return { status: this.status(session), selected: false, savedDefault: false,
          models: this.catalog.getAvailableSnapshot().map(({ provider, id, name }) => ({ provider, id, name })) };
      }
      if (!this.catalog.hasConfiguredAuth(model.provider)) throw new Error(`Credentials missing for ${model.provider}. Use /login for setup guidance; selection unchanged.`);
      await session.setModel(model, { persist: false });
      this.selections.set(session, { reference: { provider: model.provider, id: model.id }, source: "conversation" });
      // Pi defers a new file until the first assistant response. Materialize only
      // that unwritten conversation, then reopen through Pi so its append writer
      // knows the file exists. Exporting an existing file would drop inactive
      // transcript branches; leaving the writer unopened would cause EEXIST.
      if (session.sessionFile && !existsSync(session.sessionFile)) {
        session.exportToJsonl(session.sessionFile);
        session.sessionManager.setSessionFile(session.sessionFile);
      }
      signal.throwIfAborted();
      if (persist) {
        const preferences = this.preferences();
        preferences.setDefaultModelAndProvider(model.provider, model.id);
        await preferences.flush();
        if (preferences.drainErrors().length) throw new Error("Model selected for this conversation, but the Casper default could not be saved.");
      }
      return { status: this.status(session), selected: true, savedDefault: persist };
    } finally {
      this.selecting = false; this.selectionSignal = undefined;
      this.finishSelection?.(); this.finishSelection = undefined;
    }
  }
}
