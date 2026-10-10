import { readFileSync } from "node:fs";
import os from "node:os";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { tildePath } from "../new/scaffold";
import { privateFileProblem } from "../platform/private-file";
import { withLoginDisplay } from "../tui/login";
import { openRouterAttribution } from "./openrouter-attribution";
import { COPILOT_POLICIES, NOT_SHARED, copilotFromGithub, copilotTokenKind, findOtherLogins, ghToken, readOtherKey, saveCredential, type OtherLogin } from "./other-logins";
import type { RuntimeAuthenticationOptions, RuntimeAuthenticationResult, RuntimeAuthProvider } from "./types";

/** The home folder now (tests and wrappers change HOME after start). */
const home = () => process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();

const providerNames: Record<RuntimeAuthProvider, string> = {
  openrouter: "OpenRouter", anthropic: "Anthropic (Claude)", "openai-codex": "OpenAI Codex (ChatGPT plan)", "github-copilot": "GitHub Copilot",
};

/** Over SSH, or on Linux with no display, a browser on this machine can't finish a sign-in: Codex uses a
 * device code there (which some accounts must turn on first), and its browser sign-in everywhere else. */
function noBrowserHere(): boolean {
  const env = process.env;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true;
  return process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** One way to sign in: a provider and its method, one numbered row. */
export interface SignInWay { id: string; provider: RuntimeAuthProvider; method: "api_key" | "oauth"; label: string }

/** Every way to sign in, provider and method together in one list, OpenRouter first (Enter picks it).
 * With a provider, only that provider's ways. */
export function signInWays(provider?: RuntimeAuthProvider): SignInWay[] {
  const ways: SignInWay[] = [
    { id: "openrouter:api_key", provider: "openrouter", method: "api_key", label: "OpenRouter · paste an API key" },
    { id: "openrouter:oauth", provider: "openrouter", method: "oauth", label: "OpenRouter · sign in with your browser" },
    { id: "anthropic:api_key", provider: "anthropic", method: "api_key", label: "Anthropic (Claude) · paste an API key" },
    { id: "anthropic:oauth", provider: "anthropic", method: "oauth", label: "Anthropic (Claude) · sign in with your browser" },
    { id: "openai-codex:oauth", provider: "openai-codex", method: "oauth",
      label: `OpenAI Codex (ChatGPT plan) · ${noBrowserHere() ? "enter a code at openai.com" : "sign in with your browser"}` },
    { id: "github-copilot:oauth", provider: "github-copilot", method: "oauth", label: "GitHub Copilot · enter a code at github.com" },
  ];
  return provider ? ways.filter((way) => way.provider === provider) : ways;
}

/** Accept only the provider's own HTTPS authorization page, with its callback on this machine. */
function validAuthorizationUrl(provider: RuntimeAuthProvider, value: string): boolean {
  if (typeof value !== "string" || value.length > 8192 || !/^[\x21-\x7e]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (provider === "anthropic") {
      return url.origin === "https://claude.ai" && url.pathname === "/oauth/authorize" &&
        url.searchParams.get("redirect_uri") === "http://localhost:53692/callback";
    }
    if (provider === "openrouter") {
      return url.origin === "https://openrouter.ai" && url.pathname === "/auth";
    }
    if (provider === "openai-codex") {
      return url.origin === "https://auth.openai.com" && url.pathname === "/oauth/authorize" &&
        url.searchParams.get("redirect_uri") === "http://localhost:1455/auth/callback";
    }
    return false;
  } catch { return false; }
}

/** Typed API keys are verified with the provider before they are stored. Verification never
 * echoes the key or provider response bodies — only a status taxonomy reaches the screen. */
const KEY_VERIFICATION_TIMEOUT_MS = 10_000;

type KeyVerification = { ok: true } | { ok: false; rejected: true; status: number } | { ok: false; rejected: false; reason: string };

async function verifyProviderKey(provider: "anthropic" | "openrouter" | "openai", key: string, signal: AbortSignal): Promise<KeyVerification> {
  const url = provider === "openrouter" ? "https://openrouter.ai/api/v1/auth/key"
    : provider === "openai" ? "https://api.openai.com/v1/models" : "https://api.anthropic.com/v1/models";
  const headers: Record<string, string> = provider === "openrouter" ? { authorization: `Bearer ${key}`, ...openRouterAttribution() }
    : provider === "openai" ? { authorization: `Bearer ${key}` }
    : { "x-api-key": key, "anthropic-version": "2023-06-01" };
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(KEY_VERIFICATION_TIMEOUT_MS)]),
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) return { ok: false, rejected: true, status: response.status };
    return { ok: false, rejected: false, reason: `provider error (HTTP ${response.status})` };
  } catch (error) {
    if (signal.aborted) throw error; // Cancellation maps to the login result, not a retry note.
    return { ok: false, rejected: false, reason: "network error" };
  }
}

