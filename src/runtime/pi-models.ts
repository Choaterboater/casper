import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { SettingsManager, type AgentSession, type ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import { classifyEffort, nearestEffort, resolveAutoEffort } from "./auto-effort";
import { isEffortSelection, isModelRole, resolveModelSelection, type ModelReference, type ModelRoles, type ResolvedModelSelection } from "./model-routing";
import { matchModelWords, noModelMessage } from "./model-words";
import type { RuntimeModelInfo, RuntimeModelSelection, RuntimeModelSelectionOptions, RuntimeModelWordsMatch, RuntimeModelWordsOptions, RuntimeReadOnlyStartOptions, RuntimeStatus, RuntimeUsage } from "./types";
import { pickPiModel } from "./pi-model-picker";
import { anyModelMatches } from "./pi-model-browser";
import { openRouterRequestHeaders } from "./openrouter-attribution";
import { compactionReserveFor, smallWindowWarning } from "./small-window";
import { lockBusy } from "../platform/files";
import { isLocalProvider, lastLocalLook, LOCAL_SERVERS, localModelDefaults, onThisComputer, SERVER_SIDE_TIP, wantsServerTip, type LocalDiscovery, type LocalProblem } from "./local-models";
import { CLAUDE_SUBSCRIPTION } from "./claude-subscription";

type Selection = { reference?: ModelReference; source: "conversation" | "default" | "none"; role?: string; effort?: string; auto?: RuntimeStatus["autoEffort"] };
type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
type Preferences = { modelRoles?: ModelRoles; autoEffortModels?: string[] };
const ENTRY = "casper.model-selection";

/** Pi takes a lock folder (settings.json.lock) even to read settings, and gives up when it is held (ELOCKED) after
 * about 200 ms. On Windows, creating that folder while another process is still deleting it fails EPERM, EACCES or
 * EBUSY, which Pi does not retry at all. Either means another Casper is reading or writing the file, not that the
 * file is broken. */
export function settingsLockBusy(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const failure = error as NodeJS.ErrnoException | undefined;
  if (failure?.code === "ELOCKED") return true;
  return typeof failure?.path === "string" && path.basename(failure.path) === "settings.json.lock" && lockBusy(error, platform);
}
/** Waits between reads of a busy settings.json: 650 ms in all. A held lock also costs each of the 5 reads Pi's own
 * busy-loop retries (9 x 20 ms), so a lock that never frees gives up after about 1.6 s. preferences() is synchronous
 * (it backs sync getters), so the wait blocks: Atomics.wait sleeps the thread instead of spinning, which leaves the
 * CPU to the Casper holding the lock. It only runs while the file is busy, and a lock is held for one small read or
 * write. */
const SETTINGS_BUSY_WAITS_MS = [50, 100, 200, 300];
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

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
  { provider: "openai", id: "gpt-5.5" },
];


/** Names /login knows, and the key variable each provider reads (the common ones). */
const SIGN_IN_NAMES: Record<string, string> = { openrouter: "OpenRouter", anthropic: "Anthropic", "openai-codex": "OpenAI Codex", "github-copilot": "GitHub Copilot" };
const KEY_VARIABLES: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", "github-copilot": "COPILOT_GITHUB_TOKEN", openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", google: "GEMINI_API_KEY", groq: "GROQ_API_KEY", xai: "XAI_API_KEY", mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY", together: "TOGETHER_API_KEY", fireworks: "FIREWORKS_API_KEY",
};

/** What to do when the model's provider has no sign-in: its real name, its /login and its key variable. */
export function missingSignIn(provider: string, baseUrl?: string): string {
  if (provider === CLAUDE_SUBSCRIPTION) return "Claude subscription needs native Claude Code installed and signed in to a Pro, Max, Team or Enterprise plan on this OS. Sign in using Claude Code, then restart Casper.";
  if (baseUrl && !SIGN_IN_NAMES[provider] && !KEY_VARIABLES[provider]) return `${provider} at ${baseUrl} needs an apiKey line in models.json (any text works for a local server).`;
  const name = SIGN_IN_NAMES[provider];
  const variable = KEY_VARIABLES[provider];
  if (name) return `Not signed in to ${name}. Type /login ${provider}${variable ? `, or set ${variable}` : ""}.`;
  return `No key for ${provider}. ${variable ? `Set ${variable}` : "Set its API key"}, or /model to choose another.`;
}