/** Why a sign-in failed, in a few plain words, from what Casper already knows. Never provider text: errors can
 * hold tokens. Undefined when the cause isn't clear. */
function failureDetail(error: unknown, timedOut: boolean, name: string): string | undefined {
  const message = error instanceof Error ? error.message : "";
  if (/(?:status[= ]|\()(?:400|401|403)\b/.test(message)) return `${name} refused the sign-in`;
  if (timedOut) return "timed out after 15 minutes";
  if (error instanceof TypeError || /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Unable to connect|network/i.test(message)) return `couldn't reach ${name}`;
  return undefined;
}

/** Key variables that already sign a provider in, so a found sign-in for it is not offered. */
const SIGNED_IN_BY_ENV: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"], openai: ["OPENAI_API_KEY"], "github-copilot": ["COPILOT_GITHUB_TOKEN"],
};

/** Providers with a sign-in already: named in Casper's login file or set by a key variable. Only the names are kept,
 * and nothing is created: a missing login file stays missing. */
function signedInHere(destination: string): Set<string> {
  const names = new Set<string>();
  for (const [provider, variables] of Object.entries(SIGNED_IN_BY_ENV)) if (variables.some((name) => process.env[name])) names.add(provider);
  try {
    const saved: unknown = JSON.parse(readFileSync(destination, "utf8").replace(/^\uFEFF/, ""));
    if (saved && typeof saved === "object") for (const name of Object.keys(saved)) names.add(name);
  } catch { /* none yet, or unreadable: nothing counts as signed in */ }
  return names;
}

/** Save a sign-in another tool left here, after you picked it: an API key verified with its provider, or GitHub CLI's
 * token exchanged for Copilot. Never the other tool's refresh token. Failures are plain words, never provider text. */
async function useOtherLogin(login: OtherLogin, destination: string, signal: AbortSignal): Promise<RuntimeAuthenticationResult> {
  const failed = (detail: string): RuntimeAuthenticationResult => ({ status: "failed", effect: "none", reason: "provider", detail });
  let credential: Record<string, unknown>;
  if (login.use === "api_key") {
    const key = readOtherKey(login);
    // Stored Pi keys are configuration expressions; accept only literal keys.
    if (!key || key.startsWith("!") || key.includes("$")) return failed(`${login.tool}'s key isn't there any more`);
    const verification = await verifyProviderKey(login.provider as "anthropic" | "openai", key, signal);
    if (!verification.ok) return failed(verification.rejected ? `${login.provider === "openai" ? "OpenAI" : "Anthropic"} refused ${login.tool}'s key (HTTP ${verification.status})`
      : `couldn't check ${login.tool}'s key (${verification.reason})`);
    credential = { type: "api_key", key };
  } else {
    const token = await ghToken(signal);
    if (!token) return failed("GitHub CLI gave no sign-in (gh auth token); run gh auth login, or pick Sign in separately");
    const kind = copilotTokenKind(token);
    if (kind !== "ok") return failed(kind === "classic" ? "GitHub CLI is signed in with a classic token, which Copilot doesn't take; pick Sign in separately"
      : "GitHub CLI's sign-in isn't a kind Copilot takes; pick Sign in separately");
    const exchanged = await copilotFromGithub(token, signal);
    if (!exchanged.ok) return failed(exchanged.detail);
    credential = exchanged.credential;
  }
  const problem = await privateFileProblem(destination, signal);
  if (problem) return { status: "failed", effect: "none", reason: "destination", detail: problem };
  try { await saveCredential(destination, login.provider, credential, signal); }
  catch (error) {
    if (signal.aborted) return { status: "cancelled", effect: "unknown" };
    return { status: "failed", effect: "unknown", reason: "destination", detail: error instanceof Error && /^(another Casper|the login file)/.test(error.message) ? error.message : "Casper couldn't write the login file" };
  }
  return { status: "saved" };
}

/** Dedicated builtin-only runtime: no sessions, extensions, model config or network catalog refresh. */
export async function authenticatePi(options: RuntimeAuthenticationOptions, destination: string,
  lifetime: AbortSignal): Promise<RuntimeAuthenticationResult & { provider?: string }> {
  const signal = AbortSignal.any([lifetime, ...(options.signal ? [options.signal] : [])]);
  if (signal.aborted) return { status: "cancelled", effect: "none" };
  if (options.provider !== undefined && !Object.hasOwn(providerNames, options.provider)) return { status: "failed", effect: "none", reason: "unavailable" };
  // The terminal log would record what is typed and shown, codes included.
  if (process.env.CASPER_TUI_WRITE_LOG || process.env.PI_TUI_WRITE_LOG) return { status: "failed", effect: "none", reason: "unavailable", detail: "CASPER_TUI_WRITE_LOG is set" };
  let invoked = false;
  let provider = options.provider;
  /** The provider a found sign-in was saved for (it may be one /login has no row for, such as openai). */
  let imported: string | undefined;
  try {
    // Refuse an unusable destination before the picker, naming the component to fix.
    const early = await privateFileProblem(destination, signal);
    if (early) return { status: "failed", effect: "none", reason: "destination", detail: early };
    return await options.terminalHost.run((io) => withLoginDisplay(io, signal, async (display): Promise<RuntimeAuthenticationResult> => {
      const saved = `Saved in ${tildePath(destination, home())}, only on this computer.`;
      display.setNote(saved);
      // Sign-ins other tools left here come first: 1 use one, then Sign in separately, then Not now.
      const found = options.others === false ? []
        : findOtherLogins(signedInHere(destination)).filter((login) => !provider || login.provider === provider);
      let pickedId: string | undefined;
      if (found.length) {
        const notes = [...found.some((login) => login.use === "own") ? [NOT_SHARED] : [], ...found.some((login) => login.use === "github") ? [COPILOT_POLICIES] : []];
        if (notes.length) display.setNote([saved, ...notes].join("\n"));
        const answer = await display.choose(found.length === 1 ? `Found a ${found[0]!.tool} sign-in on this computer` : "Found sign-ins on this computer",
          [...found.map(({ id, label }) => ({ id, label })), { id: "separately", label: "Sign in separately" }, { id: "later", label: "Not now" }]);
        const login = found.find((item) => item.id === answer);
        if (!answer || answer === "later" || display.signal.aborted) return { status: "cancelled", effect: "none" };
        if (login?.use === "own") pickedId = `${login.provider}:oauth`;
        else if (login) {
          imported = login.provider;
          return useOtherLogin(login, destination, display.signal);
        }
      }
      // One numbered list (provider and method together); /login <provider> with one way skips it.
      const ways = signInWays(provider);
      pickedId ??= ways.length === 1 && !options.list ? ways[0]!.id
        : await display.choose(provider ? `Sign in to ${providerNames[provider]}` : "Sign in", ways);
      const way = ways.find((item) => item.id === pickedId);
      if (!way) return { status: "cancelled", effect: "none" };
      provider = way.provider;
      const selected = way.provider;
      const method = way.method;
      // Browser sign-in (loopback listener + authorization page) vs device-code oauth.
      const browser = method === "oauth" && (selected === "anthropic" || selected === "openrouter" || (selected === "openai-codex" && !noBrowserHere()));
      // Picking the way is the consent (as in Claude Code and Codex); the next screen still says what it costs.
      const disclosure = selected === "github-copilot" ? "Signing in may turn on model policies on your GitHub account."
        : selected === "anthropic" ? "API use is billed per token; a Claude plan sign-in is billed per token as extra usage."
        : selected === "openrouter" ? "Usage is billed from your OpenRouter credits."
        : "";
      display.setNote([saved, disclosure].filter(Boolean).join("\n"));
      if (display.signal.aborted) return { status: "cancelled", effect: "none" };
      // The SDK reads this override when its lazy OAuth module loads. Never allow a public listener.
      if (browser && [process.env.CASPER_OAUTH_CALLBACK_HOST, process.env.PI_OAUTH_CALLBACK_HOST]
        .some(host => host && host !== "127.0.0.1")) {
        return { status: "failed", effect: "none", reason: "unavailable" };
      }
      // Re-check after the pick: the preflight above is not atomic.
      try {
        const problem = await privateFileProblem(destination, display.signal);
        if (problem) return { status: "failed", effect: "none", reason: "destination", detail: problem };
      } catch { return display.signal.aborted ? { status: "cancelled", effect: "none" } : { status: "failed", effect: "none", reason: "destination" }; }
      const deadline = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, 15 * 60_000);
      const flow = AbortSignal.any([display.signal, deadline.signal]);
      let active = true;
      let promptHandled = false;
      let codexAsked = false;
      let methodAsked = false;
      let authorizationShown = false;
      let verificationCancelled = false;
      try {
        flow.throwIfAborted();
        const runtime = await ModelRuntime.create({ authPath: destination, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal: flow });
        flow.throwIfAborted();
        invoked = true;
        await runtime.login(selected, method, {
          signal: flow,
          prompt: async (prompt) => {
            flow.throwIfAborted(); prompt.signal?.throwIfAborted();
            // Codex asks browser or device code first; the browser path then asks for the pasted code.
            if (active && !codexAsked && selected === "openai-codex" && prompt.type === "select" && prompt.message === "Select OpenAI Codex login method:" &&
              prompt.options.length === 2 && prompt.options[0]?.id === "browser" && prompt.options[1]?.id === "device_code") {
              codexAsked = true;
              if (browser) return "browser";
              promptHandled = true;
              return "device_code";
            }
            // Anthropic asks browser or copy-code first; Casper's browser path also takes a pasted code or redirect URL.
            if (active && !methodAsked && browser && selected === "anthropic" && prompt.type === "select" && prompt.message === "Select Anthropic login method:" &&
              prompt.options.some((option) => option.id === "browser")) {
              methodAsked = true;
              return "browser";
            }
            if (!active || promptHandled) throw new Error("unsupported interaction");
            promptHandled = true;
            if (method === "api_key" && prompt.type === "secret") {
              flow.throwIfAborted();
              let note = "";
              for (;;) {
                const key = await display.privateInput(note === ""
                  ? "Private API key (never enter keys in chat)"
                  : `Private API key — ${note} Paste again, or Esc to cancel.`, flow);
                // Stored Pi keys are configuration expressions; accept only literal keys here.
                if (key.startsWith("!") || key.includes("$") || !/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error("invalid key");
                flow.throwIfAborted();
                const verification = await verifyProviderKey(selected as "anthropic" | "openrouter", key, flow);
                if (verification.ok) return key;
                if (verification.rejected) { note = `rejected by ${provider} (HTTP ${verification.status}).`; continue; }
                const choice = await display.choose(`Key could not be verified (${verification.reason}).`, [
                  { id: "retry", label: "Paste the key again" },
                  { id: "save", label: "Save without verification" },
                  { id: "cancel", label: "Cancel sign-in" },
                ] as const);
                if (choice === "save") return key;
                if (choice !== "retry") { verificationCancelled = true; deadline.abort(); throw new Error("verification cancelled"); }
              }
            }
            if (selected === "github-copilot" && prompt.type === "text" && prompt.message === "GitHub Enterprise URL/domain (blank for github.com)") return "";
            if (browser && authorizationShown && prompt.type === "manual_code") {
              return display.privateInput("Private authorization code / redirect URL (or finish in your browser)",
                AbortSignal.any([flow, ...(prompt.signal ? [prompt.signal] : [])]));
            }
            throw new Error("unsupported interaction");
          },
          notify: (event) => {
            if (!active || flow.aborted) return;
            if (event.type === "progress" || event.type === "info") return; // No raw provider text or links.
            if (browser && !authorizationShown && event.type === "auth_url" && validAuthorizationUrl(selected, event.url)) {
              authorizationShown = true; display.browser(event.url); return;
            }
            const verification = selected === "openai-codex" ? "https://auth.openai.com/codex/device" : "https://github.com/login/device";
            if (browser || method !== "oauth" || !promptHandled || authorizationShown || event.type !== "device_code" ||
              event.verificationUri !== verification || typeof event.userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(event.userCode)) {
              deadline.abort(); throw new Error("unsupported authorization display");
            }
            authorizationShown = true; display.device(event.verificationUri, event.userCode);
          },
        });
        return { status: "saved" };
      } catch (error) {
        if (error instanceof CredentialSynchronizationError) return { status: "saved-needs-refresh" };
        if (verificationCancelled) return { status: "cancelled", effect: invoked ? "unknown" : "none" };
        if (display.signal.aborted) return { status: "cancelled", effect: invoked ? "unknown" : "none" };
        const detail = failureDetail(error, timedOut, providerNames[selected]);
        return { status: "failed", effect: invoked ? "unknown" : "none", reason: "provider", ...(detail ? { detail } : {}) };
      } finally { active = false; clearTimeout(timer); deadline.abort(); }
    })).then(result => ({ ...result, provider: imported ?? provider }));
  } catch {
    // Never expose SDK error objects: synchronization errors contain the credential itself.
    return signal.aborted ? { status: "cancelled", effect: invoked ? "unknown" : "none", provider: imported ?? provider }
      : { status: "failed", effect: invoked ? "unknown" : "none", reason: "unavailable", provider: imported ?? provider };
  }
}