/** The address of a provider set up in models.json with a baseUrl and no apiKey (a local server), else undefined. */
export function keylessAddress(agentDir: string, provider: string): string | undefined {
  try {
    const parsed: unknown = Bun.JSONC.parse(readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const providers = parsed && typeof parsed === "object" ? (parsed as { providers?: unknown }).providers : undefined;
    const entry = providers && typeof providers === "object" && !Array.isArray(providers) ? (providers as Record<string, unknown>)[provider] : undefined;
    if (!entry || typeof entry !== "object") return undefined;
    const { baseUrl, apiKey } = entry as { baseUrl?: unknown; apiKey?: unknown };
    return typeof baseUrl === "string" && baseUrl && !(typeof apiKey === "string" && apiKey) ? baseUrl : undefined;
  } catch { return undefined; }
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
    const file = path.join(this.directory, "settings.json");
    let settings: SettingsManager;
    for (let attempt = 0; ; attempt++) {
      settings = SettingsManager.create(this.directory, this.directory, { projectTrusted: false });
      const errors = settings.drainErrors();
      if (!errors.length) break;
      const busy = errors.every(({ error }) => settingsLockBusy(error));
      const wait = SETTINGS_BUSY_WAITS_MS[attempt];
      if (busy && wait !== undefined) { Atomics.wait(PAUSE, 0, 0, wait); continue; }
      throw new Error(busy
        ? `Casper model defaults at ${file} are in use by another Casper; try again in a moment.`
        : `Cannot read Casper model defaults at ${file}; repair the file before selecting a model.`, { cause: errors[0]!.error });
    }
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

  /** The model an exact id (any in the catalog) or loose words (the signed-in ones) name, without selecting it. */
  async matchWords(words: string, session: AgentSession, options: RuntimeModelWordsOptions = {}): Promise<RuntimeModelWordsMatch> {
    // A model on a server found on this computer may still be on its way into the catalog.
    // Only words that name a local server (ollama/…) wait for it, and look again: an ordinary line ("use node 20") waits
    // at most for the servers on this computer, never for one far away.
    const local = PiModels.localProvider(words);
    if (options.wait !== false) await this.localWhen(() => this.unresolved(words) && matchModelWords(words, this.catalog.getAvailableSnapshot()).kind === "none",
      local ? { provider: local, again: true } : { here: true });
    try {
      const { reference } = resolveModelSelection(words, this.catalog.getModels(), this.getRoles(), this.defaultReference());
      if (this.catalog.getModel(reference.provider, reference.id)) return { kind: "one", model: reference };
    } catch { /* not an exact id: loose words */ }
    const match = matchModelWords(words, this.catalog.getAvailableSnapshot(), { current: this.selections.get(session)?.reference, ...(options.head ? { head: true } : {}) });
    const plain = ({ provider, id }: ModelReference) => ({ provider, id });
    if (match.kind === "one") return { kind: "one", model: plain(match.model) };
    if (match.kind === "several") return { kind: "several", models: match.models.map(plain) };
    return { kind: "none", closest: match.closest.map(plain) };
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

  /** A model with a small window gets a compaction reserve of a quarter of it instead of Pi's fixed
   * 16,384, which would otherwise compact on every turn. Keyed per model so /model switches follow;
   * a reserve the person set themselves is left alone. */
  private shrinkCompactionReserve(settingsManager: SettingsManager): void {
    const settings = settingsManager.getGlobalSettings();
    const overrides: Record<string, { reserveTokens: number }> = {};
    if (settings.compaction?.reserveTokens === undefined) {
      for (const model of this.catalog.getModels()) {
        const reserve = compactionReserveFor(model.contextWindow);
        const key = `${model.provider}/${model.id}`;
        if (reserve !== undefined && settings.compaction?.modelOverrides?.[key]?.reserveTokens === undefined) overrides[key] = { reserveTokens: reserve };
      }
    }
    if (Object.keys(overrides).length) settingsManager.applyOverrides({ compaction: { modelOverrides: overrides } });
  }

  private localRefresh?: (signal?: AbortSignal) => Promise<LocalDiscovery>;
  private localReady?: Promise<unknown>;
  private localSettled?: (provider?: string) => Promise<void>;
  /** The first look's problems, shown once at the first request after it. */
  private localProblems: LocalProblem[] = [];
  /** The latest problem per server, from every look: the reason in "unavailable" and in /model. */
  private problemFor = new Map<string, LocalProblem>();
  /** Problems a blocked request already gave as its reason: the first-request notice doesn't repeat them. */
  private shownProblems = new Set<string>();
  /** Local model servers (src/runtime/local-models.ts): `ready` settles once the background probe has added them,
   * `refresh` probes again (when /model opens, or a model asked for by name isn't there), `settled` waits for one
   * server's look (no provider: the ones on this computer). Problems (a variable set to a server that did not answer)
   * show once, at the first request after the probe, and as the reason a model is unavailable. */
  useLocalServers(local: { ready: Promise<LocalDiscovery>; refresh?: (signal?: AbortSignal) => Promise<LocalDiscovery>; settled?: (provider?: string) => Promise<void> }): void {
    this.localRefresh = local.refresh && (async (signal) => { const found = await local.refresh!(signal); this.noteProblems(found); return found; });
    this.localSettled = local.settled;
    this.localReady = local.ready.then((found) => { this.localProblems = [...found.problems]; this.noteProblems(found); }, () => undefined);
  }
  private noteProblems(found: LocalDiscovery): void {
    for (const server of found.servers) this.problemFor.delete(server.provider);
    for (const problem of found.problems) this.problemFor.set(problem.provider, problem);
  }
  localNotice(): string | undefined {
    // Only problems still true now: a server found again since (a box that woke up) isn't reported.
    const problems = this.localProblems.filter((problem) => this.problemFor.get(problem.provider) === problem && !this.shownProblems.has(problem.text));
    this.localProblems = [];
    if (!problems.length) return undefined;
    return [...problems.map((problem) => `${problem.text} Its models aren't in /model.`), ...problems.some(wantsServerTip) ? [SERVER_SIDE_TIP] : []].join(" ");
  }
  /** A blocked message carrying a server's reason was shown: the first-request notice doesn't say it again. */
  blockedShown(blocked: string): void {
    for (const problem of this.problemFor.values()) if (blocked.includes(problem.text)) this.shownProblems.add(problem.text);
  }
  /** Why servers Casper was told about aren't in /model, one line each, then the tip for another computer once. */
  serverProblems(): string[] {
    const problems = [...this.problemFor.values()];
    return [...problems.map((problem) => problem.text), ...problems.some(wantsServerTip) ? [SERVER_SIDE_TIP] : []];
  }
  /** Waits for the local servers only when `missing` says a model the caller needs is not in the catalog yet: for one
   * provider's look when the caller knows it, for this computer's (`here`), else for all of them. With `again`, a
   * model still missing after a look older than `staleMs` sends Casper looking once more. */
  private async localWhen(missing: () => boolean, options: { provider?: string; here?: boolean; again?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (!this.localReady || !missing()) return;
    await (this.localSettled && (options.provider || options.here) ? this.localSettled(options.provider) : this.localReady);
    if (!options.again || !this.localRefresh || !missing()) return;
    const at = lastLocalLook();
    if (at !== undefined && Date.now() - at < localModelDefaults.staleMs) return;
    options.signal?.throwIfAborted();
    await this.localRefresh(options.signal).catch(() => undefined);
  }
  /** The provider part of a `provider/id` selector, when it names a local server. */
  private static localProvider(query: string): string | undefined {
    const slash = query.indexOf("/");
    const provider = slash > 0 ? query.slice(0, slash).trim().toLowerCase() : undefined;
    return isLocalProvider(provider) ? provider : undefined;
  }
  /** A request is about to run on a model that isn't in the catalog (its server didn't answer at start: a VPN not up
   * yet, a box asleep): look once more, and when it is there now, use it. True when the model is ready. */
  async findModelAgain(session: AgentSession, signal?: AbortSignal): Promise<boolean> {
    const selection = this.selections.get(session);
    const reference = selection?.reference;
    if (!selection || !reference || !isLocalProvider(reference.provider)) return false;
    if (session.model?.provider === reference.provider && session.model.id === reference.id) return false;
    const missing = () => !this.catalog.getModel(reference.provider, reference.id);
    await this.localWhen(missing, { provider: reference.provider, again: true, signal });
    signal?.throwIfAborted();
    const model = this.catalog.getModel(reference.provider, reference.id);
    if (!model || this.staleAuth.has(model.provider) || !this.catalog.hasConfiguredAuth(model.provider)) return false;
    // The same model the conversation (or the saved default) already chose: its role, effort and source stay as they
    // were, and nothing new is recorded or saved.
    await session.setModel(model, { persist: false });
    if (selection.effort) this.applyEffort(session, selection.effort, true);
    return true;
  }
  /** Whether `query` names no model in the catalog now (it may be a found server's, still being probed). */
  private unresolved(query: string): boolean {
    try {
      const { reference } = resolveModelSelection(query, this.catalog.getModels(), this.getRoles(), this.defaultReference());
      return !this.catalog.getModel(reference.provider, reference.id);
    } catch { return true; }
  }

  private warned = new WeakSet<AgentSession>();
  /** The plain-words warning for a small window, once per session and only for the selected main model. */
  smallWindowNotice(session: AgentSession): string | undefined {
    if (this.warned.has(session)) return undefined;
    const message = smallWindowWarning(session.model?.contextWindow);
    if (message) this.warned.add(session);
    return message;
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
    this.shrinkCompactionReserve(settingsManager);
    const recorded = manager.buildSessionContext().model;
    // The model this start needs may be a found server's, still being probed: only then does the start wait for it.
    const wanted = recorded ? { provider: recorded.provider, id: recorded.modelId } : this.defaultReference(preferences);
    // Only a model on a server Casper looks for is waited for, and only that server: a missing cloud model never waits.
    const role = !recorded && readOnly?.modelRole && this.getRoles()[readOnly.modelRole] ? readOnly.modelRole : undefined;
    await this.localWhen(() => role ? this.unresolved(`@${role}`) : Boolean(wanted && isLocalProvider(wanted.provider) && !this.catalog.getModel(wanted.provider, wanted.id)),
      role ? { here: true } : { provider: wanted?.provider });
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
    // The SDK transport uses Claude Code's plan login; direct Anthropic OAuth is a separate route.
    const billing = !reference || auth !== "configured" ? undefined
      : reference.provider === CLAUDE_SUBSCRIPTION || (reference.provider !== "anthropic" && this.catalog.isUsingSubscription(reference.provider)) ? "subscription" : "per-token";
    const blocked = !reference ? "No Casper model selected. Use /model to choose one, or /login to sign in."
      : stale ? "Credential state needs local refresh. Restart Casper before using this provider; do not repeat login blindly."
      : !model ? this.problemFor.has(reference.provider)
        ? `Model ${reference.provider}/${reference.id} is unavailable: ${this.problemFor.get(reference.provider)!.text} Casper looks again when you ask after 15 seconds; /model picks another.`
        : `Model ${reference.provider}/${reference.id} is unavailable. Use /model to choose another; no fallback was selected.`
      : auth === "missing" ? missingSignIn(reference.provider, keylessAddress(this.agentDir, reference.provider)) : undefined;
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
  /** `midRun`: the model is working; the change applies from its next step. */
  async setEffort(session: AgentSession, level: string, persist: boolean, midRun = false): Promise<RuntimeStatus> {
    this.assertReady(session);
    if (this.busy || (!midRun && !session.isIdle)) throw new Error("Wait for active work before changing effort.");
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
    if (blocked) { this.blockedShown(blocked); throw new Error(blocked); }
  }

  /** `midRun`: the model is working; the new model takes its next step. */
  async select(session: AgentSession, options: RuntimeModelSelectionOptions, midRun = false): Promise<RuntimeModelSelection> {
    if (this.busy || (!midRun && !session.isIdle)) throw new Error("Wait for active work before changing models.");
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    this.selecting = true; this.selectionSignal = signal;
    const { promise, resolve: finish } = Promise.withResolvers<void>();
    this.selectionDone = promise;
    try {
      let resolved: ResolvedModelSelection | undefined;
      // Loose words (`opus 5.5`) the model was found from, when no exact id or role names it.
      let from: string | undefined;
      if (options.query) {
        const query = options.query;
        // Look again for a local server's model, or loose words; not for another provider's id (a cloud typo).
        const local = PiModels.localProvider(query);
        await this.localWhen(() => this.unresolved(query), { provider: local, again: Boolean(local) || !query.includes("/"), signal });
        signal.throwIfAborted();
        try { resolved = resolveModelSelection(query, this.catalog.getModels(), this.getRoles(), this.defaultReference()); }
        catch (error) {
          if (query.trim().startsWith("@") || !/^Unknown model selector/.test(error instanceof Error ? error.message : "")) {
            if (!options.picker || query.startsWith("@") || query.includes(":")) throw error;
          } else {
            const words = matchModelWords(query, this.catalog.getAvailableSnapshot(), { current: this.selections.get(session)?.reference });
            const effort = words.kind === "none" ? undefined : words.effort;
            if (words.kind === "one") { resolved = { reference: words.model, ...(effort ? { effort } : {}) }; from = query.trim(); }
            else if (words.kind === "several") {
              const listed = words.models.map(({ provider, id, name }) => ({ provider, id, name: name ?? id }));
              if (options.choose && listed.length <= 4) {
                const picked = await options.choose(listed);
                signal.throwIfAborted();
                if (!picked) return { status: this.status(session), selected: false, savedDefault: false };
                resolved = { reference: picked, ...(effort ? { effort } : {}) }; from = query.trim();
              } else if (!options.picker) return { status: this.status(session), selected: false, savedDefault: false, candidates: listed };
              // Else the picker opens on the words, below.
            } else if (!options.picker || !anyModelMatches(this.catalog.getAvailableSnapshot(), query, this.defaultReference())) {
              throw new Error(noModelMessage(query.trim(), words.closest));
            }
          }
        }
      }
      let model = resolved && this.catalog.getModel(resolved.reference.provider, resolved.reference.id);
      let persist = Boolean(options.persist);
      if (!model && options.picker && options.query) {
        // A typed id no model matches: one error line, not a picker that only says "No matching models".
        const available = this.catalog.getAvailableSnapshot();
        if (available.length && !anyModelMatches(available, options.query, this.defaultReference())) {
          const words = matchModelWords(options.query, available, { current: this.selections.get(session)?.reference });
          throw new Error(noModelMessage(options.query.trim(), words.kind === "none" ? words.closest : []));
        }
      }
      if (!model && options.picker) {
        signal.throwIfAborted();
        const picked = await options.picker.mount(view => pickPiModel(view, this.catalog,
          this.status(session).blocked ? undefined : session.model, this.defaultReference(), options.query, signal, options.persist === false,
          this.localRefresh && (async (refreshSignal) => {
            const { problems } = await this.localRefresh!(refreshSignal);
            return [...problems.map((problem) => problem.text), ...problems.some(wantsServerTip) ? [SERVER_SIDE_TIP] : []];
          })));
        signal.throwIfAborted();
        if (!picked) return { status: this.status(session), selected: false, savedDefault: false };
        model = this.catalog.getModel(picked.provider, picked.id); persist = options.persist === false ? false : picked.persist;
      }
      // Nothing to list: a model server may still be on its way, or have missed the first look.
      if (!model && !options.picker && !this.catalog.getAvailableSnapshot().length) {
        await this.localWhen(() => !this.catalog.getAvailableSnapshot().length, { again: true, signal });
        signal.throwIfAborted();
      }
      if (!model) return { status: this.status(session), selected: false, savedDefault: false,
        models: this.catalog.getAvailableSnapshot().map(({ provider, id, name }) => ({ provider, id, name })) };
      const saved = this.recorded(session.sessionManager, model);
      const effort = resolved?.effort ?? saved?.effort ?? (this.autoDefault(model) ? "auto" : undefined);
      if (effort && effort !== "auto" && !nearestEffort(effort, getSupportedThinkingLevels(model))) throw new Error(`Unknown effort ${effort} for ${model.provider}/${model.id}.`);
      if (this.staleAuth.has(model.provider)) throw new Error("Credential state needs local refresh. Restart Casper before selecting this provider.");
      if (!this.catalog.hasConfiguredAuth(model.provider)) throw new Error(`${missingSignIn(model.provider, keylessAddress(this.agentDir, model.provider))} Model unchanged.`);
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
      return { status: this.status(session), selected: true, savedDefault: persist, ...(from ? { from } : {}) };
    } finally { this.selecting = false; this.selectionSignal = undefined; finish(); }
  }

  /** When no model is selected yet, pick one for a signed-in provider (`provider` first), else the first model of a
   * server found on this computer, and save it as the default. A server on another computer (a variable pointing
   * there) is never picked for you: /model picks it. Never replaces a model the user chose. Undefined when nothing was
   * picked. */
  async selectDefaultIfUnset(session: AgentSession, options: { provider?: string; signal?: AbortSignal } = {}): Promise<RuntimeModelSelection | undefined> {
    if (this.selections.get(session)?.reference) return undefined;
    const candidates = [...DEFAULT_MODELS].sort((a, b) => Number(b.provider === options.provider) - Number(a.provider === options.provider));
    const signedIn = () => candidates.find(({ provider, id }) => !this.staleAuth.has(provider) && this.catalog.hasConfiguredAuth(provider) && this.catalog.getModel(provider, id));
    await this.localWhen(() => !signedIn(), { here: true });
    options.signal?.throwIfAborted();
    const local = () => LOCAL_SERVERS.flatMap(({ id }) => {
      const config = this.catalog.getRegisteredProviderConfig(id);
      return config?.apiKey === "local" && onThisComputer(config.baseUrl ?? "") ? this.catalog.getModels(id) : [];
    })[0];
    const pick = signedIn() ?? local();
    if (!pick) return undefined;
    return this.select(session, { query: `${pick.provider}/${pick.id}`, persist: true, signal: options.signal });
  }

  /** A one-off request outside the transcript: the configured `review` role's model when set (so a check can
   * come from a different model than the one that did the work), else the conversation's; effort is the
   * caller's `effort` when given, else the role's suffix, else the conversation's, mapped to what the model
   * supports. `maxTokens` caps the answer. `role: "fast"` asks for the fast model instead (the conversation's
   * when none is set or it is not signed in). */
  async complete(session: AgentSession, input: { systemPrompt: string; user: string; signal?: AbortSignal; effort?: string; maxTokens?: number; role?: "fast" }): Promise<{ text: string; error?: string; usage: { tokens: number; estimatedCost: number } | null; model?: string }> {
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
    none: { tokens: number; estimatedCost: number }): Promise<{ text: string; error?: string; usage: { tokens: number; estimatedCost: number } | null; model?: string }> {
    if (!model) return { text: "", error: "no model selected", usage: none };
    const name = `${model.provider}/${model.id}`;
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
    if (response.stopReason === "error" || response.stopReason === "aborted") return { text: "", error: response.errorMessage ?? response.stopReason, usage: reported, model: name };
    return { text: response.content.filter((part) => part.type === "text").map((part) => part.text).join(""), usage: reported, model: name };
  }
}
